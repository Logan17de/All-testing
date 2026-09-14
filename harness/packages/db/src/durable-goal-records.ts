import { CONVERSATIONS_TABLE } from "./durable-conversation-records.js";
import { PROJECTS_TABLE } from "./durable-project-records.js";
import type { SqliteMigration } from "./migrations.js";
import { SORTABLE_ID_PATTERN } from "./sortable-id.js";

export const GOALS_TABLE = "goals" as const;
export const TODOS_TABLE = "todos" as const;
export const TODO_DEPENDENCIES_TABLE = "todo_dependencies" as const;
export const GOAL_TITLE_MAX_LENGTH = 200;
export const GOAL_DESCRIPTION_MAX_LENGTH = 4_000;
export const BLOCKED_REASON_MAX_LENGTH = 1_000;
/** Priorities run from 0 (most urgent) to this bound. */
export const PRIORITY_MAX = 1_000;
export const DEFAULT_PRIORITY = 100;
export const TODO_MAX_DEPENDENCIES = 100;
const LIST_LIMIT = 1_000;

export const GOAL_STATUSES = ["open", "blocked", "completed", "cancelled"] as const;
export type DurableGoalStatus = (typeof GOAL_STATUSES)[number];
export type GoalListStatus = DurableGoalStatus | "all";

export const TODO_STATUSES = ["pending", "in_progress", "blocked", "done", "cancelled"] as const;
export type DurableTodoStatus = (typeof TODO_STATUSES)[number];

/** Every allowed goal status change. Blocked goals are unblocked before they complete. */
export const GOAL_STATUS_TRANSITIONS: Readonly<
  Record<DurableGoalStatus, readonly DurableGoalStatus[]>
> = Object.freeze({
  open: ["blocked", "completed", "cancelled"],
  blocked: ["open", "cancelled"],
  completed: ["open"],
  cancelled: ["open"],
});

/** Every allowed todo status change. Blocked todos are unblocked before they finish. */
export const TODO_STATUS_TRANSITIONS: Readonly<
  Record<DurableTodoStatus, readonly DurableTodoStatus[]>
> = Object.freeze({
  pending: ["in_progress", "blocked", "done", "cancelled"],
  in_progress: ["pending", "blocked", "done", "cancelled"],
  blocked: ["pending", "in_progress", "cancelled"],
  done: ["pending"],
  cancelled: ["pending"],
});

const CLOSED_GOAL_STATUSES: ReadonlySet<string> = new Set(["completed", "cancelled"]);
const FINISHED_TODO_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled"]);

export interface DurableGoalRecord {
  /** Sortable UUIDv7. */
  readonly goalId: string;
  readonly projectId: string;
  /** The conversation the goal came from, when it came from one. */
  readonly conversationId: string | null;
  readonly title: string;
  readonly description: string;
  readonly status: DurableGoalStatus;
  /** Set exactly while the goal is blocked. */
  readonly blockedReason: string | null;
  /** 0 is most urgent. */
  readonly priority: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** Set exactly while the goal is completed or cancelled. */
  readonly closedAtMs: number | null;
}

export interface DurableTodoRecord {
  /** Sortable UUIDv7. */
  readonly todoId: string;
  readonly goalId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly status: DurableTodoStatus;
  readonly blockedReason: string | null;
  /** 0 is most urgent. */
  readonly priority: number;
  /** Order within the goal among todos of equal priority. */
  readonly position: number;
  /** Todos of the same goal that must be done first, sorted by id. */
  readonly dependsOn: readonly string[];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** When the todo first went in progress. */
  readonly startedAtMs: number | null;
  /** Set exactly while the todo is done or cancelled. */
  readonly finishedAtMs: number | null;
}

