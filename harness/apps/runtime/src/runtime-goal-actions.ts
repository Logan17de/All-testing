import { createHash } from "node:crypto";

import type { SqliteDatabase } from "@zet-harness/db";
import {
  DurableGoalError,
  GOAL_STATUSES,
  TODO_STATUSES,
  createGoal,
  createTodo,
  listGoals,
  listTodos,
  readGoal,
  readGoalActionEffect,
  readTodo,
  reconcileGoalProgress,
  recordGoalActionEffect,
  selectNextRunnableTodo,
  setGoalStatus,
  setTodoStatus,
  updateTodo,
  type DurableGoalRecord,
  type DurableGoalStatus,
  type DurableTodoRecord,
  type DurableTodoStatus,
  type GoalListStatus,
  type GoalStatementRunner,
} from "@zet-harness/db/durable-goal-records";
import { readProject } from "@zet-harness/db/durable-project-records";
import { createSortableId } from "@zet-harness/db/sortable-id";
import type {
  AdapterInvocationContext,
  JsonObject,
  JsonSchema,
  JsonValue,
  ModelToolSpecification,
  NodeBehavior,
  ToolAdapter,
  ToolResult,
} from "@zet-harness/plugin-api";

/** Tool ids of the model-visible goal and todo actions. */
export const GOAL_ACTION_TOOL_IDS = Object.freeze({
  listGoals: "harness.goals.list",
  getGoal: "harness.goals.get",
  createGoal: "harness.goals.create",
  setGoalStatus: "harness.goals.set-status",
  createTodo: "harness.todos.create",
  updateTodo: "harness.todos.update",
  setTodoStatus: "harness.todos.set-status",
  nextTodo: "harness.todos.next",
});

export interface GoalActionToolOptions {
  readonly database: SqliteDatabase;
  /** Every action is confined to this project; ids from other projects are not found. */
  readonly projectId: string;
  /** UTC epoch milliseconds. Defaults to the system clock. */
  readonly now?: () => number;
  /** Defaults to a sortable UUIDv7. */
  readonly createId?: () => string;
}

const READ_BEHAVIOR: NodeBehavior = {
  primitiveFamily: "effect",
  determinism: "nondeterministic",
  effect: "external-read",
  idempotency: "idempotent",
  recovery: "rerun",
  executionMode: "in-process",
  requiredCapabilities: [],
};

const WRITE_BEHAVIOR: NodeBehavior = {
  primitiveFamily: "effect",
  determinism: "nondeterministic",
  effect: "external-write",
  // A retry reuses the invocation's logical effect id, and the recorded result is
  // returned instead of acting a second time, so rerunning is safe.
  idempotency: "idempotency-key",
  recovery: "rerun",
  executionMode: "in-process",
  requiredCapabilities: [],
};

const SORTABLE_ID_SCHEMA = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
};
const TITLE_SCHEMA = { type: "string", minLength: 1, maxLength: 200 };
const DESCRIPTION_SCHEMA = { type: "string", maxLength: 4000 };
const PRIORITY_SCHEMA = {
  type: "integer",
  minimum: 0,
  maximum: 1000,
  description: "0 is most urgent; the default is 100.",
};
const REASON_SCHEMA = {
  type: "string",
  maxLength: 1000,
  description: "Required when blocking, and only then.",
};

const OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

function objectSchema(
  properties: Record<string, JsonValue>,
  required: readonly string[],
): JsonSchema {
  return { type: "object", properties, required: [...required], additionalProperties: false };
}

type ActionInputErrorCode =
  "ACTION_INPUT_INVALID" | "GOAL_NOT_FOUND" | "TODO_NOT_FOUND" | "PROJECT_NOT_FOUND";

/** Input the model should correct; returned to it as a refusal rather than thrown. */
class ActionInputError extends Error {
  readonly code: ActionInputErrorCode;
  readonly field: string | undefined;

  constructor(code: ActionInputErrorCode, message: string, field?: string) {
    super(message);
    this.name = "ActionInputError";
    this.code = code;
    this.field = field;
  }
}

const invalidInput = (message: string, field?: string): ActionInputError =>
  new ActionInputError("ACTION_INPUT_INVALID", message, field);

function only(input: JsonObject, allowed: readonly string[]): void {
  for (const field of Object.keys(input)) {
    if (!allowed.includes(field)) throw invalidInput(`Unknown field '${field}'.`, field);
  }
}

function optionalString(input: JsonObject, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidInput(`${field} must be a string.`, field);
  return value;
}

function requiredString(input: JsonObject, field: string): string {
  const value = optionalString(input, field);
  if (value === undefined) throw invalidInput(`${field} is required.`, field);
  return value;
}

