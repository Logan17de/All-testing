import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CapabilityPermissionPolicy, PluginHost } from "@zet-harness/core";
import { SQLITE_MEMORY_PATH, SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";
import type { HarnessPlugin, NodeBehavior, NodeDefinition } from "@zet-harness/plugin-api";

import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { compileEditorGraph, createRunFromCompiledGraph } from "./runtime-graphs.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import { verifyCompiledPlanIdentity, type RuntimeNodeResolver } from "./runtime-plan-identity.js";
import { createPluginNodeExecutor } from "./runtime-plugin-executor.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";
import { RuntimeRunDispatcher } from "./runtime-run-dispatcher.js";

const cleanups: (() => unknown)[] = [];
const calls: string[] = [];

const PLUGIN_ID = "test.identity";
const PLUGIN_VERSION = "1.0.0";

beforeEach(() => {
  calls.length = 0;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PURE: NodeBehavior = {
  primitiveFamily: "pure",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "rerun",
  executionMode: "in-process",
  requiredCapabilities: [],
};

const shout: NodeDefinition = {
  manifest: {
    type: "test.shout",
    version: "1",
    title: "Shout",
    inputs: { value: { schema: { type: "string" }, required: true } },
    outputs: { value: { schema: { type: "string" } } },
    configSchema: { type: "object", additionalProperties: false },
    behavior: PURE,
  },
  execute: (request) => {
    calls.push("shout");
    const value = request.inputs["value"];
    return { outputs: { value: `${typeof value === "string" ? value.toUpperCase() : ""}!` } };
  },
};

const testPlugin: HarnessPlugin = {
  manifest: {
    id: PLUGIN_ID,
    name: "Plan identity test nodes",
    version: PLUGIN_VERSION,
    apiVersion: 1,
  },
  activate(context) {
    context.nodes.register(shout);
  },
};

/** One node whose input is the literal "hi", so the stored plan contains that value. */
const GRAPH: GraphJsonV1 = {
  schemaVersion: GRAPH_JSON_VERSION,
  graphId: "identity-graph",
  revisionId: "rev-1",
  inputs: [],
  outputs: [{ id: "result", schema: true, source: { nodeId: "loud", port: "value" } }],
  nodes: [
    {
      id: "loud",
      type: "test.shout",
      version: "1",
      config: {},
      bindings: [{ kind: "literal", port: "value", value: "hi" }],
    },
  ],
  edges: [],
  entrypoints: [{ id: "main", nodeId: "loud" }],
  policies: {
    maxNodeExecutions: 5,
    maxParallelism: 1,
    capabilities: { required: [], optional: [], deny: [] },
  },
  options: { defaultEntrypoint: "main" },
};

async function runtime(resolveNode?: RuntimeNodeResolver) {
  const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  database.open();
  cleanups.push(() => {
    database.close();
  });
  runSqliteMigrations(database.connection(), RUNTIME_DATABASE_MIGRATIONS);
  const host = new PluginHost();
  cleanups.push(() => host.dispose());
  await host.activate(testPlugin);

  const authority = new CapabilityPermissionPolicy();
  const redaction = new RuntimeRedactionRegistry();
  const approvals = new RuntimeHumanApprovals(database, {
    redaction,
    authority,
    onResolved: () => undefined,
  });
  const dispatcher = new RuntimeRunDispatcher(
    database,
    approvals,
    {
      execute: createPluginNodeExecutor({ host }),
      ...(resolveNode === undefined ? {} : { resolveNode }),
    },
    redaction,
    authority,
  );
  cleanups.push(() => dispatcher.stop());
  dispatcher.start();

  const start = async (): Promise<string> => {
    const compiled = await compileEditorGraph(GRAPH, { host }, authority);
    if (!compiled.valid) throw new Error(JSON.stringify(compiled.diagnostics));
    return (await createRunFromCompiledGraph(database, compiled.compiled)).runId;
  };
  return { database, dispatcher, start };
}

function statusOf(database: SqliteDatabase, runId: string): string {
  return (
    database.connection().prepare("SELECT status FROM runs WHERE run_id = ?").get(runId) as {
      readonly status: string;
    }
  ).status;
}

function eventTypes(database: SqliteDatabase, runId: string): string[] {
  return (
    database
      .connection()
      .prepare("SELECT event_type AS type FROM durable_events WHERE run_id = ? ORDER BY event_id")
      .all(runId) as unknown as { readonly type: string }[]
  ).map((row) => row.type);
}

function issuesOf(database: SqliteDatabase, runId: string): { readonly code: string }[] {
  const row = database
    .connection()
    .prepare(
      "SELECT payload_json AS payload FROM durable_events WHERE run_id = ? ORDER BY event_id DESC LIMIT 1",
    )
    .get(runId) as { readonly payload: string };
  return (JSON.parse(row.payload) as { readonly issues: { readonly code: string }[] }).issues;
}

describe("plan identity before resuming (9.4)", () => {
  it("refuses a run whose stored plan no longer matches what it was compiled from", async () => {
    const { database, dispatcher, start } = await runtime();
    const runId = await start();

    // The plan is meant to be immutable. Change the work it describes.
    const plan = database
      .connection()
      .prepare("SELECT compiled_plan_id AS id, execution_ir_json AS json FROM compiled_plans")
      .get() as { readonly id: number; readonly json: string };
    expect(plan.json).toContain('"hi"');
    database
      .connection()
      .prepare("UPDATE compiled_plans SET execution_ir_json = ? WHERE compiled_plan_id = ?")
      .run(plan.json.replace('"hi"', '"edited"'), plan.id);

    expect(await dispatcher.dispatch(runId)).toEqual({
      runId,
      status: "recovery-required",
      code: "RUNTIME_PLAN_IDENTITY_CHANGED",
    });
    expect(calls).toEqual([]);
    expect(statusOf(database, runId)).toBe("pending");
    expect(eventTypes(database, runId)).toEqual(["harness.run.identity-mismatch"]);
    expect(issuesOf(database, runId)[0]?.code).toBe("PLAN_IR_CHANGED");

    // Waking the run again refuses it again without repeating the entry.
    expect((await dispatcher.dispatch(runId)).code).toBe("RUNTIME_PLAN_IDENTITY_CHANGED");
    expect(eventTypes(database, runId)).toEqual(["harness.run.identity-mismatch"]);
  });

  it("refuses a run whose node now comes from different code, or from nothing", async () => {
    let resolution: ReturnType<RuntimeNodeResolver> = {
      pluginId: PLUGIN_ID,
      pluginVersion: "2.0.0",
    };
    const { database, dispatcher, start } = await runtime(() => resolution);

    const upgraded = await start();
    expect((await dispatcher.dispatch(upgraded)).code).toBe("RUNTIME_PLAN_IDENTITY_CHANGED");
    expect(calls).toEqual([]);
    expect(issuesOf(database, upgraded)[0]?.code).toBe("PLAN_PLUGIN_CHANGED");

    resolution = undefined;
    const removed = await start();
    expect((await dispatcher.dispatch(removed)).code).toBe("RUNTIME_PLAN_IDENTITY_CHANGED");
    expect(issuesOf(database, removed)[0]?.code).toBe("PLAN_NODE_UNAVAILABLE");
    expect(statusOf(database, removed)).toBe("pending");
  });

  it("runs normally while the plan and the plugin behind it are unchanged", async () => {
    const { database, dispatcher, start } = await runtime(() => ({
      pluginId: PLUGIN_ID,
      pluginVersion: PLUGIN_VERSION,
    }));
    const runId = await start();

    expect((await dispatcher.dispatch(runId)).status).toBe("completed");
    expect(calls).toEqual(["shout"]);
    expect(eventTypes(database, runId)).not.toContain("harness.run.identity-mismatch");

    const planId = (
      database.connection().prepare("SELECT compiled_plan_id AS id FROM compiled_plans").get() as {
        readonly id: number;
      }
    ).id;
    expect(await verifyCompiledPlanIdentity(database.connection(), planId)).toMatchObject({
      ok: true,
      issues: [],
    });
    expect(await verifyCompiledPlanIdentity(database.connection(), planId + 1000)).toMatchObject({
      ok: false,
      issues: [{ code: "PLAN_UNAVAILABLE" }],
    });
  });
});