/** Append new migrations; never edit the already-shipped v1-v9 schemas. */
export const DURABLE_GOALS_MIGRATION: SqliteMigration = Object.freeze({
  version: 10,
  name: "durable_goals_and_todos",
  sql: `
CREATE TABLE ${GOALS_TABLE} (
  goal_id TEXT PRIMARY KEY CHECK (length(goal_id) = 36),
  project_id TEXT NOT NULL,
  conversation_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND ${String(GOAL_TITLE_MAX_LENGTH)}),
  description TEXT NOT NULL CHECK (length(description) <= ${String(GOAL_DESCRIPTION_MAX_LENGTH)}),
  status TEXT NOT NULL CHECK (status IN ('open', 'blocked', 'completed', 'cancelled')),
  blocked_reason TEXT CHECK (
    blocked_reason IS NULL OR length(blocked_reason) BETWEEN 1 AND ${String(BLOCKED_REASON_MAX_LENGTH)}
  ),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND ${String(PRIORITY_MAX)}),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  closed_at_ms INTEGER CHECK (closed_at_ms IS NULL OR closed_at_ms >= created_at_ms),
  CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL)),
  CHECK ((status IN ('completed', 'cancelled')) = (closed_at_ms IS NOT NULL)),
  UNIQUE (goal_id, project_id),
  FOREIGN KEY (project_id) REFERENCES ${PROJECTS_TABLE}(project_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (conversation_id) REFERENCES ${CONVERSATIONS_TABLE}(conversation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX goals_project_status_priority_idx
ON ${GOALS_TABLE}(project_id, status, priority, goal_id);

CREATE TRIGGER goals_cannot_be_deleted
BEFORE DELETE ON ${GOALS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'goals are closed, never deleted');
END;

CREATE TRIGGER goals_keep_their_identity
BEFORE UPDATE OF goal_id, project_id, conversation_id, created_at_ms ON ${GOALS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'a goal keeps its id, project, conversation and creation time');
END;

CREATE TABLE ${TODOS_TABLE} (
  todo_id TEXT PRIMARY KEY CHECK (length(todo_id) = 36),
  goal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND ${String(GOAL_TITLE_MAX_LENGTH)}),
  description TEXT NOT NULL CHECK (length(description) <= ${String(GOAL_DESCRIPTION_MAX_LENGTH)}),
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'blocked', 'done', 'cancelled')),
  blocked_reason TEXT CHECK (
    blocked_reason IS NULL OR length(blocked_reason) BETWEEN 1 AND ${String(BLOCKED_REASON_MAX_LENGTH)}
  ),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND ${String(PRIORITY_MAX)}),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  started_at_ms INTEGER CHECK (started_at_ms IS NULL OR started_at_ms >= created_at_ms),
  finished_at_ms INTEGER CHECK (finished_at_ms IS NULL OR finished_at_ms >= created_at_ms),
  CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL)),
  CHECK ((status IN ('done', 'cancelled')) = (finished_at_ms IS NOT NULL)),
  UNIQUE (todo_id, goal_id),
  FOREIGN KEY (goal_id, project_id) REFERENCES ${GOALS_TABLE}(goal_id, project_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX todos_goal_order_idx ON ${TODOS_TABLE}(goal_id, priority, position, todo_id);

CREATE TRIGGER todos_cannot_be_deleted
BEFORE DELETE ON ${TODOS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'todos are closed, never deleted');
END;

CREATE TRIGGER todos_keep_their_identity
BEFORE UPDATE OF todo_id, goal_id, project_id, created_at_ms ON ${TODOS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'a todo keeps its id, goal, project and creation time');
END;

CREATE TABLE ${TODO_DEPENDENCIES_TABLE} (
  todo_id TEXT NOT NULL,
  depends_on_todo_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  PRIMARY KEY (todo_id, depends_on_todo_id),
  CHECK (todo_id <> depends_on_todo_id),
  FOREIGN KEY (todo_id, goal_id) REFERENCES ${TODOS_TABLE}(todo_id, goal_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (depends_on_todo_id, goal_id) REFERENCES ${TODOS_TABLE}(todo_id, goal_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX todo_dependencies_dependency_idx
ON ${TODO_DEPENDENCIES_TABLE}(depends_on_todo_id, todo_id);
`,
});

export type DurableGoalErrorCode =
  | "GOAL_INVALID"
  | "GOAL_NOT_FOUND"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ARCHIVED"
  | "GOAL_CLOSED"
  | "TODO_CLOSED"
  | "GOAL_TRANSITION_INVALID"
  | "TODO_TRANSITION_INVALID"
  | "GOAL_HAS_OPEN_TODOS"
  | "TODO_DEPENDENCIES_UNFINISHED"
  | "TODO_HAS_STARTED_DEPENDENTS"
  | "TODO_DEPENDENCY_CYCLE";

/** A goal or todo write the harness refuses before it reaches SQLite. */
export class DurableGoalError extends Error {
  readonly code: DurableGoalErrorCode;
  /** The input field at fault, when there is one. */
  readonly field: string | undefined;

  constructor(code: DurableGoalErrorCode, message: string, field?: string) {
    super(message);
    this.name = "DurableGoalError";
    this.code = code;
    this.field = field;
  }
}

/** Minimal statement surface, so this module does not depend on a driver type. */
export interface GoalStatementRunner {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): unknown;
    get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
    all(...parameters: readonly unknown[]): Record<string, unknown>[];
  };
}

