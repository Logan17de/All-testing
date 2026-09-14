import { afterEach, describe, expect, it } from "vitest";

import { SQLITE_MEMORY_PATH, SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { createGoal, listGoals, listTodos, readGoal } from "@zet-harness/db/durable-goal-records";
import { createProject } from "@zet-harness/db/durable-project-records";
import { SortableIdGenerator } from "@zet-harness/db/sortable-id";
import type { AdapterInvocationContext, JsonObject } from "@zet-harness/plugin-api";
import { checkNodeBehaviorPolicy } from "@zet-harness/plugin-api/node-behavior-policy";

import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import {
  GOAL_ACTION_TOOL_IDS,
  createGoalActionTools,
  goalActionToolSpecifications,
} from "./runtime-goal-actions.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function invocation(logicalEffectId: string): AdapterInvocationContext {
  return {
    runId: "run-test",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId,
    signal: new AbortController().signal,
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => 0,
    },
  };
}

function setup() {
  const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  database.open();
  runSqliteMigrations(database.connection(), RUNTIME_DATABASE_MIGRATIONS);
  databases.push(database);
  const ids = new SortableIdGenerator({ now: () => 1_000 });
  const { projectId } = createProject(database.connection(), {
    projectId: ids.next(),
    name: "Agent project",
    nowMs: 1,
  });
  let clock = 10;
  const tools = createGoalActionTools({
    database,
    projectId,
    now: () => {
      clock += 1;
      return clock;
    },
    createId: () => ids.next(),
  });
  let effects = 0;
  const call = async (
    toolId: string,
    input: JsonObject,
    logicalEffectId?: string,
  ): Promise<Record<string, unknown>> => {
    const tool = tools.find((candidate) => candidate.manifest.id === toolId);
    if (tool === undefined) throw new Error(`No tool ${toolId}.`);
    effects += 1;
    const effect = logicalEffectId ?? `zet-effect-v1:call-${String(effects)}`;
    return (await tool.invoke(input, invocation(effect))).value as Record<string, unknown>;
  };
  return { database, ids, projectId, tools, call };
}

const idOf = (reply: Record<string, unknown>, key: string, field: string): string =>
  (reply[key] as Record<string, string>)[field] ?? "";