function optionalInteger(input: JsonObject, field: string): number | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidInput(`${field} must be an integer.`, field);
  }
  return value;
}

function optionalStringList(input: JsonObject, field: string): readonly string[] | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw invalidInput(`${field} must be a list of ids.`, field);
  }
  return value.filter((item): item is string => typeof item === "string");
}

function json(value: unknown): JsonValue {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);
}

/** Key-sorted JSON, so equal inputs always hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function refusal(error: ActionInputError | DurableGoalError): JsonObject {
  return {
    ok: false,
    error: {
      code: error.code,
      reason: error.message,
      ...(error.field === undefined ? {} : { field: error.field }),
    },
  };
}

function isRefusal(error: unknown): error is ActionInputError | DurableGoalError {
  return error instanceof ActionInputError || error instanceof DurableGoalError;
}

/** Provider-safe function name for a tool id: letters, digits, underscores and hyphens. */
export function modelToolName(toolId: string): string {
  return toolId.replace(/[^A-Za-z0-9_-]/gu, "_");
}

/** What a model request needs to offer these actions to a model. */
export function goalActionToolSpecifications(
  tools: readonly ToolAdapter[],
): readonly ModelToolSpecification[] {
  return Object.freeze(
    tools.map((tool) =>
      Object.freeze({
        name: modelToolName(tool.manifest.id),
        ...(tool.manifest.description === undefined
          ? {}
          : { description: tool.manifest.description }),
        inputSchema: tool.manifest.inputSchema,
      }),
    ),
  );
}

/**
 * Goal and todo actions a model can call, confined to one project.
 *
 * Reads answer from the current records. Writes run in one serialized commit and are
 * recorded against the invocation's logical effect id, the action and the input hash,
 * so a retried attempt returns the recorded result instead of acting twice. Refusals
 * (invalid input, an id outside the project, an invalid transition) are returned as
 * `{ ok: false, error }` values the model can act on, and a refused write changes
 * nothing.
 */