export interface CreateGoalInput {
  readonly goalId: string;
  readonly projectId: string;
  readonly conversationId?: string | null;
  readonly title: string;
  readonly description?: string;
  readonly priority?: number;
  readonly nowMs: number;
}

export interface UpdateGoalInput {
  readonly title?: string;
  readonly description?: string;
  readonly priority?: number;
  readonly nowMs: number;
}

export interface StatusChangeInput<Status extends string> {
  readonly status: Status;
  /** Required when blocking; refused otherwise. */
  readonly reason?: string;
  readonly nowMs: number;
}

export interface ListGoalsOptions {
  /** Defaults to every status. */
  readonly status?: GoalListStatus;
  /** Defaults to and is capped at 1000. */
  readonly limit?: number;
}

export interface CreateTodoInput {
  readonly todoId: string;
  readonly goalId: string;
  readonly title: string;
  readonly description?: string;
  readonly priority?: number;
  readonly dependsOn?: readonly string[];
  readonly nowMs: number;
}

export interface UpdateTodoInput {
  readonly title?: string;
  readonly description?: string;
  readonly priority?: number;
  readonly position?: number;
  /** Replaces the todo's dependencies. */
  readonly dependsOn?: readonly string[];
  readonly nowMs: number;
}

function fail(code: DurableGoalErrorCode, message: string, field?: string): never {
  throw new DurableGoalError(code, message, field);
}

function invalid(field: string, message: string): never {
  return fail("GOAL_INVALID", message, field);
}

function checkTime(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    invalid("nowMs", "Goal and todo times are UTC epoch milliseconds.");
  }
  return nowMs;
}

function checkId(field: string, id: string): string {
  if (!SORTABLE_ID_PATTERN.test(id)) invalid(field, `${field} must be a sortable UUIDv7.`);
  return id;
}

function checkTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) invalid("title", "A title is required.");
  if (trimmed.length > GOAL_TITLE_MAX_LENGTH) {
    invalid("title", `A title is at most ${String(GOAL_TITLE_MAX_LENGTH)} characters.`);
  }
  return trimmed;
}

function checkDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length > GOAL_DESCRIPTION_MAX_LENGTH) {
    invalid(
      "description",
      `A description is at most ${String(GOAL_DESCRIPTION_MAX_LENGTH)} characters.`,
    );
  }
  return trimmed;
}

function checkPriority(priority: number | undefined): number {
  if (priority === undefined) return DEFAULT_PRIORITY;
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > PRIORITY_MAX) {
    invalid("priority", `priority is an integer from 0 (most urgent) to ${String(PRIORITY_MAX)}.`);
  }
  return priority;
}

function checkPosition(position: number): number {
  if (!Number.isSafeInteger(position) || position < 0) {
    invalid("position", "position is a non-negative integer.");
  }
  return position;
}

function checkReason(reason: string | undefined): string {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length === 0) invalid("reason", "Say why this is blocked.");
  if (trimmed.length > BLOCKED_REASON_MAX_LENGTH) {
    invalid(
      "reason",
      `A blocked reason is at most ${String(BLOCKED_REASON_MAX_LENGTH)} characters.`,
    );
  }
  return trimmed;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toGoal(row: Record<string, unknown>): DurableGoalRecord {
  return Object.freeze({
    goalId: text(row["goal_id"]),
    projectId: text(row["project_id"]),
    conversationId: optionalText(row["conversation_id"]),
    title: text(row["title"]),
    description: text(row["description"]),
    status: text(row["status"]) as DurableGoalStatus,
    blockedReason: optionalText(row["blocked_reason"]),
    priority: integer(row["priority"]),
    createdAtMs: integer(row["created_at_ms"]),
    updatedAtMs: integer(row["updated_at_ms"]),
    closedAtMs: optionalInteger(row["closed_at_ms"]),
  });
}

function toTodo(row: Record<string, unknown>, dependsOn: readonly string[]): DurableTodoRecord {
  return Object.freeze({
    todoId: text(row["todo_id"]),
    goalId: text(row["goal_id"]),
    projectId: text(row["project_id"]),
    title: text(row["title"]),
    description: text(row["description"]),
    status: text(row["status"]) as DurableTodoStatus,
    blockedReason: optionalText(row["blocked_reason"]),
    priority: integer(row["priority"]),
    position: integer(row["position"]),
    dependsOn: Object.freeze([...dependsOn]),
    createdAtMs: integer(row["created_at_ms"]),
    updatedAtMs: integer(row["updated_at_ms"]),
    startedAtMs: optionalInteger(row["started_at_ms"]),
    finishedAtMs: optionalInteger(row["finished_at_ms"]),
  });
}