describe("model-visible goal and todo actions", () => {
  it("offers every action to models under a provider-safe name with a strict schema", () => {
    const { tools } = setup();
    const specifications = goalActionToolSpecifications(tools);

    expect(specifications.map((specification) => specification.name)).toEqual([
      "harness_goals_list",
      "harness_goals_get",
      "harness_goals_create",
      "harness_goals_set-status",
      "harness_todos_create",
      "harness_todos_update",
      "harness_todos_set-status",
      "harness_todos_next",
    ]);
    for (const specification of specifications) {
      expect(specification.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
      expect(typeof specification.description).toBe("string");
      expect(specification.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
    for (const tool of tools) {
      expect(checkNodeBehaviorPolicy(tool.manifest.behavior).valid).toBe(true);
    }
  });

  it("lets a model plan a goal, work through its todos in order and complete it", async () => {
    const { call } = setup();

    const created = await call(GOAL_ACTION_TOOL_IDS.createGoal, {
      title: "Ship the landing page",
      priority: 5,
    });
    expect(created).toMatchObject({
      ok: true,
      goal: { title: "Ship the landing page", status: "open", priority: 5 },
    });
    const goalId = idOf(created, "goal", "goalId");
    const designId = idOf(
      await call(GOAL_ACTION_TOOL_IDS.createTodo, { goalId, title: "Design" }),
      "todo",
      "todoId",
    );
    const buildId = idOf(
      await call(GOAL_ACTION_TOOL_IDS.createTodo, {
        goalId,
        title: "Build",
        dependsOn: [designId],
      }),
      "todo",
      "todoId",
    );

    expect(await call(GOAL_ACTION_TOOL_IDS.nextTodo, {})).toMatchObject({
      ok: true,
      todo: { todoId: designId },
      goal: { goalId },
    });
    expect(
      await call(GOAL_ACTION_TOOL_IDS.setTodoStatus, { todoId: designId, status: "in_progress" }),
    ).toMatchObject({ ok: true, todo: { status: "in_progress" } });
    await call(GOAL_ACTION_TOOL_IDS.setTodoStatus, { todoId: designId, status: "done" });
    expect(await call(GOAL_ACTION_TOOL_IDS.nextTodo, { goalId })).toMatchObject({
      todo: { todoId: buildId },
    });
    await call(GOAL_ACTION_TOOL_IDS.updateTodo, { todoId: buildId, title: "Build the page" });
    await call(GOAL_ACTION_TOOL_IDS.setTodoStatus, { todoId: buildId, status: "done" });
    expect(await call(GOAL_ACTION_TOOL_IDS.nextTodo, {})).toEqual({
      ok: true,
      todo: null,
      goal: null,
    });

    expect(
      await call(GOAL_ACTION_TOOL_IDS.setGoalStatus, { goalId, status: "completed" }),
    ).toMatchObject({ ok: true, goal: { status: "completed" } });
    const read = await call(GOAL_ACTION_TOOL_IDS.getGoal, { goalId });
    expect(
      (read["todos"] as { readonly title: string; readonly status: string }[]).map((todo) => [
        todo.title,
        todo.status,
      ]),
    ).toEqual([
      ["Design", "done"],
      ["Build the page", "done"],
    ]);
    expect(
      (await call(GOAL_ACTION_TOOL_IDS.listGoals, { status: "completed" }))["goals"],
    ).toHaveLength(1);
  });

  it("returns refusals a model can act on, and a refused action changes nothing", async () => {
    const { call, database, ids } = setup();
    const goalId = idOf(
      await call(GOAL_ACTION_TOOL_IDS.createGoal, { title: "Goal" }),
      "goal",
      "goalId",
    );

    expect(
      await call(GOAL_ACTION_TOOL_IDS.setGoalStatus, { goalId, status: "blocked" }),
    ).toMatchObject({
      ok: false,
      error: { code: "GOAL_INVALID", field: "reason" },
    });
    await call(GOAL_ACTION_TOOL_IDS.setGoalStatus, {
      goalId,
      status: "blocked",
      reason: "Waiting",
    });
    expect(
      await call(GOAL_ACTION_TOOL_IDS.setGoalStatus, { goalId, status: "completed" }),
    ).toMatchObject({
      ok: false,
      error: { code: "GOAL_TRANSITION_INVALID" },
    });
    expect(await call(GOAL_ACTION_TOOL_IDS.createGoal, {})).toMatchObject({
      ok: false,
      error: { code: "ACTION_INPUT_INVALID", field: "title" },
    });
    expect(
      await call(GOAL_ACTION_TOOL_IDS.createGoal, { title: "x", colour: "red" }),
    ).toMatchObject({
      ok: false,
      error: { field: "colour" },
    });
    expect(
      await call(GOAL_ACTION_TOOL_IDS.createTodo, { goalId, title: "t", dependsOn: [ids.next()] }),
    ).toMatchObject({ ok: false, error: { code: "GOAL_INVALID", field: "dependsOn" } });
    expect(listTodos(database.connection(), goalId)).toEqual([]);

    const other = createProject(database.connection(), {
      projectId: ids.next(),
      name: "Other",
      nowMs: 1,
    });
    const foreign = createGoal(database.connection(), {
      goalId: ids.next(),
      projectId: other.projectId,
      title: "Not this project's",
      nowMs: 1,
    });
    expect(await call(GOAL_ACTION_TOOL_IDS.getGoal, { goalId: foreign.goalId })).toMatchObject({
      ok: false,
      error: { code: "GOAL_NOT_FOUND" },
    });
    expect(
      await call(GOAL_ACTION_TOOL_IDS.setGoalStatus, {
        goalId: foreign.goalId,
        status: "cancelled",
      }),
    ).toMatchObject({ ok: false, error: { code: "GOAL_NOT_FOUND" } });
    expect(readGoal(database.connection(), foreign.goalId)?.status).toBe("open");
  });

  it("applies a retried write once and answers the retry with the recorded result", async () => {
    const { call, database, projectId } = setup();

    const first = await call(
      GOAL_ACTION_TOOL_IDS.createGoal,
      { title: "Once" },
      "zet-effect-v1:retry",
    );
    const retried = await call(
      GOAL_ACTION_TOOL_IDS.createGoal,
      { title: "Once" },
      "zet-effect-v1:retry",
    );
    expect(retried).toEqual(first);
    expect(listGoals(database.connection(), projectId)).toHaveLength(1);

    await call(
      GOAL_ACTION_TOOL_IDS.createGoal,
      { title: "Different input" },
      "zet-effect-v1:retry",
    );
    expect(listGoals(database.connection(), projectId)).toHaveLength(2);

    const refused = await call(
      GOAL_ACTION_TOOL_IDS.createGoal,
      { title: " " },
      "zet-effect-v1:refused",
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "GOAL_INVALID" } });
    expect(
      await call(GOAL_ACTION_TOOL_IDS.createGoal, { title: " " }, "zet-effect-v1:refused"),
    ).toEqual(refused);
  });
});
