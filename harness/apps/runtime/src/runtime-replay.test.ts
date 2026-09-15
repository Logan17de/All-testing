import { afterEach, describe, expect, it } from "vitest";

import {
  CapabilityPermissionPolicy,
  LOOP_NODE_TYPE,
  PluginHost,
  createControlFlowPlugin,
} from "@zet-harness/core";
import { SQLITE_MEMORY_PATH, SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";
import type { HarnessPlugin, NodeBehavior, NodeDefinition } from "@zet-harness/plugin-api";

import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import {
  RuntimeGraphError,
  compileEditorGraph,
  createRunFromCompiledGraph,
} from "./runtime-graphs.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import { createPluginNodeExecutor } from "./runtime-plugin-executor.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";
import { replayRecordedRun } from "./runtime-replay.js";
import { RuntimeRunDispatcher } from "./runtime-run-dispatcher.js";

const cleanups: (() => unknown)[] = [];

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

const text = { schema: { type: "string" } } as const;

/** Every node execution, so a test can prove replay calls none. */
const calls: string[] = [];

const nodes: readonly NodeDefinition[] = [
  {
    manifest: {
      type: "test.emit",
      version: "1",
      title: "Emit",
      inputs: {},
      outputs: { value: text },
      configSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      behavior: PURE,
    },
    execute: (request) => {
      calls.push("emit");
      return { outputs: { value: request.config["value"] ?? "" } };
    },
  },
  {
    manifest: {
      type: "test.shout",
      version: "1",
      title: "Shout",
      inputs: { value: { schema: { type: "string" }, required: true } },
      outputs: { value: text },
      configSchema: { type: "object", additionalProperties: false },
      behavior: PURE,
    },
    execute: (request) => {
      calls.push("shout");
      const value = request.inputs["value"];
      return { outputs: { value: `${typeof value === "string" ? value.toUpperCase() : ""}!` } };
    },
  },
  {
    manifest: {
      type: "test.fail",
      version: "1",
      title: "Fail",
      inputs: {},
      outputs: { value: text },
      configSchema: { type: "object", additionalProperties: false },
      behavior: PURE,
    },
    execute: () => {
      calls.push("fail");
      throw new Error("This node always fails.");
    },
  },
  {
    manifest: {
      type: "test.flag",
      version: "1",
      title: "Flag",
      inputs: {},
      outputs: { again: { schema: { type: "boolean" } } },
      configSchema: {
        type: "object",
        properties: { value: { type: "boolean" } },
        required: ["value"],
        additionalProperties: false,
      },
      behavior: PURE,
    },
    execute: (request) => {
      calls.push("flag");
      return { outputs: { again: request.config["value"] === true } };
    },
  },
];

const testPlugin: HarnessPlugin = {
  manifest: { id: "test.replay", name: "Replay test nodes", version: "1.0.0", apiVersion: 1 },
  activate(context) {
    for (const node of nodes) context.nodes.register(node);
  },
};

function graph(
  graphId: string,
  graphNodes: GraphJsonV1["nodes"],
  edges: GraphJsonV1["edges"],
  output: { readonly nodeId: string; readonly port: string },
): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId,
    revisionId: "rev-1",
    inputs: [],
    outputs: [{ id: "result", schema: true, source: output }],
    nodes: graphNodes,
    edges,
    entrypoints: [{ id: "main", nodeId: "source" }],
    policies: {
      maxNodeExecutions: 30,
      maxParallelism: 1,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
  };
}

/** source("hi") → loud */
const chainGraph = graph(
  "replay-chain",
  [
    { id: "source", type: "test.emit", version: "1", config: { value: "hi" } },
    { id: "loud", type: "test.shout", version: "1", config: {} },
  ],
  [
    {
      id: "value",
      kind: "data",
      from: { nodeId: "source", port: "value" },
      to: { nodeId: "loud", port: "value" },
    },
  ],
  { nodeId: "loud", port: "value" },
);

/** source → broken */
const failingGraph = graph(
  "replay-failing",
  [
    { id: "source", type: "test.emit", version: "1", config: { value: "hi" } },
    { id: "broken", type: "test.fail", version: "1", config: {} },
  ],
  [{ id: "then", kind: "control", from: { nodeId: "source" }, to: { nodeId: "broken" } }],
  { nodeId: "broken", port: "value" },
);

/** source → loop(3) ─body→ loud → keepGoing ─repeat→ loop ─done→ finish; source.value feeds loud */
const loopGraph = graph(
  "replay-loop",
  [
    { id: "source", type: "test.emit", version: "1", config: { value: "hi" } },
    { id: "loop", type: LOOP_NODE_TYPE, version: "1", config: { maxIterations: 3 } },
    { id: "loud", type: "test.shout", version: "1", config: {} },
    { id: "keepGoing", type: "test.flag", version: "1", config: { value: true } },
    { id: "finish", type: "test.emit", version: "1", config: { value: "done" } },
  ],
  [
    {
      id: "enter",
      kind: "control",
      from: { nodeId: "source" },
      to: { nodeId: "loop", port: "in" },
    },
    { id: "body", kind: "control", from: { nodeId: "loop", port: "body" }, to: { nodeId: "loud" } },
    {
      id: "value",
      kind: "data",
      from: { nodeId: "source", port: "value" },
      to: { nodeId: "loud", port: "value" },
    },
    { id: "then", kind: "control", from: { nodeId: "loud" }, to: { nodeId: "keepGoing" } },
    {
      id: "repeat",
      kind: "control",
      from: { nodeId: "keepGoing" },
      to: { nodeId: "loop", port: "repeat" },
    },
    {
      id: "again",
      kind: "data",
      from: { nodeId: "keepGoing", port: "again" },
      to: { nodeId: "loop", port: "again" },
    },
    {
      id: "done",
      kind: "control",
      from: { nodeId: "loop", port: "done" },
      to: { nodeId: "finish" },
    },
  ],
  { nodeId: "finish", port: "value" },
);

