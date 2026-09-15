import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { DURABLE_CONVERSATIONS_MIGRATION } from "./durable-conversation-records.js";
import {
  DURABLE_GOALS_MIGRATION,
  DURABLE_GOAL_BLOCKING_MIGRATION,
  GOALS_TABLE,
  createGoal,
  createTodo,
  reconcileGoalProgress,
  setGoalStatus,
  setTodoStatus,
} from "./durable-goal-records.js";
import {
  DURABLE_PROJECTS_MIGRATION,
  archiveProject,
  createProject,
} from "./durable-project-records.js";
import {
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  runSqliteMigrations,
} from "./index.js";
import { SortableIdGenerator } from "./sortable-id.js";

interface Fixture {
  readonly connection: DatabaseSync;
  readonly ids: SortableIdGenerator;
  readonly projectId: string;
}

const withDatabase = (run: (fixture: Fixture) => void): void => {
  const connection = new DatabaseSync(":memory:", {
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });
  try {
    runSqliteMigrations(
      connection,
      [
        DURABLE_GRAPH_IDENTITY_MIGRATION,
        DURABLE_RUNS_MIGRATION,
        DURABLE_PROJECTS_MIGRATION,
        DURABLE_CONVERSATIONS_MIGRATION,
        DURABLE_GOALS_MIGRATION,
        DURABLE_GOAL_BLOCKING_MIGRATION,
      ],
      { now: () => 1 },
    );
    const ids = new SortableIdGenerator({ now: () => 1_000 });
    const { projectId } = createProject(connection, {
      projectId: ids.next(),
      name: "Project",
      nowMs: 1,
    });
    run({ connection, ids, projectId });
  } finally {
    connection.close();
  }
};

describe("goal progress", () => {
  it("completes an open goal once its todos are finished, and only when one of them was done", () => {
    withDatabase(({ connection, ids, projectId }) => {
      const { goalId } = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Ship",
        nowMs: 1,
      });
      const a = createTodo(connection, { todoId: ids.next(), goalId, title: "A", nowMs: 2 });
      const b = createTodo(connection, { todoId: ids.next(), goalId, title: "B", nowMs: 2 });

      setTodoStatus(connection, a.todoId, { status: "done", nowMs: 3 });
      expect(reconcileGoalProgress(connection, goalId, 4)).toMatchObject({ change: "unchanged" });
      setTodoStatus(connection, b.todoId, { status: "cancelled", nowMs: 5 });
      expect(reconcileGoalProgress(connection, goalId, 6)).toMatchObject({
        change: "completed",
        goal: { status: "completed", closedAtMs: 6, blockedBy: null },
      });

      const cancelledOnly = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Dropped",
        nowMs: 7,
      });
      const dropped = createTodo(connection, {
        todoId: ids.next(),
        goalId: cancelledOnly.goalId,
        title: "Never mind",
        nowMs: 7,
      });
      setTodoStatus(connection, dropped.todoId, { status: "cancelled", nowMs: 8 });
      expect(reconcileGoalProgress(connection, cancelledOnly.goalId, 9)).toMatchObject({
        change: "unchanged",
        goal: { status: "open" },
      });

      const empty = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Empty",
        nowMs: 10,
      });
      expect(reconcileGoalProgress(connection, empty.goalId, 11)).toMatchObject({
        change: "unchanged",
      });
    });
  });

  it("blocks a goal whose remaining todos cannot move, and reopens it when one can", () => {
    withDatabase(({ connection, ids, projectId }) => {
      const { goalId } = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Site",
        nowMs: 1,
      });
      const design = createTodo(connection, {
        todoId: ids.next(),
        goalId,
        title: "Design",
        nowMs: 2,
      });
      const build = createTodo(connection, {
        todoId: ids.next(),
        goalId,
        title: "Build",
        dependsOn: [design.todoId],
        nowMs: 2,
      });

      setTodoStatus(connection, design.todoId, {
        status: "blocked",
        reason: "Waiting on brand",
        nowMs: 3,
      });
      expect(reconcileGoalProgress(connection, goalId, 4)).toMatchObject({
        change: "blocked",
        goal: {
          status: "blocked",
          blockedBy: "todos",
          blockedReason: "Waiting on blocked todos: Design",
        },
      });
      expect(reconcileGoalProgress(connection, goalId, 5)).toMatchObject({ change: "unchanged" });

      setTodoStatus(connection, design.todoId, { status: "pending", nowMs: 6 });
      expect(reconcileGoalProgress(connection, goalId, 7)).toMatchObject({
        change: "reopened",
        goal: { status: "open", blockedBy: null, blockedReason: null },
      });

      setTodoStatus(connection, design.todoId, { status: "in_progress", nowMs: 8 });
      setTodoStatus(connection, design.todoId, { status: "blocked", reason: "Out sick", nowMs: 9 });
      expect(reconcileGoalProgress(connection, goalId, 10)).toMatchObject({ change: "blocked" });
      setTodoStatus(connection, design.todoId, { status: "in_progress", nowMs: 11 });
      expect(reconcileGoalProgress(connection, goalId, 12)).toMatchObject({ change: "reopened" });

      setTodoStatus(connection, design.todoId, { status: "done", nowMs: 13 });
      expect(reconcileGoalProgress(connection, goalId, 14)).toMatchObject({ change: "unchanged" });
      setTodoStatus(connection, build.todoId, { status: "done", nowMs: 15 });
      expect(reconcileGoalProgress(connection, goalId, 16)).toMatchObject({
        change: "completed",
        goal: { status: "completed" },
      });
    });
  });

  it("never overrides a person's decision or changes an archived project's goals", () => {
    withDatabase(({ connection, ids, projectId }) => {
      const held = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Held",
        nowMs: 1,
      });
      expect(
        setGoalStatus(connection, held.goalId, {
          status: "blocked",
          reason: "Budget freeze",
          nowMs: 2,
        }),
      ).toMatchObject({ blockedBy: "person" });
      const task = createTodo(connection, {
        todoId: ids.next(),
        goalId: held.goalId,
        title: "Task",
        nowMs: 3,
      });
      setTodoStatus(connection, task.todoId, { status: "done", nowMs: 4 });
      expect(reconcileGoalProgress(connection, held.goalId, 5)).toMatchObject({
        change: "unchanged",
        goal: { status: "blocked", blockedBy: "person", blockedReason: "Budget freeze" },
      });

      const other = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Other",
        nowMs: 6,
      });
      const stuck = createTodo(connection, {
        todoId: ids.next(),
        goalId: other.goalId,
        title: "Stuck",
        nowMs: 6,
      });
      setTodoStatus(connection, stuck.todoId, { status: "blocked", reason: "Nope", nowMs: 7 });
      archiveProject(connection, projectId, 8);
      expect(reconcileGoalProgress(connection, other.goalId, 9)).toMatchObject({
        change: "unchanged",
        goal: { status: "open" },
      });
      expect(reconcileGoalProgress(connection, ids.next(), 10)).toBeUndefined();
    });
  });

  it("keeps who blocked a goal consistent with its status", () => {
    withDatabase(({ connection, ids, projectId }) => {
      const { goalId } = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Rules",
        nowMs: 1,
      });
      expect(() =>
        connection
          .prepare(
            `UPDATE ${GOALS_TABLE} SET status = 'blocked', blocked_reason = 'x' WHERE goal_id = ?`,
          )
          .run(goalId),
      ).toThrow(/who blocked it/u);
    });
  });
});
