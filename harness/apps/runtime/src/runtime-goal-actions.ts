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
  readTodo,
  reconcileGoalProgress,
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
import { createSortableId } from "@zet-harness/db/sortable-id";
import type { JsonObject, ToolAdapter } from "@zet-harness/plugin-api";

import {
  ActionInputError,
  READ_BEHAVIOR,
  SORTABLE_ID_SCHEMA,
  WRITE_BEHAVIOR,
  actionTool,
  createActionRunners,
  invalidInput,
  json,
  objectSchema,
  only,
  optionalInteger,
  optionalString,
  optionalStringList,
  requiredString,
} from "./runtime-action-tools.js";

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

function isRefusal(error: unknown): error is ActionInputError | DurableGoalError {
  return error instanceof ActionInputError || error instanceof DurableGoalError;
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

  const { read, write } = createActionRunners({
    database,
    projectId,
    now,
    isRefusal,
    savepoint: "goal_action",
  });

  return Object.freeze([
    actionTool(
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
    actionTool(
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
    actionTool(
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
    actionTool(
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
    actionTool(
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
    actionTool(
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
    actionTool(
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
    actionTool(
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