/** Goals and todos only change inside an active project. */
function requireActiveProject(connection: GoalStatementRunner, projectId: string): void {
  const project = connection
    .prepare(`SELECT status FROM ${PROJECTS_TABLE} WHERE project_id = ?`)
    .get(projectId);
  if (project === undefined)
    fail("PROJECT_NOT_FOUND", "No project exists with this id.", "projectId");
  if (project["status"] !== "active") {
    fail(
      "PROJECT_ARCHIVED",
      "This project is archived. Restore it before changing its goals.",
      "projectId",
    );
  }
}

export function readGoal(
  connection: GoalStatementRunner,
  goalId: string,
): DurableGoalRecord | undefined {
  const row = connection.prepare(`SELECT * FROM ${GOALS_TABLE} WHERE goal_id = ?`).get(goalId);
  return row === undefined ? undefined : toGoal(row);
}

/** A goal whose project is active, or undefined when no goal has this id. */
function writableGoal(
  connection: GoalStatementRunner,
  goalId: string,
): DurableGoalRecord | undefined {
  const goal = readGoal(connection, goalId);
  if (goal !== undefined) requireActiveProject(connection, goal.projectId);
  return goal;
}

function touchGoal(connection: GoalStatementRunner, goal: DurableGoalRecord, nowMs: number): void {
  connection
    .prepare(`UPDATE ${GOALS_TABLE} SET updated_at_ms = ? WHERE goal_id = ?`)
    .run(Math.max(nowMs, goal.updatedAtMs), goal.goalId);
}

/** Start an open goal in an active project. */
export function createGoal(
  connection: GoalStatementRunner,
  input: CreateGoalInput,
): DurableGoalRecord {
  const goalId = checkId("goalId", input.goalId);
  const nowMs = checkTime(input.nowMs);
  const title = checkTitle(input.title);
  const description = checkDescription(input.description ?? "");
  const priority = checkPriority(input.priority);
  requireActiveProject(connection, input.projectId);
  const conversationId = input.conversationId ?? null;
  if (conversationId !== null) {
    const conversation = connection
      .prepare(`SELECT project_id FROM ${CONVERSATIONS_TABLE} WHERE conversation_id = ?`)
      .get(conversationId);
    if (conversation === undefined || conversation["project_id"] !== input.projectId) {
      invalid("conversationId", "The conversation is not part of this project.");
    }
  }

  connection
    .prepare(
      `INSERT INTO ${GOALS_TABLE} (
        goal_id, project_id, conversation_id, title, description, status, blocked_reason,
        priority, created_at_ms, updated_at_ms, closed_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?, NULL)`,
    )
    .run(goalId, input.projectId, conversationId, title, description, priority, nowMs, nowMs);

  return Object.freeze({
    goalId,
    projectId: input.projectId,
    conversationId,
    title,
    description,
    status: "open",
    blockedReason: null,
    priority,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    closedAtMs: null,
  });
}

/** A project's goals, most urgent first, then oldest first. */
export function listGoals(
  connection: GoalStatementRunner,
  projectId: string,
  options: ListGoalsOptions = {},
): readonly DurableGoalRecord[] {
  const status = options.status ?? "all";
  const requested = options.limit ?? LIST_LIMIT;
  const limit = Number.isSafeInteger(requested)
    ? Math.max(1, Math.min(requested, LIST_LIMIT))
    : LIST_LIMIT;
  const rows =
    status === "all"
      ? connection
          .prepare(
            `SELECT * FROM ${GOALS_TABLE} WHERE project_id = ?
             ORDER BY priority ASC, goal_id ASC LIMIT ?`,
          )
          .all(projectId, limit)
      : connection
          .prepare(
            `SELECT * FROM ${GOALS_TABLE} WHERE project_id = ? AND status = ?
             ORDER BY priority ASC, goal_id ASC LIMIT ?`,
          )
          .all(projectId, status, limit);
  return Object.freeze(rows.map(toGoal));
}

/** Change an open or blocked goal. Returns undefined when no goal has this id. */
export function updateGoal(
  connection: GoalStatementRunner,
  goalId: string,
  input: UpdateGoalInput,
): DurableGoalRecord | undefined {
  const nowMs = checkTime(input.nowMs);
  const current = writableGoal(connection, goalId);
  if (current === undefined) return undefined;
  if (CLOSED_GOAL_STATUSES.has(current.status)) {
    fail("GOAL_CLOSED", "This goal is closed. Reopen it before changing it.");
  }
  const title = input.title === undefined ? current.title : checkTitle(input.title);
  const description =
    input.description === undefined ? current.description : checkDescription(input.description);
  const priority = input.priority === undefined ? current.priority : checkPriority(input.priority);
  const updatedAtMs = Math.max(nowMs, current.updatedAtMs);

  connection
    .prepare(
      `UPDATE ${GOALS_TABLE}
       SET title = ?, description = ?, priority = ?, updated_at_ms = ?
       WHERE goal_id = ?`,
    )
    .run(title, description, priority, updatedAtMs, goalId);
  return Object.freeze({ ...current, title, description, priority, updatedAtMs });
}