async function runGraph(source: GraphJsonV1) {
  const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  database.open();
  cleanups.push(() => {
    database.close();
  });
  runSqliteMigrations(database.connection(), RUNTIME_DATABASE_MIGRATIONS);
  const host = new PluginHost();
  cleanups.push(() => host.dispose());
  await host.activate(testPlugin);
  await host.activate(createControlFlowPlugin());

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
    { execute: createPluginNodeExecutor({ host }) },
    redaction,
    authority,
  );
  cleanups.push(() => dispatcher.stop());
  dispatcher.start();

  const compiled = await compileEditorGraph(source, { host }, authority);
  if (!compiled.valid) throw new Error(JSON.stringify(compiled.diagnostics));
  const { runId } = await createRunFromCompiledGraph(database, compiled.compiled);
  const report = await dispatcher.dispatch(runId);
  return { database, runId, report };
}

describe("recorded replay (9.1)", () => {
  it("replays a finished run from its records, deriving inputs, and runs nothing", async () => {
    calls.length = 0;
    const { database, runId, report } = await runGraph(chainGraph);
    expect(report.status).toBe("completed");
    const connection = database.connection();
    const executed = calls.length;
    const counts = () =>
      connection
        .prepare(
          `SELECT (SELECT COUNT(*) FROM durable_events WHERE run_id = ?) AS events,
             (SELECT COUNT(*) FROM node_attempts WHERE run_id = ?) AS attempts`,
        )
        .get(runId, runId);
    const before = counts();

    const replay = replayRecordedRun(connection, runId);

    expect(replay).toMatchObject({
      runId,
      graphId: "replay-chain",
      status: "completed",
      consistent: true,
      issues: [],
    });
    expect(replay.steps.map((step) => [step.kind, step.nodeId, step.outcome])).toEqual([
      ["attempt", "source", "completed"],
      ["attempt", "loud", "completed"],
      ["run", null, "completed"],
    ]);
    expect(replay.steps[1]?.detail).toMatchObject({
      inputs: { value: "hi" },
      outputs: { value: "HI!" },
    });
    expect(replayRecordedRun(connection, runId)).toEqual(replay);
    expect(counts()).toEqual(before);
    expect(calls).toHaveLength(executed);
  });

  it("replays every loop iteration, each loop decision and why the loop ended", async () => {
    const { database, runId, report } = await runGraph(loopGraph);
    expect(report.status).toBe("completed");

    const replay = replayRecordedRun(database.connection(), runId);

    expect(replay.consistent).toBe(true);
    expect(
      replay.steps
        .filter((step) => step.kind !== "attempt" || step.nodeId === "loud")
        .map((step) => [step.kind, step.nodeId, step.iteration, step.outcome]),
    ).toEqual([
      ["loop", "loop", 0, "entered"],
      ["attempt", "loud", 0, "completed"],
      ["loop", "loop", 0, "continue"],
      ["attempt", "loud", 1, "completed"],
      ["loop", "loop", 1, "continue"],
      ["attempt", "loud", 2, "completed"],
      ["loop", "loop", 2, "exit"],
      ["run", null, null, "completed"],
    ]);
    expect(replay.steps.find((step) => step.outcome === "exit")?.detail).toEqual({
      reason: "max-iterations",
    });
    expect(
      replay.steps.filter((step) => step.nodeId === "loud").map((step) => step.detail),
    ).toEqual(
      Array.from({ length: 3 }, (): unknown =>
        expect.objectContaining({ inputs: { value: "hi" }, outputs: { value: "HI!" } }),
      ),
    );
  });

  it("replays a failed attempt and the failed run", async () => {
    const { database, runId, report } = await runGraph(failingGraph);
    expect(report.status).toBe("failed");

    const replay = replayRecordedRun(database.connection(), runId);

    expect(replay.consistent).toBe(true);
    expect(replay.steps.map((step) => [step.kind, step.nodeId, step.outcome])).toEqual([
      ["attempt", "source", "completed"],
      ["attempt", "broken", "failed"],
      ["run", null, "failed"],
    ]);
    expect(replay.steps[1]?.detail).toMatchObject({ error: { code: "RUNTIME_EXECUTION_FAILED" } });
  });

  it("refuses a run that does not exist", async () => {
    const { database } = await runGraph(chainGraph);
    let error: unknown;
    try {
      replayRecordedRun(database.connection(), "run-missing");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RuntimeGraphError);
    expect(error).toMatchObject({ code: "RUN_NOT_FOUND" });
  });
});
