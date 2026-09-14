import type { IncomingMessage, ServerResponse } from "node:http";

import type { SqliteDatabase } from "@zet-harness/db";
import {
  DurableGoalError,
  createGoal,
  createTodo,
  listGoals,
  listTodos,
  readGoal,
  readTodo,
  setGoalStatus,
  setTodoStatus,
  updateGoal,
  updateTodo,
  type DurableGoalErrorCode,
  type DurableGoalRecord,
  type DurableGoalStatus,
  type DurableTodoRecord,
  type DurableTodoStatus,
  type GoalListStatus,
} from "@zet-harness/db/durable-goal-records";
import { readProject } from "@zet-harness/db/durable-project-records";
import { SORTABLE_ID_PATTERN, createSortableId } from "@zet-harness/db/sortable-id";

import { RuntimeApiSecurityError, type RuntimeApiSecurity } from "./runtime-api-security.js";
import { writeRuntimeJson } from "./runtime-approval-http.js";

/** Services the goal and todo endpoints need; supplied by the daemon. */
export interface RuntimeGoalHttpServices {
  readonly database: SqliteDatabase;
  /** UTC epoch milliseconds. Defaults to the system clock. */
  readonly now?: () => number;
  /** Defaults to a sortable UUIDv7. */
  readonly createId?: () => string;
}

const MAX_GOAL_BODY_BYTES = 65_536;

const PROJECT_GOALS_PATH = /^\/api\/projects\/([^/]+)\/goals$/u;
const GOAL_PATH = /^\/api\/goals\/([^/]+)(?:\/(status|todos))?$/u;
const TODO_PATH = /^\/api\/todos\/([^/]+)(?:\/(status))?$/u;

class RuntimeGoalRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly field: string | undefined;

  constructor(code: string, message: string, statusCode: number, field?: string) {
    super(message);
    this.name = "RuntimeGoalRequestError";
    this.code = code;
    this.statusCode = statusCode;
    this.field = field;
  }
}

function invalidRequest(message: string, field?: string): RuntimeGoalRequestError {
  return new RuntimeGoalRequestError("GOAL_INVALID", message, 400, field);
}

const projectNotFound = (): RuntimeGoalRequestError =>
  new RuntimeGoalRequestError("PROJECT_NOT_FOUND", "No project exists with this id.", 404);
const goalNotFound = (): RuntimeGoalRequestError =>
  new RuntimeGoalRequestError("GOAL_NOT_FOUND", "No goal exists with this id.", 404);
const todoNotFound = (): RuntimeGoalRequestError =>
  new RuntimeGoalRequestError("TODO_NOT_FOUND", "No todo exists with this id.", 404);

const STATUS_FOR: Readonly<Record<DurableGoalErrorCode, number>> = {
  GOAL_INVALID: 400,
  TODO_DEPENDENCY_CYCLE: 400,
  GOAL_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  PROJECT_ARCHIVED: 409,
  GOAL_CLOSED: 409,
  TODO_CLOSED: 409,
  GOAL_TRANSITION_INVALID: 409,
  TODO_TRANSITION_INVALID: 409,
  GOAL_HAS_OPEN_TODOS: 409,
  TODO_DEPENDENCIES_UNFINISHED: 409,
  TODO_HAS_STARTED_DEPENDENTS: 409,
};

/**
 * Goal and todo paths this handler owns. The server checks them before project
 * paths, because `/api/projects/:id/goals` belongs here.
 */
export function isGoalHttpPath(pathname: string): boolean {
  return (
    PROJECT_GOALS_PATH.test(pathname) ||
    pathname === "/api/goals" ||
    pathname.startsWith("/api/goals/") ||
    pathname === "/api/todos" ||
    pathname.startsWith("/api/todos/")
  );
}

function methodNotAllowed(response: ServerResponse, allowed: readonly string[]): void {
  response.setHeader("allow", allowed.join(", "));
  writeRuntimeJson(response, 405, { error: "method_not_allowed", allowed });
}