/**
 * Move a goal to another status along `GOAL_STATUS_TRANSITIONS`.
 *
 * Blocking needs a reason; setting the same blocked status again updates it. A goal
 * completes only when none of its todos are pending, in progress or blocked.
 */
export function setGoalStatus(
  connection: GoalStatementRunner,
  goalId: string,
  input: StatusChangeInput<DurableGoalStatus>,
): DurableGoalRecord | undefined {
  const nowMs = checkTime(input.nowMs);
  if (!(GOAL_STATUSES as readonly string[]).includes(input.status)) {
    invalid("status", `status must be one of ${GOAL_STATUSES.join(", ")}.`);
  }
  if (input.status !== "blocked" && input.reason !== undefined) {
    invalid("reason", "Only a blocked goal has a reason.");
  }
  const reason = input.status === "blocked" ? checkReason(input.reason) : null;
  const current = writableGoal(connection, goalId);
  if (current === undefined) return undefined;
  if (current.status === input.status) {
    if (reason === null || reason === current.blockedReason) return current;
  } else if (!GOAL_STATUS_TRANSITIONS[current.status].includes(input.status)) {
    fail(
      "GOAL_TRANSITION_INVALID",
      `A goal cannot go from ${current.status} to ${input.status}.`,
      "status",
    );
  }
  if (input.status === "completed") {
    const open = connection
      .prepare(
        `SELECT COUNT(*) AS count FROM ${TODOS_TABLE}
         WHERE goal_id = ? AND status IN ('pending', 'in_progress', 'blocked')`,
      )
      .get(goalId);
    if (integer(open?.["count"]) > 0) {
      fail("GOAL_HAS_OPEN_TODOS", "Finish or cancel this goal's open todos before completing it.");
    }
  }
  const updatedAtMs = Math.max(nowMs, current.updatedAtMs);
  const closedAtMs = CLOSED_GOAL_STATUSES.has(input.status) ? updatedAtMs : null;

  connection
    .prepare(
      `UPDATE ${GOALS_TABLE}
       SET status = ?, blocked_reason = ?, closed_at_ms = ?, updated_at_ms = ?
       WHERE goal_id = ?`,
    )
    .run(input.status, reason, closedAtMs, updatedAtMs, goalId);
  return Object.freeze({
    ...current,
    status: input.status,
    blockedReason: reason,
    closedAtMs,
    updatedAtMs,
  });
}

function dependenciesOf(connection: GoalStatementRunner, todoId: string): readonly string[] {
  return connection
    .prepare(
      `SELECT depends_on_todo_id AS id FROM ${TODO_DEPENDENCIES_TABLE}
       WHERE todo_id = ? ORDER BY depends_on_todo_id`,
    )
    .all(todoId)
    .map((row) => text(row["id"]));
}

export function readTodo(
  connection: GoalStatementRunner,
  todoId: string,
): DurableTodoRecord | undefined {
  const row = connection.prepare(`SELECT * FROM ${TODOS_TABLE} WHERE todo_id = ?`).get(todoId);
  return row === undefined ? undefined : toTodo(row, dependenciesOf(connection, todoId));
}

/** A goal's todos, most urgent first, then by position, then oldest first. */
export function listTodos(
  connection: GoalStatementRunner,
  goalId: string,
): readonly DurableTodoRecord[] {
  const dependencies = new Map<string, string[]>();
  for (const row of connection
    .prepare(
      `SELECT todo_id, depends_on_todo_id FROM ${TODO_DEPENDENCIES_TABLE}
       WHERE goal_id = ? ORDER BY todo_id, depends_on_todo_id`,
    )
    .all(goalId)) {
    const todoId = text(row["todo_id"]);
    const list = dependencies.get(todoId) ?? [];
    list.push(text(row["depends_on_todo_id"]));
    dependencies.set(todoId, list);
  }
  const rows = connection
    .prepare(
      `SELECT * FROM ${TODOS_TABLE} WHERE goal_id = ?
       ORDER BY priority ASC, position ASC, todo_id ASC LIMIT ${String(LIST_LIMIT)}`,
    )
    .all(goalId);
  return Object.freeze(
    rows.map((row) => toTodo(row, dependencies.get(text(row["todo_id"])) ?? [])),
  );
}

