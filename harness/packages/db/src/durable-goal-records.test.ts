import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  DURABLE_CONVERSATIONS_MIGRATION,
  createConversation,
} from "./durable-conversation-records.js";
import {
  DURABLE_GOALS_MIGRATION,
  DURABLE_GOAL_BLOCKING_MIGRATION,
  DurableGoalError,
  GOALS_TABLE,
  TODOS_TABLE,
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
  type DurableTodoStatus,
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
  readonly conversationId: string;
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
    const { conversationId } = createConversation(connection, {
      conversationId: ids.next(),
      projectId,
      nowMs: 1,
    });
    run({ connection, ids, projectId, conversationId });
  } finally {
    connection.close();
  }
};

function failure(action: () => unknown): DurableGoalError {
  try {
    action();
  } catch (error) {
    if (error instanceof DurableGoalError) return error;
    throw error;
  }
  throw new Error("Expected the goal or todo write to be refused.");
}

describe("durable goals and todos", () => {
  it("creates goals in active projects, optionally linked to one of the project's conversations", () => {
    withDatabase(({ connection, ids, projectId, conversationId }) => {
      const later = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Later",
        nowMs: 10,
      });
      const urgent = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        conversationId,
        title: "  Urgent  ",
        description: "Now",
        priority: 5,
        nowMs: 20,
      });

      expect(urgent).toEqual({
        goalId: urgent.goalId,
        projectId,
        conversationId,
        title: "Urgent",
        description: "Now",
        status: "open",
        blockedReason: null,
        blockedBy: null,
        priority: 5,
        createdAtMs: 20,
        updatedAtMs: 20,
        closedAtMs: null,
      });
      expect(later.priority).toBe(100);
      expect(readGoal(connection, urgent.goalId)).toEqual(urgent);
      expect(listGoals(connection, projectId).map((goal) => goal.title)).toEqual([
        "Urgent",
        "Later",
      ]);

      const other = createProject(connection, { projectId: ids.next(), name: "Other", nowMs: 1 });
      expect(
        failure(() =>
          createGoal(connection, {
            goalId: ids.next(),
            projectId: other.projectId,
            conversationId,
            title: "Wrong conversation",
            nowMs: 30,
          }),
        ),
      ).toMatchObject({ code: "GOAL_INVALID", field: "conversationId" });
      expect(
        failure(() =>
          createGoal(connection, { goalId: ids.next(), projectId, title: " ", nowMs: 30 }),
        ),
      ).toMatchObject({ field: "title" });
      expect(
        failure(() =>
          createGoal(connection, {
            goalId: ids.next(),
            projectId,
            title: "x",
            priority: 1_001,
            nowMs: 30,
          }),
        ),
      ).toMatchObject({ field: "priority" });
      expect(
        failure(() =>
          createGoal(connection, {
            goalId: ids.next(),
            projectId: ids.next(),
            title: "x",
            nowMs: 30,
          }),
        ),
      ).toMatchObject({ code: "PROJECT_NOT_FOUND" });
      archiveProject(connection, other.projectId, 40);
      expect(
        failure(() =>
          createGoal(connection, {
            goalId: ids.next(),
            projectId: other.projectId,
            title: "x",
            nowMs: 50,
          }),
        ),
      ).toMatchObject({ code: "PROJECT_ARCHIVED" });
    });
  });

  it("moves goals only through valid transitions and completes them once their todos are finished", () => {
    withDatabase(({ connection, ids, projectId }) => {
      const { goalId } = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Ship",
        nowMs: 10,
      });

      expect(
        failure(() => setGoalStatus(connection, goalId, { status: "blocked", nowMs: 20 })),
      ).toMatchObject({ code: "GOAL_INVALID", field: "reason" });
      expect(
        setGoalStatus(connection, goalId, {
          status: "blocked",
          reason: "Waiting on design",
          nowMs: 20,
        }),
      ).toMatchObject({ status: "blocked", blockedReason: "Waiting on design" });
      expect(
        failure(() => setGoalStatus(connection, goalId, { status: "completed", nowMs: 30 })),
      ).toMatchObject({ code: "GOAL_TRANSITION_INVALID" });
      expect(setGoalStatus(connection, goalId, { status: "open", nowMs: 30 })).toMatchObject({
        status: "open",
        blockedReason: null,
      });
      expect(
        failure(() =>
          setGoalStatus(connection, goalId, { status: "open", reason: "x", nowMs: 31 }),
        ),
      ).toMatchObject({ field: "reason" });

      const todo = createTodo(connection, {
        todoId: ids.next(),
        goalId,
        title: "Write copy",
        nowMs: 40,
      });
      expect(
        failure(() => setGoalStatus(connection, goalId, { status: "completed", nowMs: 50 })),
      ).toMatchObject({ code: "GOAL_HAS_OPEN_TODOS" });
      setTodoStatus(connection, todo.todoId, { status: "done", nowMs: 60 });
      expect(setGoalStatus(connection, goalId, { status: "completed", nowMs: 70 })).toMatchObject({
        status: "completed",
        closedAtMs: 70,
      });

      expect(
        failure(() => updateGoal(connection, goalId, { title: "Again", nowMs: 80 })),
      ).toMatchObject({
        code: "GOAL_CLOSED",
      });
      expect(
        failure(() =>
          createTodo(connection, { todoId: ids.next(), goalId, title: "More", nowMs: 80 }),
        ),
      ).toMatchObject({ code: "GOAL_CLOSED" });
      expect(
        failure(() => setTodoStatus(connection, todo.todoId, { status: "pending", nowMs: 80 })),
      ).toMatchObject({ code: "GOAL_CLOSED" });

      expect(setGoalStatus(connection, goalId, { status: "open", nowMs: 90 })).toMatchObject({
        status: "open",
        closedAtMs: null,
      });
      expect(
        updateGoal(connection, goalId, { title: "Ship v2", priority: 1, nowMs: 95 }),
      ).toMatchObject({
        title: "Ship v2",
        priority: 1,
      });
      expect(setGoalStatus(connection, goalId, { status: "cancelled", nowMs: 100 })).toMatchObject({
        status: "cancelled",
        closedAtMs: 100,
      });
      expect(setGoalStatus(connection, ids.next(), { status: "open", nowMs: 110 })).toBeUndefined();
      expect(listGoals(connection, projectId, { status: "cancelled" })).toHaveLength(1);
    });
  });

  it("orders todos and moves them only through valid transitions", () => {
    withDatabase(({ connection, ids, projectId }) => {
      const { goalId } = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Launch",
        nowMs: 1,
      });
      const first = createTodo(connection, {
        todoId: ids.next(),
        goalId,
        title: "First",
        nowMs: 10,
      });
      const second = createTodo(connection, {
        todoId: ids.next(),
        goalId,
        title: "Second",
        nowMs: 11,
      });
      const urgent = createTodo(connection, {
        todoId: ids.next(),
        goalId,
        title: "Urgent",
        priority: 1,
        nowMs: 12,
      });

      expect([first.position, second.position, urgent.position]).toEqual([0, 1, 2]);
      expect(listTodos(connection, goalId).map((todo) => todo.title)).toEqual([
        "Urgent",
        "First",
        "Second",
      ]);
      updateTodo(connection, first.todoId, { position: 5, nowMs: 13 });
      expect(listTodos(connection, goalId).map((todo) => todo.title)).toEqual([
        "Urgent",
        "Second",
        "First",
      ]);

      expect(
        setTodoStatus(connection, first.todoId, { status: "in_progress", nowMs: 20 }),
      ).toMatchObject({
        status: "in_progress",
        startedAtMs: 20,
        finishedAtMs: null,
      });
      expect(
        failure(() => setTodoStatus(connection, first.todoId, { status: "blocked", nowMs: 21 })),
      ).toMatchObject({ field: "reason" });
      expect(
        setTodoStatus(connection, first.todoId, {
          status: "blocked",
          reason: "Need access",
          nowMs: 22,
        }),
      ).toMatchObject({ status: "blocked", blockedReason: "Need access" });
      expect(
        failure(() => setTodoStatus(connection, first.todoId, { status: "done", nowMs: 23 })),
      ).toMatchObject({ code: "TODO_TRANSITION_INVALID" });
      expect(
        setTodoStatus(connection, first.todoId, { status: "in_progress", nowMs: 24 }),
      ).toMatchObject({
        startedAtMs: 20,
        blockedReason: null,
      });
      expect(setTodoStatus(connection, first.todoId, { status: "done", nowMs: 30 })).toMatchObject({
        status: "done",
        finishedAtMs: 30,
      });
      expect(
        failure(() =>
          setTodoStatus(connection, first.todoId, { status: "in_progress", nowMs: 31 }),
        ),
      ).toMatchObject({ code: "TODO_TRANSITION_INVALID" });
      expect(
        failure(() => updateTodo(connection, first.todoId, { title: "Edit", nowMs: 31 })),
      ).toMatchObject({
        code: "TODO_CLOSED",
      });
      expect(
        setTodoStatus(connection, first.todoId, { status: "pending", nowMs: 32 }),
      ).toMatchObject({
        status: "pending",
        startedAtMs: 20,
        finishedAtMs: null,
      });
      expect(
        failure(() =>
          setTodoStatus(connection, first.todoId, {
            status: "waiting" as DurableTodoStatus,
            nowMs: 33,
          }),
        ),
      ).toMatchObject({ field: "status" });
      expect(setTodoStatus(connection, ids.next(), { status: "done", nowMs: 34 })).toBeUndefined();
      expect(readGoal(connection, goalId)?.updatedAtMs).toBe(32);
    });
  });

  it("keeps dependencies inside one goal, acyclic, and respected by status changes", () => {
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
        nowMs: 10,
      });
      const build = createTodo(connection, {
        todoId: ids.next(),
        goalId,
        title: "Build",
        dependsOn: [design.todoId],
        nowMs: 11,
      });
      const ship = createTodo(connection, {
        todoId: ids.next(),
        goalId,
        title: "Ship",
        dependsOn: [build.todoId, design.todoId, build.todoId],
        nowMs: 12,
      });

      expect(build.dependsOn).toEqual([design.todoId]);
      expect(readTodo(connection, ship.todoId)?.dependsOn).toEqual([design.todoId, build.todoId]);
      expect(
        listTodos(connection, goalId).find((todo) => todo.todoId === ship.todoId)?.dependsOn,
      ).toEqual([design.todoId, build.todoId]);

      expect(
        failure(() =>
          setTodoStatus(connection, build.todoId, { status: "in_progress", nowMs: 20 }),
        ),
      ).toMatchObject({ code: "TODO_DEPENDENCIES_UNFINISHED" });
      expect(
        failure(() =>
          updateTodo(connection, design.todoId, { dependsOn: [ship.todoId], nowMs: 21 }),
        ),
      ).toMatchObject({ code: "TODO_DEPENDENCY_CYCLE" });
      expect(
        failure(() =>
          updateTodo(connection, design.todoId, { dependsOn: [design.todoId], nowMs: 21 }),
        ),
      ).toMatchObject({ field: "dependsOn" });

      const other = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Other",
        nowMs: 22,
      });
      const elsewhere = createTodo(connection, {
        todoId: ids.next(),
        goalId: other.goalId,
        title: "Elsewhere",
        nowMs: 23,
      });
      expect(
        failure(() =>
          updateTodo(connection, build.todoId, { dependsOn: [elsewhere.todoId], nowMs: 24 }),
        ),
      ).toMatchObject({ field: "dependsOn" });

      setTodoStatus(connection, design.todoId, { status: "done", nowMs: 30 });
      expect(
        setTodoStatus(connection, build.todoId, { status: "in_progress", nowMs: 31 }),
      ).toMatchObject({
        status: "in_progress",
      });
      expect(
        failure(() => setTodoStatus(connection, design.todoId, { status: "pending", nowMs: 32 })),
      ).toMatchObject({ code: "TODO_HAS_STARTED_DEPENDENTS" });
      expect(
        updateTodo(connection, ship.todoId, { dependsOn: [design.todoId], nowMs: 33 })?.dependsOn,
      ).toEqual([design.todoId]);
    });
  });

  it("keeps goals and todos in their tables", () => {
    withDatabase(({ connection, ids, projectId }) => {
      const goal = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Kept",
        nowMs: 1,
      });
      const todo = createTodo(connection, {
        todoId: ids.next(),
        goalId: goal.goalId,
        title: "Kept too",
        nowMs: 1,
      });

      expect(() =>
        connection.prepare(`DELETE FROM ${GOALS_TABLE} WHERE goal_id = ?`).run(goal.goalId),
      ).toThrow(/goals are closed, never deleted/u);
      expect(() =>
        connection.prepare(`DELETE FROM ${TODOS_TABLE} WHERE todo_id = ?`).run(todo.todoId),
      ).toThrow(/todos are closed, never deleted/u);
      expect(() =>
        connection
          .prepare(`UPDATE ${TODOS_TABLE} SET goal_id = ? WHERE todo_id = ?`)
          .run(ids.next(), todo.todoId),
      ).toThrow(/keeps its id/u);
      expect(() =>
        connection
          .prepare(`UPDATE ${TODOS_TABLE} SET status = 'blocked' WHERE todo_id = ?`)
          .run(todo.todoId),
      ).toThrow(/CHECK constraint failed/u);
    });
  });
});
