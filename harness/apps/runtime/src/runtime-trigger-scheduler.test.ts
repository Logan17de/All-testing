import { afterEach, describe, expect, it } from "vitest";

import { CapabilityPermissionPolicy, PluginHost, createControlFlowPlugin } from "@zet-harness/core";
import { SQLITE_MEMORY_PATH, SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { listTriggerFires } from "@zet-harness/db/durable-trigger-fire-records";
import { createTrigger, readTrigger, updateTrigger } from "@zet-harness/db/durable-trigger-records";
import { SortableIdGenerator } from "@zet-harness/db/sortable-id";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";

import { nextCronFireAtMs, parseCronExpression } from "./runtime-cron.js";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { compileEditorGraph, storeCompiledGraph } from "./runtime-graphs.js";
import { RuntimeTriggerScheduler } from "./runtime-trigger-scheduler.js";

const hosts: PluginHost[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const database of databases.splice(0)) database.close();
});

const GRAPH: GraphJsonV1 = {
  schemaVersion: GRAPH_JSON_VERSION,
  graphId: "scheduled-graph",
  revisionId: "rev-1",
  inputs: [],
  outputs: [{ id: "result", schema: true, source: { nodeId: "check", port: "branch" } }],
  nodes: [
    {
      id: "check",
      type: "harness.condition",
      version: "1",
      config: { operator: "equals", compare: "go" },
      bindings: [{ kind: "literal", port: "value", value: "go" }],
    },
  ],
  edges: [],
  entrypoints: [{ id: "main", nodeId: "check" }],
  policies: {
    maxNodeExecutions: 5,
    maxParallelism: 1,
    capabilities: { required: [], optional: [], deny: [] },
  },
  options: { defaultEntrypoint: "main" },
};

const NOON = Date.parse("2026-09-16T12:00:00.000Z");

async function setup() {
  const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  database.open();
  runSqliteMigrations(database.connection(), RUNTIME_DATABASE_MIGRATIONS);
  databases.push(database);

  const host = new PluginHost();
  hosts.push(host);
  await host.activate(createControlFlowPlugin());
  const authority = new CapabilityPermissionPolicy();
  const compiled = await compileEditorGraph(GRAPH, { host }, authority);
  if (!compiled.valid) throw new Error(JSON.stringify(compiled.diagnostics));
  const plan = await storeCompiledGraph(database, compiled.compiled, 1);

  const ids = new SortableIdGenerator({ now: () => 1_000 });
  let now = NOON;
  const woken: string[] = [];
  const scheduler = new RuntimeTriggerScheduler({
    database,
    dispatch: (runId) => woken.push(runId),
    now: () => now,
    createId: () => ids.next(),
  });

  const addCron = (cron: string, dueAtMs: number) =>
    createTrigger(database.connection(), {
      triggerId: ids.next(),
      name: `Every ${cron}`,
      kind: "cron",
      documentHash: plan.documentHash,
      compiledPlanId: plan.compiledPlanId,
      cronExpression: cron,
      nextFireAtMs: dueAtMs,
      nowMs: 1,
    });

  return {
    database,
    scheduler,
    addCron,
    woken,
    ids,
    at: (ms: number) => {
      now = ms;
    },
  };
}

function runCount(database: SqliteDatabase): number {
  return (
    database.connection().prepare("SELECT COUNT(*) AS count FROM runs").get() as {
      readonly count: number;
    }
  ).count;
}

describe("firing cron triggers when they come due (9.10)", () => {
  it("leaves a trigger alone until its time, then fires it once and moves it on", async () => {
    const { database, scheduler, addCron, woken, at } = await setup();
    const due = nextCronFireAtMs(parseCronExpression("0 * * * *"), NOON)!;
    const trigger = addCron("0 * * * *", due);

    at(due - 60_000);
    const early = await scheduler.tick();
    expect(early.runIds).toEqual([]);
    expect(runCount(database)).toBe(0);
    expect(early.nextDueAtMs).toBe(due);

    at(due);
    const fired = await scheduler.tick();
    expect(fired.runIds).toHaveLength(1);
    expect(woken).toEqual(fired.runIds);
    expect(runCount(database)).toBe(1);

    const after = readTrigger(database.connection(), trigger.triggerId);
    expect(after?.lastRunId).toBe(fired.runIds[0]);
    expect(after?.nextFireAtMs).toBe(due + 3_600_000);
    expect(listTriggerFires(database.connection(), trigger.triggerId)).toMatchObject([
      { reason: "cron", dedupeKey: `cron:${String(due)}`, runId: fired.runIds[0] },
    ]);

    // The same moment again starts nothing new: it is no longer due.
    expect((await scheduler.tick()).runIds).toEqual([]);
    expect(runCount(database)).toBe(1);
  });

  it("fires a trigger the daemon was down for once, not once per missed tick", async () => {
    const { database, scheduler, addCron, at } = await setup();
    // Due four hours ago, on an hourly schedule: four ticks were missed.
    const missed = NOON - 4 * 3_600_000;
    const trigger = addCron("0 * * * *", missed);

    at(NOON);
    const caughtUp = await scheduler.tick();

    expect(caughtUp.runIds).toHaveLength(1);
    expect(runCount(database)).toBe(1);
    // It carries on from now rather than replaying the hours it missed.
    expect(readTrigger(database.connection(), trigger.triggerId)?.nextFireAtMs).toBe(
      NOON + 3_600_000,
    );
  });

  it("starts one run when the same tick is fired twice", async () => {
    const { database, scheduler, addCron, at } = await setup();
    const due = NOON - 1_000;
    const trigger = addCron("0 * * * *", due);
    at(NOON);

    const first = await scheduler.tick();
    expect(first.runIds).toHaveLength(1);

    // Put the trigger back to the tick it just fired, as a repeated pass would find it.
    updateTrigger(database.connection(), trigger.triggerId, {
      nextFireAtMs: due,
      nowMs: NOON,
    });
    const second = await scheduler.tick();

    expect(second.runIds).toEqual([]);
    expect(second.duplicates).toBe(1);
    expect(runCount(database)).toBe(1);
    // The duplicate still moved it on, so it does not stay due for ever.
    expect(readTrigger(database.connection(), trigger.triggerId)?.nextFireAtMs).toBeGreaterThan(
      NOON,
    );
  });

  it("ignores triggers that are turned off", async () => {
    const { database, scheduler, addCron, at } = await setup();
    const trigger = addCron("0 * * * *", NOON - 1_000);
    updateTrigger(database.connection(), trigger.triggerId, { enabled: false, nowMs: NOON });
    at(NOON);

    const pass = await scheduler.tick();

    expect(pass.runIds).toEqual([]);
    expect(pass.nextDueAtMs).toBeUndefined();
    expect(runCount(database)).toBe(0);
  });

  it("fires the earliest due trigger first and reports when the next one is", async () => {
    const { database, scheduler, addCron, at } = await setup();
    const later = addCron("0 * * * *", NOON - 1_000);
    const earlier = addCron("*/30 * * * *", NOON - 5_000);
    at(NOON);

    const pass = await scheduler.tick();

    expect(pass.runIds).toHaveLength(2);
    const fires = [earlier, later].map(
      (trigger) => listTriggerFires(database.connection(), trigger.triggerId)[0]?.runId,
    );
    expect(fires).toEqual(pass.runIds);
    expect(pass.nextDueAtMs).toBe(
      Math.min(
        readTrigger(database.connection(), earlier.triggerId)?.nextFireAtMs ?? 0,
        readTrigger(database.connection(), later.triggerId)?.nextFireAtMs ?? 0,
      ),
    );
  });
});