function checkDependencies(
  connection: GoalStatementRunner,
  goalId: string,
  todoId: string,
  dependsOn: readonly string[],
): readonly string[] {
  // Checked on an untyped copy: callers outside TypeScript can pass anything.
  const candidate: unknown = dependsOn;
  if (!Array.isArray(candidate)) invalid("dependsOn", "dependsOn must be a list of todo ids.");
  if (dependsOn.length > TODO_MAX_DEPENDENCIES) {
    invalid("dependsOn", `A todo has at most ${String(TODO_MAX_DEPENDENCIES)} dependencies.`);
  }
  const unique = [...new Set(dependsOn)].sort();
  for (const id of unique) {
    if (typeof id !== "string" || !SORTABLE_ID_PATTERN.test(id)) {
      invalid("dependsOn", "dependsOn must be a list of todo ids.");
    }
    if (id === todoId) invalid("dependsOn", "A todo cannot depend on itself.");
    const row = connection.prepare(`SELECT goal_id FROM ${TODOS_TABLE} WHERE todo_id = ?`).get(id);
    if (row === undefined || row["goal_id"] !== goalId) {
      invalid("dependsOn", `Todo '${id}' is not part of this goal.`);
    }
  }
  return unique;
}

/** Refuse dependencies that would make todos wait on each other forever. */
function assertAcyclic(
  connection: GoalStatementRunner,
  goalId: string,
  todoId: string,
  dependsOn: readonly string[],
): void {
  const edges = new Map<string, string[]>();
  for (const row of connection
    .prepare(
      `SELECT todo_id, depends_on_todo_id FROM ${TODO_DEPENDENCIES_TABLE}
       WHERE goal_id = ? AND todo_id <> ?`,
    )
    .all(goalId, todoId)) {
    const from = text(row["todo_id"]);
    const list = edges.get(from) ?? [];
    list.push(text(row["depends_on_todo_id"]));
    edges.set(from, list);
  }
  const seen = new Set<string>();
  const stack = [...dependsOn];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (next === todoId) {
      fail(
        "TODO_DEPENDENCY_CYCLE",
        "These dependencies would make todos wait on each other forever.",
        "dependsOn",
      );
    }
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(edges.get(next) ?? []));
  }
}

function insertDependencies(
  connection: GoalStatementRunner,
  todoId: string,
  goalId: string,
  dependsOn: readonly string[],
): void {
  const statement = connection.prepare(
    `INSERT INTO ${TODO_DEPENDENCIES_TABLE} (todo_id, depends_on_todo_id, goal_id) VALUES (?, ?, ?)`,
  );
  for (const dependency of dependsOn) statement.run(todoId, dependency, goalId);
}

function unfinishedDependencies(
  connection: GoalStatementRunner,
  dependsOn: readonly string[],
): readonly string[] {
  if (dependsOn.length === 0) return [];
  return connection
    .prepare(
      `SELECT todo_id FROM ${TODOS_TABLE}
       WHERE todo_id IN (${dependsOn.map(() => "?").join(", ")}) AND status <> 'done'
       ORDER BY todo_id`,
    )
    .all(...dependsOn)
    .map((row) => text(row["todo_id"]));
}

function openGoalFor(connection: GoalStatementRunner, goalId: string): DurableGoalRecord {
  const goal = writableGoal(connection, goalId);
  if (goal === undefined) fail("GOAL_NOT_FOUND", "No goal exists with this id.", "goalId");
  if (CLOSED_GOAL_STATUSES.has(goal.status)) {
    fail("GOAL_CLOSED", "This goal is closed. Reopen it before changing its todos.");
  }
  return goal;
}