export function createGoalActionTools(options: GoalActionToolOptions): readonly ToolAdapter[] {
  const { database, projectId } = options;
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? createSortableId;

  const goalInProject = (connection: GoalStatementRunner, goalId: string): DurableGoalRecord => {
    const goal = readGoal(connection, goalId);
    if (goal === undefined || goal.projectId !== projectId) {
      throw new ActionInputError(
        "GOAL_NOT_FOUND",
        "No goal with this id is in this project.",
        "goalId",
      );
    }
    return goal;
  };

  const todoInProject = (connection: GoalStatementRunner, todoId: string): DurableTodoRecord => {
    const todo = readTodo(connection, todoId);
    if (todo === undefined || todo.projectId !== projectId) {
      throw new ActionInputError(
        "TODO_NOT_FOUND",
        "No todo with this id is in this project.",
        "todoId",
      );
    }
    return todo;
  };

  /** 8.13: after a todo changes, its goal may complete, block or reopen. The model sees the result. */
  const progressOf = (connection: GoalStatementRunner, goalId: string): JsonObject => {
    const progress = reconcileGoalProgress(connection, goalId, now());
    return progress === undefined ? {} : { goal: json(progress.goal), goalChange: progress.change };
  };

  const read = (
    context: AdapterInvocationContext,
    perform: (connection: GoalStatementRunner) => JsonObject,
  ): Promise<ToolResult> =>
    Promise.resolve().then(() => {
      context.signal.throwIfAborted();
      try {
        return { value: { ok: true, ...perform(database.connection()) } };
      } catch (error) {
        if (isRefusal(error)) return { value: refusal(error) };
        throw error;
      }
    });

  const write = async (
    action: string,
    input: JsonObject,
    context: AdapterInvocationContext,
    perform: (connection: GoalStatementRunner) => JsonObject,
  ): Promise<ToolResult> => {
    context.signal.throwIfAborted();
    const inputSha256 = createHash("sha256").update(canonicalJson(input)).digest("hex");
    const value = await database.commit((connection): JsonObject => {
      if (readProject(connection, projectId) === undefined) {
        return refusal(
          new ActionInputError(
            "PROJECT_NOT_FOUND",
            "The project these actions belong to does not exist.",
          ),
        );
      }
      const key = { logicalEffectId: context.logicalEffectId, action, inputSha256 };
      const recorded = readGoalActionEffect(connection, key);
      if (recorded !== undefined) return recorded.result as JsonObject;

      let result: JsonObject;
      connection.exec("SAVEPOINT goal_action");
      try {
        result = { ok: true, ...perform(connection) };
        connection.exec("RELEASE goal_action");
      } catch (error) {
        connection.exec("ROLLBACK TO goal_action");
        connection.exec("RELEASE goal_action");
        if (!isRefusal(error)) throw error;
        result = refusal(error);
      }
      recordGoalActionEffect(connection, { ...key, projectId, result, nowMs: now() });
      return result;
    });
    return { value };
  };

  const tool = (
    id: string,
    title: string,
    description: string,
    inputSchema: JsonSchema,
    behavior: NodeBehavior,
    invoke: (input: JsonObject, context: AdapterInvocationContext) => Promise<ToolResult>,
  ): ToolAdapter =>
    Object.freeze({
      manifest: Object.freeze({
        id,
        version: "1",
        title,
        description,
        inputSchema,
        outputSchema: OUTPUT_SCHEMA,
        behavior,
      }),
      invoke,
    });

  return Object.freeze([
    tool(
      GOAL_ACTION_TOOL_IDS.listGoals,
      "List goals",
      "List this project's goals, most urgent first. Optionally filter by status.",
      objectSchema({ status: { type: "string", enum: ["all", ...GOAL_STATUSES] } }, []),
      READ_BEHAVIOR,
      (input, context) =>
        read(context, (connection) => {
          only(input, ["status"]);
          const status = optionalString(input, "status") ?? "all";
          if (status !== "all" && !(GOAL_STATUSES as readonly string[]).includes(status)) {
            throw invalidInput("status must be all or a goal status.", "status");
          }
          return {
            goals: json(listGoals(connection, projectId, { status: status as GoalListStatus })),
          };
        }),
    ),
    tool(
      GOAL_ACTION_TOOL_IDS.getGoal,
      "Read a goal",
      "Read one goal of this project and its todos in the order they should be done.",
      objectSchema({ goalId: SORTABLE_ID_SCHEMA }, ["goalId"]),
      READ_BEHAVIOR,
      (input, context) =>
        read(context, (connection) => {
          only(input, ["goalId"]);
          const goal = goalInProject(connection, requiredString(input, "goalId"));
          return { goal: json(goal), todos: json(listTodos(connection, goal.goalId)) };
        }),
    ),
    tool(
      GOAL_ACTION_TOOL_IDS.createGoal,
      "Create a goal",
      "Create an open goal in this project.",
      objectSchema(
        { title: TITLE_SCHEMA, description: DESCRIPTION_SCHEMA, priority: PRIORITY_SCHEMA },
        ["title"],
      ),
      WRITE_BEHAVIOR,
      (input, context) =>
        write(GOAL_ACTION_TOOL_IDS.createGoal, input, context, (connection) => {
          only(input, ["title", "description", "priority"]);
          const title = requiredString(input, "title");
          const description = optionalString(input, "description");
          const priority = optionalInteger(input, "priority");
          const goal = createGoal(connection, {
            goalId: createId(),
            projectId,
            title,
            ...(description === undefined ? {} : { description }),
            ...(priority === undefined ? {} : { priority }),
            nowMs: now(),
          });
          return { goal: json(goal) };
        }),
    ),
    tool(
      GOAL_ACTION_TOOL_IDS.setGoalStatus,
      "Change a goal's status",
      "Move a goal to open, blocked (with a reason), completed or cancelled. A goal completes only when none of its todos are open.",
      objectSchema(
        {
          goalId: SORTABLE_ID_SCHEMA,
          status: { type: "string", enum: [...GOAL_STATUSES] },
          reason: REASON_SCHEMA,
        },
        ["goalId", "status"],
      ),
      WRITE_BEHAVIOR,
      (input, context) =>
        write(GOAL_ACTION_TOOL_IDS.setGoalStatus, input, context, (connection) => {
          only(input, ["goalId", "status", "reason"]);
          const goal = goalInProject(connection, requiredString(input, "goalId"));
          const status = requiredString(input, "status") as DurableGoalStatus;
          const reason = optionalString(input, "reason");
          const updated = setGoalStatus(connection, goal.goalId, {
            status,
            ...(reason === undefined ? {} : { reason }),
            nowMs: now(),
          });
          return { goal: json(updated) };
        }),
    ),
    tool(
      GOAL_ACTION_TOOL_IDS.createTodo,
      "Add a todo",
      "Add a pending todo to the end of a goal. dependsOn lists todos of the same goal that must be done first.",
      objectSchema(
        {
          goalId: SORTABLE_ID_SCHEMA,
          title: TITLE_SCHEMA,
          description: DESCRIPTION_SCHEMA,
          priority: PRIORITY_SCHEMA,
          dependsOn: { type: "array", items: SORTABLE_ID_SCHEMA, maxItems: 100 },
        },
        ["goalId", "title"],
      ),
      WRITE_BEHAVIOR,
      (input, context) =>
        write(GOAL_ACTION_TOOL_IDS.createTodo, input, context, (connection) => {
          only(input, ["goalId", "title", "description", "priority", "dependsOn"]);
          const goal = goalInProject(connection, requiredString(input, "goalId"));
          const title = requiredString(input, "title");
          const description = optionalString(input, "description");
          const priority = optionalInteger(input, "priority");
          const dependsOn = optionalStringList(input, "dependsOn");
          const todo = createTodo(connection, {
            todoId: createId(),
            goalId: goal.goalId,
            title,
            ...(description === undefined ? {} : { description }),
            ...(priority === undefined ? {} : { priority }),
            ...(dependsOn === undefined ? {} : { dependsOn }),
            nowMs: now(),
          });
          return { todo: json(todo), ...progressOf(connection, todo.goalId) };
        }),
    ),
    tool(
      GOAL_ACTION_TOOL_IDS.updateTodo,
      "Change a todo",
      "Change an unfinished todo's title, description, priority, position or dependencies. dependsOn replaces the existing list.",
      objectSchema(
        {
          todoId: SORTABLE_ID_SCHEMA,
          title: TITLE_SCHEMA,
          description: DESCRIPTION_SCHEMA,
          priority: PRIORITY_SCHEMA,
          position: { type: "integer", minimum: 0 },
          dependsOn: { type: "array", items: SORTABLE_ID_SCHEMA, maxItems: 100 },
        },
        ["todoId"],
      ),
      WRITE_BEHAVIOR,
      (input, context) =>
        write(GOAL_ACTION_TOOL_IDS.updateTodo, input, context, (connection) => {
          only(input, ["todoId", "title", "description", "priority", "position", "dependsOn"]);
          const todo = todoInProject(connection, requiredString(input, "todoId"));
          const title = optionalString(input, "title");
          const description = optionalString(input, "description");
          const priority = optionalInteger(input, "priority");
          const position = optionalInteger(input, "position");
          const dependsOn = optionalStringList(input, "dependsOn");
          const updated = updateTodo(connection, todo.todoId, {
            ...(title === undefined ? {} : { title }),
            ...(description === undefined ? {} : { description }),
            ...(priority === undefined ? {} : { priority }),
            ...(position === undefined ? {} : { position }),
            ...(dependsOn === undefined ? {} : { dependsOn }),
            nowMs: now(),
          });
          return { todo: json(updated), ...progressOf(connection, todo.goalId) };
        }),
    ),
    tool(
      GOAL_ACTION_TOOL_IDS.setTodoStatus,
      "Change a todo's status",
      "Move a todo to pending, in_progress, blocked (with a reason), done or cancelled. A todo starts or is done only once its dependencies are done.",
      objectSchema(
        {
          todoId: SORTABLE_ID_SCHEMA,
          status: { type: "string", enum: [...TODO_STATUSES] },
          reason: REASON_SCHEMA,
        },
        ["todoId", "status"],
      ),
      WRITE_BEHAVIOR,
      (input, context) =>
        write(GOAL_ACTION_TOOL_IDS.setTodoStatus, input, context, (connection) => {
          only(input, ["todoId", "status", "reason"]);
          const todo = todoInProject(connection, requiredString(input, "todoId"));
          const status = requiredString(input, "status") as DurableTodoStatus;
          const reason = optionalString(input, "reason");
          const updated = setTodoStatus(connection, todo.todoId, {
            status,
            ...(reason === undefined ? {} : { reason }),
            nowMs: now(),
          });
          return { todo: json(updated), ...progressOf(connection, todo.goalId) };
        }),
    ),
    tool(
      GOAL_ACTION_TOOL_IDS.nextTodo,
      "Find the next todo",
      "Find the todo to work on next in this project, or in one goal. Returns null when nothing can start.",
      objectSchema({ goalId: SORTABLE_ID_SCHEMA }, []),
      READ_BEHAVIOR,
      (input, context) =>
        read(context, (connection) => {
          only(input, ["goalId"]);
          const goalId = optionalString(input, "goalId");
          if (goalId !== undefined) goalInProject(connection, goalId);
          const next = selectNextRunnableTodo(
            connection,
            projectId,
            goalId === undefined ? {} : { goalId },
          );
          return { todo: json(next?.todo), goal: json(next?.goal) };
        }),
    ),
  ]);
}