/** A JSON object, or an empty object when the request has no body. */
async function readGoalBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    size += buffer.length;
    if (size > MAX_GOAL_BODY_BYTES) {
      request.resume();
      throw new RuntimeApiSecurityError("LOCAL_API_BODY_TOO_LARGE", "Request exceeds 64 KiB.", 413);
    }
    parts.push(buffer);
  }
  if (size === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } catch {
    throw invalidRequest("Request body is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function onlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const field of Object.keys(body)) {
    if (!allowed.includes(field)) throw invalidRequest(`Unknown field '${field}'.`, field);
  }
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidRequest(`${field} must be a string.`, field);
  return value;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = optionalString(body, field);
  if (value === undefined) throw invalidRequest(`${field} is required.`, field);
  return value;
}

function optionalInteger(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidRequest(`${field} must be an integer.`, field);
  }
  return value;
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function optionalIdList(
  body: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!isStringList(value)) throw invalidRequest(`${field} must be a list of ids.`, field);
  return value;
}

function goalListStatus(url: URL): GoalListStatus {
  const status = url.searchParams.get("status") ?? "all";
  if (
    status === "open" ||
    status === "blocked" ||
    status === "completed" ||
    status === "cancelled" ||
    status === "all"
  ) {
    return status;
  }
  throw invalidRequest("status must be open, blocked, completed, cancelled or all.", "status");
}

function idFrom(segment: string, missing: () => RuntimeGoalRequestError): string {
  let id: string;
  try {
    id = decodeURIComponent(segment);
  } catch {
    throw missing();
  }
  if (!SORTABLE_ID_PATTERN.test(id)) throw missing();
  return id;
}

interface TextFields {
  readonly title?: string;
  readonly description?: string;
  readonly priority?: number;
}

function textFields(body: Record<string, unknown>): TextFields {
  const title = optionalString(body, "title");
  const description = optionalString(body, "description");
  const priority = optionalInteger(body, "priority");
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(priority === undefined ? {} : { priority }),
  };
}

function statusChange<Status extends string>(
  body: Record<string, unknown>,
): { readonly status: Status; readonly reason?: string } {
  onlyFields(body, ["status", "reason"]);
  const status = requiredString(body, "status") as Status;
  const reason = optionalString(body, "reason");
  return { status, ...(reason === undefined ? {} : { reason }) };
}

/**
 * Goal and todo endpoints.
 *
 *   GET  /api/projects/:projectId/goals?status=open|blocked|completed|cancelled|all
 *   POST /api/projects/:projectId/goals   { title, description?, priority?, conversationId? }
 *   GET  /api/goals/:id                    the goal and its todos in order
 *   POST /api/goals/:id                    { title?, description?, priority? }
 *   POST /api/goals/:id/status             { status, reason? }
 *   POST /api/goals/:id/todos              { title, description?, priority?, dependsOn? }
 *   GET  /api/todos/:id
 *   POST /api/todos/:id                    { title?, description?, priority?, position?, dependsOn? }
 *   POST /api/todos/:id/status             { status, reason? }
 *
 * Status changes follow the transition tables in `durable-goal-records`. Every POST
 * passes the shared CSRF check, and every write is one serialized SQLite commit.
 */