/** Add a pending todo at the end of an open or blocked goal. */
export function createTodo(
  connection: GoalStatementRunner,
  input: CreateTodoInput,
): DurableTodoRecord {
  const todoId = checkId("todoId", input.todoId);
  const nowMs = checkTime(input.nowMs);
  const title = checkTitle(input.title);
  const description = checkDescription(input.description ?? "");
  const priority = checkPriority(input.priority);
  const goal = openGoalFor(connection, input.goalId);
  const dependsOn = checkDependencies(connection, goal.goalId, todoId, input.dependsOn ?? []);
  const last = connection
    .prepare(`SELECT MAX(position) AS position FROM ${TODOS_TABLE} WHERE goal_id = ?`)
    .get(goal.goalId);
  const lastPosition = last?.["position"];
  const position = typeof lastPosition === "number" ? lastPosition + 1 : 0;

  connection
    .prepare(
      `INSERT INTO ${TODOS_TABLE} (
        todo_id, goal_id, project_id, title, description, status, blocked_reason, priority,
        position, created_at_ms, updated_at_ms, started_at_ms, finished_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(todoId, goal.goalId, goal.projectId, title, description, priority, position, nowMs, nowMs);
  insertDependencies(connection, todoId, goal.goalId, dependsOn);
  touchGoal(connection, goal, nowMs);

  return Object.freeze({
    todoId,
    goalId: goal.goalId,
    projectId: goal.projectId,
    title,
    description,
    status: "pending",
    blockedReason: null,
    priority,
    position,
    dependsOn: Object.freeze([...dependsOn]),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    startedAtMs: null,
    finishedAtMs: null,
  });
}

/**
 * Change an unfinished todo in an open or blocked goal. Returns undefined when no
 * todo has this id. Passing `dependsOn` replaces the todo's dependencies.
 */
export function updateTodo(
  connection: GoalStatementRunner,
  todoId: string,
  input: UpdateTodoInput,
): DurableTodoRecord | undefined {
  const nowMs = checkTime(input.nowMs);
  const current = readTodo(connection, todoId);
  if (current === undefined) return undefined;
  const goal = openGoalFor(connection, current.goalId);
  if (FINISHED_TODO_STATUSES.has(current.status)) {
    fail("TODO_CLOSED", "This todo is finished. Reopen it before changing it.");
  }
  const title = input.title === undefined ? current.title : checkTitle(input.title);
  const description =
    input.description === undefined ? current.description : checkDescription(input.description);
  const priority = input.priority === undefined ? current.priority : checkPriority(input.priority);
  const position = input.position === undefined ? current.position : checkPosition(input.position);
  let dependsOn = current.dependsOn;
  if (input.dependsOn !== undefined) {
    dependsOn = checkDependencies(connection, current.goalId, todoId, input.dependsOn);
    assertAcyclic(connection, current.goalId, todoId, dependsOn);
    if (
      current.status === "in_progress" &&
      unfinishedDependencies(connection, dependsOn).length > 0
    ) {
      fail(
        "TODO_DEPENDENCIES_UNFINISHED",
        "A todo in progress cannot gain dependencies that are not done.",
        "dependsOn",
      );
    }
    connection.prepare(`DELETE FROM ${TODO_DEPENDENCIES_TABLE} WHERE todo_id = ?`).run(todoId);
    insertDependencies(connection, todoId, current.goalId, dependsOn);
  }
  const updatedAtMs = Math.max(nowMs, current.updatedAtMs);

  connection
    .prepare(
      `UPDATE ${TODOS_TABLE}
       SET title = ?, description = ?, priority = ?, position = ?, updated_at_ms = ?
       WHERE todo_id = ?`,
    )
    .run(title, description, priority, position, updatedAtMs, todoId);
  touchGoal(connection, goal, nowMs);
  return Object.freeze({
    ...current,
    title,
    description,
    priority,
    position,
    dependsOn: Object.freeze([...dependsOn]),
    updatedAtMs,
  });
}

/**
 * Move a todo along `TODO_STATUS_TRANSITIONS`.
 *
 * A todo starts or is done only once every dependency is done, and a done todo
 * reopens only while nothing that depends on it has started.
 */
export function setTodoStatus(
  connection: GoalStatementRunner,
  todoId: string,
  input: StatusChangeInput<DurableTodoStatus>,
): DurableTodoRecord | undefined {
  const nowMs = checkTime(input.nowMs);
  if (!(TODO_STATUSES as readonly string[]).includes(input.status)) {
    invalid("status", `status must be one of ${TODO_STATUSES.join(", ")}.`);
  }
  if (input.status !== "blocked" && input.reason !== undefined) {
    invalid("reason", "Only a blocked todo has a reason.");
  }
  const reason = input.status === "blocked" ? checkReason(input.reason) : null;
  const current = readTodo(connection, todoId);
  if (current === undefined) return undefined;
  const goal = openGoalFor(connection, current.goalId);
  if (current.status === input.status) {
    if (reason === null || reason === current.blockedReason) return current;
  } else if (!TODO_STATUS_TRANSITIONS[current.status].includes(input.status)) {
    fail(
      "TODO_TRANSITION_INVALID",
      `A todo cannot go from ${current.status} to ${input.status}.`,
      "status",
    );
  }
  if (
    (input.status === "in_progress" || input.status === "done") &&
    unfinishedDependencies(connection, current.dependsOn).length > 0
  ) {
    fail("TODO_DEPENDENCIES_UNFINISHED", "Finish this todo's dependencies first.");
  }
  if (current.status === "done" && input.status !== "done") {
    const started = connection
      .prepare(
        `SELECT COUNT(*) AS count FROM ${TODO_DEPENDENCIES_TABLE} AS d
         JOIN ${TODOS_TABLE} AS t ON t.todo_id = d.todo_id
         WHERE d.depends_on_todo_id = ? AND t.status IN ('in_progress', 'done')`,
      )
      .get(todoId);
    if (integer(started?.["count"]) > 0) {
      fail(
        "TODO_HAS_STARTED_DEPENDENTS",
        "Todos that depend on this one have already started. Reopen or reset those first.",
      );
    }
  }
  const updatedAtMs = Math.max(nowMs, current.updatedAtMs);
  const startedAtMs =
    input.status === "in_progress" && current.startedAtMs === null
      ? updatedAtMs
      : current.startedAtMs;
  const finishedAtMs = FINISHED_TODO_STATUSES.has(input.status) ? updatedAtMs : null;

  connection
    .prepare(
      `UPDATE ${TODOS_TABLE}
       SET status = ?, blocked_reason = ?, started_at_ms = ?, finished_at_ms = ?, updated_at_ms = ?
       WHERE todo_id = ?`,
    )
    .run(input.status, reason, startedAtMs, finishedAtMs, updatedAtMs, todoId);
  touchGoal(connection, goal, nowMs);
  return Object.freeze({
    ...current,
    status: input.status,
    blockedReason: reason,
    startedAtMs,
    finishedAtMs,
    updatedAtMs,
  });
}

export interface RunnableTodo {
  readonly todo: DurableTodoRecord;
  readonly goal: DurableGoalRecord;
}

export interface RunnableTodoOptions {
  /** Only consider this goal's todos. */
  readonly goalId?: string;
  /** Defaults to 50, at most 1000. */
  readonly limit?: number;
}

/**
 * Todos that can start now, in the order they should be taken.
 *
 * A todo is runnable when it is pending, every todo it depends on is done, its goal
 * is open (neither blocked nor closed) and its project is active. Todos already in
 * progress are claimed and never offered again. The order is total and uses stored
 * values only, so the same data always gives the same answer: goal priority, then
 * the older goal, then todo priority, then position, then the older todo.
 */
export function listRunnableTodos(
  connection: GoalStatementRunner,
  projectId: string,
  options: RunnableTodoOptions = {},
): readonly RunnableTodo[] {
  const requested = options.limit ?? 50;
  const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(requested, LIST_LIMIT)) : 50;
  const goalFilter = options.goalId === undefined ? "" : "AND t.goal_id = ?";
  const parameters: unknown[] = [
    projectId,
    ...(options.goalId === undefined ? [] : [options.goalId]),
    limit,
  ];
  const rows = connection
    .prepare(
      `SELECT t.todo_id AS todo_id FROM ${TODOS_TABLE} AS t
       JOIN ${GOALS_TABLE} AS g ON g.goal_id = t.goal_id
       JOIN ${PROJECTS_TABLE} AS p ON p.project_id = t.project_id
       WHERE t.project_id = ? ${goalFilter}
         AND p.status = 'active'
         AND g.status = 'open'
         AND t.status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM ${TODO_DEPENDENCIES_TABLE} AS d
           JOIN ${TODOS_TABLE} AS dependency ON dependency.todo_id = d.depends_on_todo_id
           WHERE d.todo_id = t.todo_id AND dependency.status <> 'done'
         )
       ORDER BY g.priority ASC, g.goal_id ASC, t.priority ASC, t.position ASC, t.todo_id ASC
       LIMIT ?`,
    )
    .all(...parameters);

  const goals = new Map<string, DurableGoalRecord>();
  const runnable: RunnableTodo[] = [];
  for (const row of rows) {
    const todo = readTodo(connection, text(row["todo_id"]));
    if (todo === undefined) continue;
    let goal = goals.get(todo.goalId);
    if (goal === undefined) {
      goal = readGoal(connection, todo.goalId);
      if (goal === undefined) continue;
      goals.set(todo.goalId, goal);
    }
    runnable.push(Object.freeze({ todo, goal }));
  }
  return Object.freeze(runnable);
}

/** The one todo to take next, or undefined when nothing can start. */
export function selectNextRunnableTodo(
  connection: GoalStatementRunner,
  projectId: string,
  options: { readonly goalId?: string } = {},
): RunnableTodo | undefined {
  return listRunnableTodos(connection, projectId, { ...options, limit: 1 })[0];
}
