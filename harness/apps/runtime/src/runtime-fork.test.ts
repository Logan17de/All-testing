import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CapabilityPermissionPolicy,
  LOOP_NODE_TYPE,
  PluginHost,
  createControlFlowPlugin,
  createHumanApprovalPlugin,
} from "@zet-harness/core";
import { SQLITE_MEMORY_PATH, SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";
import type { HarnessPlugin, NodeBehavior, NodeDefinition } from "@zet-harness/plugin-api";

import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { forkRun } from "./runtime-fork.js";
import { compileEditorGraph, createRunFromCompiledGraph } from "./runtime-graphs.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import { currentOps } from "./runtime-iteration-frontier.js";
import { createPluginNodeExecutor } from "./runtime-plugin-executor.js";
import { reconstructExecutionFrontier } from "./runtime-recovery.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";
import { replayRecordedRun } from "./runtime-replay.js";
import { RuntimeRunDispatcher } from "./runtime-run-dispatcher.js";

const cleanups: (() => unknown)[] = [];

/** Every node execution, so a test can prove what a fork ran again. */
const calls: string[] = [];
let flakyFails = true;

beforeEach(() => {
  calls.length = 0;
  flakyFails = true;
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

const text = { schema: { type: "string" } } as const;

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
      const configured = request.config["value"];
      const value = typeof configured === "string" ? configured : "";
      calls.push(`emit:${value}`);
      return { outputs: { value } };
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
      type: "test.flaky",
      version: "1",
      title: "Flaky",
      inputs: {},
      outputs: { value: text },
      configSchema: { type: "object", additionalProperties: false },
      behavior: PURE,
    },
    execute: () => {
      if (flakyFails) {
        calls.push("flaky:failed");
        throw new Error("Not yet.");
      }
      calls.push("flaky");
      return { outputs: { value: "ok" } };
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
  manifest: { id: "test.fork", name: "Fork test nodes", version: "1.0.0", apiVersion: 1 },
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
  "fork-chain",
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

/** source → broken, which fails while `flakyFails` is set */
const failingGraph = graph(
  "fork-failing",
  [
    { id: "source", type: "test.emit", version: "1", config: { value: "hi" } },
    { id: "broken", type: "test.flaky", version: "1", config: {} },
  ],
  [{ id: "then", kind: "control", from: { nodeId: "source" }, to: { nodeId: "broken" } }],
  { nodeId: "broken", port: "value" },
);

/** source → gate (approval) → loud; source.value feeds loud */
const gateGraph = graph(
  "fork-gate",
  [
    { id: "source", type: "test.emit", version: "1", config: { value: "hi" } },
    {
      id: "gate",
      type: "harness.human-approval",
      version: "1",
      config: { prompt: "Shout it?" },
    },
    { id: "loud", type: "test.shout", version: "1", config: {} },
  ],
  [
    { id: "ask", kind: "control", from: { nodeId: "source" }, to: { nodeId: "gate" } },
    { id: "then", kind: "control", from: { nodeId: "gate" }, to: { nodeId: "loud" } },
    {
      id: "value",
      kind: "data",
      from: { nodeId: "source", port: "value" },
      to: { nodeId: "loud", port: "value" },
    },
  ],
  { nodeId: "loud", port: "value" },
);

/** source → loop(3) ─body→ loud → keepGoing ─repeat→ loop ─done→ finish; source.value feeds loud */
const loopGraph = graph(
  "fork-loop",
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

async function runtime() {
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
  await host.activate(createHumanApprovalPlugin());

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

  const start = async (source: GraphJsonV1): Promise<string> => {
    const compiled = await compileEditorGraph(source, { host }, authority);
    if (!compiled.valid) throw new Error(JSON.stringify(compiled.diagnostics));
    return (await createRunFromCompiledGraph(database, compiled.compiled)).runId;
  };
  return { database, approvals, dispatcher, start };
}

/** Every stored row of one run, to prove a fork writes nothing to its parent. */
function snapshot(database: SqliteDatabase, runId: string): string {
  const connection = database.connection();
  const rows = (sql: string): unknown[] => connection.prepare(sql).all(runId);
  return JSON.stringify({
    run: rows("SELECT * FROM runs WHERE run_id = ?"),
    events: rows("SELECT * FROM durable_events WHERE run_id = ? ORDER BY event_id"),
    invocations: rows(
      "SELECT * FROM node_invocations WHERE run_id = ? ORDER BY op_index, iteration",
    ),
    attempts: rows("SELECT * FROM node_attempts WHERE run_id = ? ORDER BY attempt_id"),
    checkpoints: rows("SELECT * FROM run_checkpoints WHERE run_id = ? ORDER BY checkpoint_id"),
    approvals: rows("SELECT * FROM approvals WHERE run_id = ? ORDER BY approval_id"),
  });
}

/** Node statuses by node id, now or as they stood just after one event. */
function statuses(
  database: SqliteDatabase,
  runId: string,
  throughEventId?: number,
): Record<string, string> {
  const frontier = reconstructExecutionFrontier(
    database.connection(),
    runId,
    throughEventId === undefined ? {} : { throughEventId },
  );
  const ir = frontier.executionIr as unknown as {
    readonly ops: readonly { readonly sourceNodeId: string }[];
  };
  return Object.fromEntries(
    currentOps(frontier).map((op) => [ir.ops[op.opIndex]!.sourceNodeId, op.status]),
  );
}

function outline(database: SqliteDatabase, runId: string): (string | null)[][] {
  return replayRecordedRun(database.connection(), runId).steps.map((step) => [
    step.kind,
    step.nodeId,
    step.outcome,
  ]);
}

/** The event id of the first replay step matching kind, node and outcome. */
function stepEvent(
  database: SqliteDatabase,
  runId: string,
  kind: string,
  nodeId: string,
  outcome: string,
): number {
  const step = replayRecordedRun(database.connection(), runId).steps.find(
    (candidate) =>
      candidate.kind === kind && candidate.nodeId === nodeId && candidate.outcome === outcome,
  );
  if (step === undefined) throw new Error(`No ${kind} step of ${nodeId} ${outcome}.`);
  return step.eventId;
}

function effectIds(database: SqliteDatabase, runId: string): string[] {
  return (
    database
      .connection()
      .prepare(
        "SELECT logical_effect_id AS id FROM node_invocations WHERE run_id = ? ORDER BY op_index",
      )
      .all(runId) as unknown as { readonly id: string }[]
  ).map((row) => row.id);
}

describe("forkRun (9.2)", () => {
  it("forks a finished run after its first node, reusing that result and running only the rest", async () => {
    const { database, dispatcher, start } = await runtime();
    const parent = await start(chainGraph);
    expect((await dispatcher.dispatch(parent)).status).toBe("completed");
    const cut = stepEvent(database, parent, "attempt", "source", "completed");
    const before = snapshot(database, parent);
    const parentReplay = replayRecordedRun(database.connection(), parent);
    calls.length = 0;

    const fork = await forkRun(database, parent, { throughEventId: cut });

    expect(fork).toMatchObject({
      parentRunId: parent,
      parentCheckpointId: null,
      reused: 1,
      rerun: 0,
    });
    expect(fork.runId).not.toBe(parent);
    // The cut moves past the frontier changes of the commit it fell in.
    expect(fork.throughEventId).toBeGreaterThan(cut);
    expect(statuses(database, parent, fork.throughEventId)).toEqual({
      source: "completed",
      loud: "ready",
    });
    expect(statuses(database, fork.runId)).toEqual({ source: "completed", loud: "ready" });
    const row = database
      .connection()
      .prepare(
        "SELECT status, parent_run_id AS parentRunId, fork_metadata_json AS metadata FROM runs WHERE run_id = ?",
      )
      .get(fork.runId) as {
      readonly status: string;
      readonly parentRunId: string;
      readonly metadata: string;
    };
    expect(row.status).toBe("pending");
    expect(row.parentRunId).toBe(parent);
    expect(JSON.parse(row.metadata)).toEqual({
      schemaVersion: 1,
      parentRunId: parent,
      throughEventId: fork.throughEventId,
      parentCheckpointId: null,
      checkpointId: fork.checkpointId,
    });

    expect((await dispatcher.dispatch(fork.runId)).status).toBe("completed");
    expect(calls).toEqual(["shout"]);

    const replay = replayRecordedRun(database.connection(), fork.runId);
    expect(replay.consistent).toBe(true);
    expect(outline(database, fork.runId)).toEqual([
      ["attempt", "source", "completed"],
      ["run", null, "forked"],
      ["attempt", "loud", "completed"],
      ["run", null, "completed"],
    ]);
    expect(replay.steps[1]?.detail).toEqual({
      parentRunId: parent,
      throughEventId: fork.throughEventId,
    });
    expect(replay.steps[2]?.detail).toMatchObject({
      inputs: { value: "hi" },
      outputs: { value: "HI!" },
    });

    // The reused node keeps its logical effect; the node that ran again got a new one.
    const parentEffects = effectIds(database, parent);
    const forkEffects = effectIds(database, fork.runId);
    expect(forkEffects).toHaveLength(2);
    expect(forkEffects.filter((id) => parentEffects.includes(id))).toHaveLength(1);

    expect(snapshot(database, parent)).toBe(before);
    expect(replayRecordedRun(database.connection(), parent)).toEqual(parentReplay);
  });

  it("retries a failed run from its latest event, running only the node that failed", async () => {
    const { database, dispatcher, start } = await runtime();
    const parent = await start(failingGraph);
    expect((await dispatcher.dispatch(parent)).status).toBe("failed");
    const before = snapshot(database, parent);
    flakyFails = false;
    calls.length = 0;

    const fork = await forkRun(database, parent);

    expect(fork).toMatchObject({ reused: 1, rerun: 1 });
    expect(statuses(database, fork.runId)).toEqual({ source: "completed", broken: "ready" });
    expect((await dispatcher.dispatch(fork.runId)).status).toBe("completed");
    expect(calls).toEqual(["flaky"]);
    expect(replayRecordedRun(database.connection(), fork.runId).consistent).toBe(true);
    expect(outline(database, fork.runId)).toEqual([
      ["attempt", "source", "completed"],
      ["run", null, "forked"],
      ["attempt", "broken", "completed"],
      ["run", null, "completed"],
    ]);
    expect(snapshot(database, parent)).toBe(before);
  });

  it("carries a running loop over and finishes its remaining iterations", async () => {
    const { database, dispatcher, start } = await runtime();
    const parent = await start(loopGraph);
    expect((await dispatcher.dispatch(parent)).status).toBe("completed");
    const cut = stepEvent(database, parent, "loop", "loop", "continue");
    const before = snapshot(database, parent);
    calls.length = 0;

    const fork = await forkRun(database, parent, { throughEventId: cut });

    expect(fork).toMatchObject({ reused: 3, rerun: 0 });
    expect(statuses(database, fork.runId)).toEqual({
      source: "completed",
      loop: "running",
      loud: "ready",
      keepGoing: "pending",
      finish: "pending",
    });
    expect((await dispatcher.dispatch(fork.runId)).status).toBe("completed");
    expect(calls).toEqual(["shout", "flag", "shout", "flag", "emit:done"]);

    const replay = replayRecordedRun(database.connection(), fork.runId);
    expect(replay.consistent).toBe(true);
    expect(
      replay.steps
        .filter((step) => step.kind === "loop")
        .map((step) => [step.outcome, step.detail]),
    ).toEqual([
      ["entered", {}],
      ["continue", {}],
      ["continue", {}],
      ["exit", { reason: "max-iterations" }],
    ]);
    expect(replay.steps.filter((step) => step.nodeId === "loud")).toHaveLength(3);
    expect(snapshot(database, parent)).toBe(before);
  });

  it("asks again in the fork when the parent waits for approval, leaving the parent's request alone", async () => {
    const { database, approvals, dispatcher, start } = await runtime();
    const parent = await start(gateGraph);
    expect((await dispatcher.dispatch(parent)).status).toBe("waiting");
    const [parentRequest] = approvals.listPending(parent);
    expect(parentRequest).toBeDefined();
    const before = snapshot(database, parent);
    calls.length = 0;

    const fork = await forkRun(database, parent);

    expect(fork).toMatchObject({ reused: 1, rerun: 1 });
    expect(fork.parentCheckpointId).not.toBeNull();
    expect(statuses(database, fork.runId)).toEqual({
      source: "completed",
      gate: "ready",
      loud: "pending",
    });
    expect((await dispatcher.dispatch(fork.runId)).status).toBe("waiting");
    const [forkRequest] = approvals.listPending(fork.runId);
    expect(forkRequest).toBeDefined();
    expect(forkRequest!.approvalId).not.toBe(parentRequest!.approvalId);

    const { resumeToken } = await approvals.issueResumeToken(forkRequest!.approvalId);
    await approvals.resume({
      approvalId: forkRequest!.approvalId,
      resumeToken,
      decision: "approved",
      payload: { ok: true },
    });
    expect((await dispatcher.dispatch(fork.runId)).status).toBe("completed");
    expect(calls).toEqual(["shout"]);
    expect(replayRecordedRun(database.connection(), fork.runId).consistent).toBe(true);

    expect(approvals.listPending(parent).map((approval) => approval.approvalId)).toEqual([
      parentRequest!.approvalId,
    ]);
    expect(snapshot(database, parent)).toBe(before);
  });

  it("refuses unknown runs, events of other runs, and points before a fork began", async () => {
    const { database, dispatcher, start } = await runtime();
    const first = await start(chainGraph);
    expect((await dispatcher.dispatch(first)).status).toBe("completed");
    const second = await start(chainGraph);
    expect((await dispatcher.dispatch(second)).status).toBe("completed");

    await expect(forkRun(database, "run-missing")).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
      statusCode: 404,
    });
    const foreign = stepEvent(database, second, "attempt", "source", "completed");
    await expect(forkRun(database, first, { throughEventId: foreign })).rejects.toMatchObject({
      code: "FORK_POINT_INVALID",
      statusCode: 422,
    });
    await expect(forkRun(database, first, { throughEventId: 0 })).rejects.toMatchObject({
      code: "FORK_POINT_INVALID",
    });
    await expect(forkRun(database, first, { throughEventId: 1.5 })).rejects.toMatchObject({
      code: "FORK_POINT_INVALID",
    });
    expect(() =>
      reconstructExecutionFrontier(database.connection(), first, { throughEventId: -1 }),
    ).toThrow(TypeError);

    const fork = await forkRun(database, first);
    expect(fork).toMatchObject({ reused: 2, rerun: 0 });
    expect((await dispatcher.dispatch(fork.runId)).status).toBe("completed");
    const copied = stepEvent(database, fork.runId, "attempt", "source", "completed");
    await expect(forkRun(database, fork.runId, { throughEventId: copied })).rejects.toMatchObject({
      code: "FORK_POINT_INVALID",
    });

    const again = await forkRun(database, fork.runId);
    expect(again).toMatchObject({ parentRunId: fork.runId, reused: 2, rerun: 0 });
    expect((await dispatcher.dispatch(again.runId)).status).toBe("completed");
    expect(replayRecordedRun(database.connection(), again.runId).consistent).toBe(true);
  });
});