export async function handleGoalHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  security: RuntimeApiSecurity,
  services: RuntimeGoalHttpServices,
): Promise<void> {
  const now = services.now ?? (() => Date.now());
  const createId = services.createId ?? createSortableId;
  const database = services.database;
  try {
    const projectMatch = PROJECT_GOALS_PATH.exec(url.pathname);
    if (projectMatch !== null) {
      const projectId = idFrom(projectMatch[1] ?? "", projectNotFound);
      if (request.method === "GET") {
        if (readProject(database.connection(), projectId) === undefined) throw projectNotFound();
        writeRuntimeJson(response, 200, {
          goals: listGoals(database.connection(), projectId, { status: goalListStatus(url) }),
        });
        return;
      }
      if (request.method !== "POST") return methodNotAllowed(response, ["GET", "POST"]);
      security.checkMutation(request);
      const body = await readGoalBody(request);
      onlyFields(body, ["title", "description", "priority", "conversationId"]);
      const title = requiredString(body, "title");
      const fields = textFields(body);
      const conversationId = optionalString(body, "conversationId");
      const goal = await database.commit((connection) =>
        createGoal(connection, {
          ...fields,
          goalId: createId(),
          projectId,
          title,
          ...(conversationId === undefined ? {} : { conversationId }),
          nowMs: now(),
        }),
      );
      writeRuntimeJson(response, 201, { goal });
      return;
    }

    const goalMatch = GOAL_PATH.exec(url.pathname);
    if (goalMatch !== null) {
      const goalId = idFrom(goalMatch[1] ?? "", goalNotFound);
      const action = goalMatch[2];
      if (action === undefined && request.method === "GET") {
        const goal = readGoal(database.connection(), goalId);
        if (goal === undefined) throw goalNotFound();
        writeRuntimeJson(response, 200, { goal, todos: listTodos(database.connection(), goalId) });
        return;
      }
      if (request.method !== "POST") {
        return methodNotAllowed(response, action === undefined ? ["GET", "POST"] : ["POST"]);
      }
      security.checkMutation(request);
      const body = await readGoalBody(request);

      if (action === "todos") {
        onlyFields(body, ["title", "description", "priority", "dependsOn"]);
        const title = requiredString(body, "title");
        const fields = textFields(body);
        const dependsOn = optionalIdList(body, "dependsOn");
        const todo = await database.commit((connection) =>
          createTodo(connection, {
            ...fields,
            todoId: createId(),
            goalId,
            title,
            ...(dependsOn === undefined ? {} : { dependsOn }),
            nowMs: now(),
          }),
        );
        writeRuntimeJson(response, 201, { todo });
        return;
      }

      let goal: DurableGoalRecord | undefined;
      if (action === "status") {
        const change = statusChange<DurableGoalStatus>(body);
        goal = await database.commit((connection) =>
          setGoalStatus(connection, goalId, { ...change, nowMs: now() }),
        );
      } else {
        onlyFields(body, ["title", "description", "priority"]);
        const fields = textFields(body);
        goal = await database.commit((connection) =>
          updateGoal(connection, goalId, { ...fields, nowMs: now() }),
        );
      }
      if (goal === undefined) throw goalNotFound();
      writeRuntimeJson(response, 200, { goal });
      return;
    }

    const todoMatch = TODO_PATH.exec(url.pathname);
    if (todoMatch === null) {
      writeRuntimeJson(response, 404, { error: "not_found" });
      return;
    }
    const todoId = idFrom(todoMatch[1] ?? "", todoNotFound);
    const action = todoMatch[2];
    if (action === undefined && request.method === "GET") {
      const todo = readTodo(database.connection(), todoId);
      if (todo === undefined) throw todoNotFound();
      writeRuntimeJson(response, 200, { todo });
      return;
    }
    if (request.method !== "POST") {
      return methodNotAllowed(response, action === undefined ? ["GET", "POST"] : ["POST"]);
    }
    security.checkMutation(request);
    const body = await readGoalBody(request);

    let todo: DurableTodoRecord | undefined;
    if (action === "status") {
      const change = statusChange<DurableTodoStatus>(body);
      todo = await database.commit((connection) =>
        setTodoStatus(connection, todoId, { ...change, nowMs: now() }),
      );
    } else {
      onlyFields(body, ["title", "description", "priority", "position", "dependsOn"]);
      const fields = textFields(body);
      const position = optionalInteger(body, "position");
      const dependsOn = optionalIdList(body, "dependsOn");
      todo = await database.commit((connection) =>
        updateTodo(connection, todoId, {
          ...fields,
          ...(position === undefined ? {} : { position }),
          ...(dependsOn === undefined ? {} : { dependsOn }),
          nowMs: now(),
        }),
      );
    }
    if (todo === undefined) throw todoNotFound();
    writeRuntimeJson(response, 200, { todo });
  } catch (error: unknown) {
    if (error instanceof RuntimeGoalRequestError || error instanceof DurableGoalError) {
      const statusCode =
        error instanceof RuntimeGoalRequestError ? error.statusCode : STATUS_FOR[error.code];
      writeRuntimeJson(response, statusCode, {
        error: {
          code: error.code,
          reason: error.message,
          ...(error.field === undefined ? {} : { field: error.field }),
        },
      });
      return;
    }
    throw error;
  }
}
