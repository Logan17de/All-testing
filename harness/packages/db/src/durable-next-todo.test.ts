import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { DURABLE_CONVERSATIONS_MIGRATION } from "./durable-conversation-records.js";
import {
  DURABLE_GOALS_MIGRATION,
  createGoal,
  createTodo,
  listRunnableTodos,
  selectNextRunnableTodo,
  setGoalStatus,
  setTodoStatus,
  updateTodo,
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

describe("next runnable todo", () => {
  it("offers pending todos whose dependencies are done, in one fixed order", () => {
    withDatabase(({ connection, ids, projectId }) => {
      const later = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Later",
        priority: 50,
        nowMs: 1,
      });
      const sooner = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Sooner",
        priority: 10,
        nowMs: 2,
      });
      const newer = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Same priority, newer",
        priority: 10,
        nowMs: 3,
      });
      const todo = (
        goalId: string,
        title: string,
        extra: { readonly priority?: number; readonly dependsOn?: readonly string[] } = {},
      ) => createTodo(connection, { todoId: ids.next(), goalId, title, ...extra, nowMs: 10 });

      const laterWork = todo(later.goalId, "later work");
      const design = todo(sooner.goalId, "design");
      const build = todo(sooner.goalId, "build", { dependsOn: [design.todoId] });
      const note = todo(sooner.goalId, "urgent note", { priority: 1 });
      todo(newer.goalId, "newer goal work", { priority: 0 });

      const order = () => listRunnableTodos(connection, projectId).map((item) => item.todo.title);
      expect(order()).toEqual(["urgent note", "design", "newer goal work", "later work"]);
      expect(selectNextRunnableTodo(connection, projectId)).toMatchObject({
        todo: { title: "urgent note" },
        goal: { title: "Sooner" },
      });

      setTodoStatus(connection, note.todoId, { status: "in_progress", nowMs: 20 });
      expect(order()).toEqual(["design", "newer goal work", "later work"]);
      setTodoStatus(connection, design.todoId, { status: "done", nowMs: 21 });
      expect(order()).toEqual(["build", "newer goal work", "later work"]);
      updateTodo(connection, build.todoId, { priority: 900, nowMs: 22 });
      expect(order()).toEqual(["build", "newer goal work", "later work"]);

      expect(
        listRunnableTodos(connection, projectId, { goalId: later.goalId }).map(
          (item) => item.todo.todoId,
        ),
      ).toEqual([laterWork.todoId]);
      expect(listRunnableTodos(connection, projectId, { limit: 2 })).toHaveLength(2);
    });
  });

  it("skips blocked and closed goals, blocked todos and archived projects", () => {
    withDatabase(({ connection, ids, projectId }) => {
      const first = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "First",
        priority: 1,
        nowMs: 1,
      });
      const second = createGoal(connection, {
        goalId: ids.next(),
        projectId,
        title: "Second",
        priority: 2,
        nowMs: 2,
      });
      const a = createTodo(connection, {
        todoId: ids.next(),
        goalId: first.goalId,
        title: "a",
        nowMs: 3,
      });
      const b = createTodo(connection, {
        todoId: ids.next(),
        goalId: second.goalId,
        title: "b",
        nowMs: 4,
      });

      setGoalStatus(connection, first.goalId, { status: "blocked", reason: "Waiting", nowMs: 5 });
      expect(selectNextRunnableTodo(connection, projectId)?.todo.todoId).toBe(b.todoId);

      setTodoStatus(connection, b.todoId, { status: "blocked", reason: "Needs input", nowMs: 6 });
      expect(selectNextRunnableTodo(connection, projectId)).toBeUndefined();

      setGoalStatus(connection, first.goalId, { status: "open", nowMs: 7 });
      expect(selectNextRunnableTodo(connection, projectId)?.todo.todoId).toBe(a.todoId);
      setGoalStatus(connection, first.goalId, { status: "cancelled", nowMs: 8 });
      expect(selectNextRunnableTodo(connection, projectId)).toBeUndefined();

      setTodoStatus(connection, b.todoId, { status: "pending", nowMs: 9 });
      expect(selectNextRunnableTodo(connection, projectId)?.todo.todoId).toBe(b.todoId);
      archiveProject(connection, projectId, 10);
      expect(selectNextRunnableTodo(connection, projectId)).toBeUndefined();
      expect(selectNextRunnableTodo(connection, ids.next())).toBeUndefined();
    });
  });
});
