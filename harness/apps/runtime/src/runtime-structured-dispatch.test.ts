import { afterEach, describe, expect, it } from "vitest";

import {
  CapabilityPermissionPolicy,
  PluginHost,
  createHumanApprovalPlugin,
} from "@zet-harness/core";
import { SQLITE_MEMORY_PATH, SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";
import type { HarnessPlugin, NodeBehavior, NodeDefinition } from "@zet-harness/plugin-api";

import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { compileEditorGraph, createRunFromCompiledGraph } from "./runtime-graphs.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import { createPluginNodeExecutor } from "./runtime-plugin-executor.js";
import { reconstructExecutionFrontier } from "./runtime-recovery.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";
import { RuntimeRunDispatcher } from "./runtime-run-dispatcher.js";

const databases: SqliteDatabase[] = [];
const dispatchers: RuntimeRunDispatcher[] = [];
const hosts: PluginHost[] = [];
/** Labels of the step nodes that actually executed, in order. */
const ran: string[] = [];
/** Called after a step node runs, so a test can act mid-run. */
let afterStep: ((label: string) => void) | undefined;

afterEach(async () => {
  for (const dispatcher of dispatchers.splice(0)) await dispatcher.stop();
  for (const host of hosts.splice(0)) await host.dispose();
  for (const database of databases.splice(0)) database.close();
  ran.length = 0;
  afterStep = undefined;
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

const CONTROL: NodeBehavior = {
  primitiveFamily: "control",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "not-applicable",
  executionMode: "none",
  requiredCapabilities: [],
};

const pick: NodeDefinition = {
  manifest: {
    type: "flow.pick",
    version: "1",
    title: "Pick a branch",
    inputs: {},
    outputs: { branch: { schema: { type: "string" } } },
    configSchema: {
      type: "object",
      properties: { branch: { type: "string" } },
      required: ["branch"],
      additionalProperties: false,
    },
    behavior: PURE,
  },
  execute: (request) => ({ outputs: { branch: request.config["branch"] ?? "" } }),
};

const step: NodeDefinition = {
  manifest: {
    type: "flow.step",
    version: "1",
    title: "Step",
    inputs: {},
    outputs: { done: { schema: { type: "string" } } },
    configSchema: {
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
      additionalProperties: false,
    },
    behavior: PURE,
  },
  execute: (request) => {
    const label = request.config["label"];
    const name = typeof label === "string" ? label : "";
    ran.push(name);
    afterStep?.(name);
    return { outputs: { done: name } };
  },
};

const route: NodeDefinition = {
  manifest: {
    type: "flow.route",
    version: "1",
    title: "Route",
    inputs: { branch: { schema: { type: "string" }, required: true } },
    outputs: {},
    configSchema: { type: "object", additionalProperties: false },
    behavior: CONTROL,
    control: { kind: "router", entry: "in", branches: ["left", "right"] },
  },
  execute: () => {
    throw new Error("The scheduler resolves routers itself.");
  },
};

const join: NodeDefinition = {
  manifest: {
    type: "flow.join",
    version: "1",
    title: "Join",
    inputs: {},
    outputs: {},
    configSchema: { type: "object", additionalProperties: false },
    behavior: CONTROL,
    control: { kind: "join", inputs: ["left", "right"], output: "out", mode: "all-active" },
  },
  execute: () => {
    throw new Error("The scheduler resolves joins itself.");
  },
};

/** A step that takes a little while, so a time budget can run out. */
const slow: NodeDefinition = {
  manifest: {
    type: "flow.slow",
    version: "1",
    title: "Slow step",
    inputs: {},
    outputs: { done: { schema: { type: "string" } } },
    configSchema: {
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
      additionalProperties: false,
    },
    behavior: PURE,
  },
  execute: async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const label = request.config["label"];
    const name = typeof label === "string" ? label : "";
    ran.push(name);
    return { outputs: { done: name } };
  },
};

const flag: NodeDefinition = {
  manifest: {
    type: "flow.flag",
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
  execute: (request) => ({ outputs: { again: request.config["value"] === true } }),
};

const loop: NodeDefinition = {
  manifest: {
    type: "flow.loop",
    version: "1",
    title: "Loop",
    inputs: { again: { schema: { type: "boolean" } } },
    outputs: {},
    configSchema: {
      type: "object",
      properties: {
        maxIterations: { type: "integer", minimum: 1 },
        maxWallTimeMs: { type: "integer", minimum: 1 },
      },
      required: ["maxIterations"],
      additionalProperties: false,
    },
    behavior: CONTROL,
    control: { kind: "loop", entry: "enter", continue: "again", body: "body", exit: "done" },
  },
};

const flowPlugin: HarnessPlugin = {
  manifest: { id: "test.flow", name: "Flow test nodes", version: "1.0.0", apiVersion: 1 },
  activate(context) {
    context.nodes.register(pick);
    context.nodes.register(step);
    context.nodes.register(route);
    context.nodes.register(join);
    context.nodes.register(loop);
    context.nodes.register(flag);
    context.nodes.register(slow);
  },
};

async function flowHost(): Promise<PluginHost> {
  const host = new PluginHost();
  hosts.push(host);
  await host.activate(flowPlugin);
  await host.activate(createHumanApprovalPlugin());
  return host;
}

function database(): SqliteDatabase {
  const db = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  db.open();
  runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
  databases.push(db);
  return db;
}

/**
 * pick → route ─left→ [gate →] left ─┐
 *              └right→ right ────────┴→ join → finish
 */
function routedGraph(branch: string, options: { readonly gate?: boolean } = {}): GraphJsonV1 {
  const gate = options.gate === true;
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "routed-graph",
    revisionId: `rev-${branch}-${gate ? "gate" : "plain"}`,
    inputs: [],
    outputs: [{ id: "result", schema: true, source: { nodeId: "finish", port: "done" } }],
    nodes: [
      { id: "pick", type: "flow.pick", version: "1", config: { branch } },
      { id: "route", type: "flow.route", version: "1", config: {} },
      { id: "left", type: "flow.step", version: "1", config: { label: "left" } },
      { id: "right", type: "flow.step", version: "1", config: { label: "right" } },
      { id: "join", type: "flow.join", version: "1", config: {} },
      { id: "finish", type: "flow.step", version: "1", config: { label: "finish" } },
      ...(gate
        ? [
            {
              id: "gate",
              type: "harness.human-approval",
              version: "1",
              config: { prompt: "Take the left branch?" },
            },
          ]
        : []),
    ],
    edges: [
      {
        id: "e-pick",
        kind: "data",
        from: { nodeId: "pick", port: "branch" },
        to: { nodeId: "route", port: "branch" },
      },
      ...(gate
        ? [
            {
              id: "e-left-gate",
              kind: "control" as const,
              from: { nodeId: "route", port: "left" },
              to: { nodeId: "gate" },
            },
            {
              id: "e-gate-left",
              kind: "control" as const,
              from: { nodeId: "gate" },
              to: { nodeId: "left" },
            },
          ]
        : [
            {
              id: "e-left",
              kind: "control" as const,
              from: { nodeId: "route", port: "left" },
              to: { nodeId: "left" },
            },
          ]),
      {
        id: "e-right",
        kind: "control",
        from: { nodeId: "route", port: "right" },
        to: { nodeId: "right" },
      },
      {
        id: "e-join-left",
        kind: "control",
        from: { nodeId: "left" },
        to: { nodeId: "join", port: "left" },
      },
      {
        id: "e-join-right",
        kind: "control",
        from: { nodeId: "right" },
        to: { nodeId: "join", port: "right" },
      },
      {
        id: "e-finish",
        kind: "control",
        from: { nodeId: "join", port: "out" },
        to: { nodeId: "finish" },
      },
    ],
    entrypoints: [{ id: "main", nodeId: "pick" }],
    policies: {
      maxNodeExecutions: 10,
      maxParallelism: 2,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
  };
}

async function createRun(db: SqliteDatabase, host: PluginHost, graph: GraphJsonV1) {
  const result = await compileEditorGraph(graph, { host }, new CapabilityPermissionPolicy());
  if (!result.valid) {
    throw new Error(`Graph did not compile: ${JSON.stringify(result.diagnostics)}`);
  }
  return (await createRunFromCompiledGraph(db, result.compiled)).runId;
}

function startRuntime(db: SqliteDatabase, host: PluginHost) {
  const authority = new CapabilityPermissionPolicy();
  const redaction = new RuntimeRedactionRegistry();
  const approvals = new RuntimeHumanApprovals(db, {
    redaction,
    authority,
    onResolved: (runId) => {
      dispatcher.wake(runId);
    },
  });
  const dispatcher = new RuntimeRunDispatcher(
    db,
    approvals,
    { execute: createPluginNodeExecutor({ host }) },
    redaction,
    authority,
  );
  dispatchers.push(dispatcher);
  dispatcher.start();
  return { dispatcher, approvals };
}

/** Durable status of every node, keyed by graph node id. */
function nodeStatuses(db: SqliteDatabase, runId: string): Record<string, string> {
  const frontier = reconstructExecutionFrontier(db.connection(), runId);
  const ir = frontier.executionIr as unknown as {
    readonly ops: readonly { sourceNodeId: string }[];
  };
  return Object.fromEntries(
    frontier.ops.map((op) => [ir.ops[op.opIndex]!.sourceNodeId, op.status]),
  );
}

describe("durable routers and joins", () => {
  it("follows the branch the graph picks, skips the other and completes through the join", async () => {
    const db = database();
    const host = await flowHost();
    const runId = await createRun(db, host, routedGraph("left"));
    const { dispatcher } = startRuntime(db, host);

    const report = await dispatcher.dispatch(runId);

    expect(report.status).toBe("completed");
    expect(ran).toEqual(["left", "finish"]);
    expect(nodeStatuses(db, runId)).toEqual({
      pick: "completed",
      route: "completed",
      left: "completed",
      right: "skipped",
      join: "completed",
      finish: "completed",
    });
    const frontier = reconstructExecutionFrontier(db.connection(), runId);
    expect(frontier.routerSelections.map(({ branch }) => branch)).toEqual(["left"]);
  });

  it("takes the other branch when the graph picks it", async () => {
    const db = database();
    const host = await flowHost();
    const runId = await createRun(db, host, routedGraph("right"));
    const { dispatcher } = startRuntime(db, host);

    expect((await dispatcher.dispatch(runId)).status).toBe("completed");
    expect(ran).toEqual(["right", "finish"]);
    expect(nodeStatuses(db, runId)).toMatchObject({ left: "skipped", right: "completed" });
  });

  it("fails the run when the picked branch is not one the router declares", async () => {
    const db = database();
    const host = await flowHost();
    const runId = await createRun(db, host, routedGraph("sideways"));
    const { dispatcher } = startRuntime(db, host);

    const report = await dispatcher.dispatch(runId);

    expect(report.status).toBe("failed");
    expect(ran).toEqual([]);
  });

  it("resumes a routed run after a restart while its chosen branch waits for approval", async () => {
    const db = database();
    const host = await flowHost();
    const runId = await createRun(db, host, routedGraph("left", { gate: true }));

    const first = startRuntime(db, host);
    expect((await first.dispatcher.dispatch(runId)).status).toBe("waiting");
    expect(ran).toEqual([]);
    expect(nodeStatuses(db, runId)).toMatchObject({ gate: "waiting", right: "skipped" });
    await first.dispatcher.stop();

    // A fresh runtime over the same database: nothing survives but committed state.
    const second = startRuntime(db, host);
    const [pending] = second.approvals.listPending(runId);
    expect(pending).toBeDefined();
    const { resumeToken } = await second.approvals.issueResumeToken(pending!.approvalId);
    await second.approvals.resume({
      approvalId: pending!.approvalId,
      resumeToken,
      decision: "approved",
      payload: { ok: true },
    });

    expect((await second.dispatcher.dispatch(runId)).status).toBe("completed");
    expect(ran).toEqual(["left", "finish"]);
    expect(nodeStatuses(db, runId)).toEqual({
      pick: "completed",
      route: "completed",
      gate: "completed",
      left: "completed",
      right: "skipped",
      join: "completed",
      finish: "completed",
    });
    const frontier = reconstructExecutionFrontier(db.connection(), runId);
    expect(frontier.routerSelections.map(({ branch }) => branch)).toEqual(["left"]);
  });
});

/**
 * start → loop ─body→ work [→ stop] ─again→ loop ─done→ finish. With `exitEarly`,
 * a Flag node inside the body feeds `false` into the loop's `again` input.
 */
function loopGraph(options: { readonly exitEarly?: boolean } = {}): GraphJsonV1 {
  const exitEarly = options.exitEarly === true;
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: exitEarly ? "loop-early" : "loop-bound",
    revisionId: "rev-1",
    inputs: [],
    outputs: [{ id: "result", schema: true, source: { nodeId: "finish", port: "done" } }],
    nodes: [
      { id: "start", type: "flow.step", version: "1", config: { label: "start" } },
      { id: "loop", type: "flow.loop", version: "1", config: { maxIterations: 3 } },
      { id: "work", type: "flow.step", version: "1", config: { label: "work" } },
      ...(exitEarly
        ? [{ id: "stop", type: "flow.flag", version: "1", config: { value: false } }]
        : []),
      { id: "finish", type: "flow.step", version: "1", config: { label: "finish" } },
    ],
    edges: [
      {
        id: "enter",
        kind: "control",
        from: { nodeId: "start" },
        to: { nodeId: "loop", port: "enter" },
      },
      {
        id: "body",
        kind: "control",
        from: { nodeId: "loop", port: "body" },
        to: { nodeId: "work" },
      },
      ...(exitEarly
        ? [
            {
              id: "work-stop",
              kind: "control" as const,
              from: { nodeId: "work" },
              to: { nodeId: "stop" },
            },
            {
              id: "again",
              kind: "control" as const,
              from: { nodeId: "stop" },
              to: { nodeId: "loop", port: "again" },
            },
            {
              id: "again-value",
              kind: "data" as const,
              from: { nodeId: "stop", port: "again" },
              to: { nodeId: "loop", port: "again" },
            },
          ]
        : [
            {
              id: "again",
              kind: "control" as const,
              from: { nodeId: "work" },
              to: { nodeId: "loop", port: "again" },
            },
          ]),
      {
        id: "done",
        kind: "control",
        from: { nodeId: "loop", port: "done" },
        to: { nodeId: "finish" },
      },
    ],
    entrypoints: [{ id: "main", nodeId: "start" }],
    policies: {
      maxNodeExecutions: 20,
      maxParallelism: 2,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
  };
}

/** Durable attempts of one node as `iteration.attempt`, in order. */
function attemptsOf(db: SqliteDatabase, runId: string, nodeId: string): readonly string[] {
  const frontier = reconstructExecutionFrontier(db.connection(), runId);
  const ir = frontier.executionIr as unknown as {
    readonly ops: readonly { sourceNodeId: string }[];
  };
  const op = ir.ops.findIndex((candidate) => candidate.sourceNodeId === nodeId);
  const rows = db
    .connection()
    .prepare(
      "SELECT iteration, attempt, status FROM node_attempts WHERE run_id = ? AND op_index = ? ORDER BY iteration, attempt",
    )
    .all(runId, op) as {
    readonly iteration: number;
    readonly attempt: number;
    readonly status: string;
  }[];
  return rows.map((row) => `${String(row.iteration)}.${String(row.attempt)}:${row.status}`);
}

describe("durable loops", () => {
  it("runs a loop body to its bound and then releases the work after it", async () => {
    const db = database();
    const host = await flowHost();
    const runId = await createRun(db, host, loopGraph());
    const { dispatcher } = startRuntime(db, host);

    expect((await dispatcher.dispatch(runId)).status).toBe("completed");
    expect(ran).toEqual(["start", "work", "work", "work", "finish"]);
    expect(attemptsOf(db, runId, "work")).toEqual([
      "0.1:completed",
      "1.1:completed",
      "2.1:completed",
    ]);
    expect(nodeStatuses(db, runId)).toEqual({
      start: "completed",
      loop: "completed",
      work: "completed",
      finish: "completed",
    });
  });

  it("leaves the loop as soon as its again input is false", async () => {
    const db = database();
    const host = await flowHost();
    const runId = await createRun(db, host, loopGraph({ exitEarly: true }));
    const { dispatcher } = startRuntime(db, host);

    expect((await dispatcher.dispatch(runId)).status).toBe("completed");
    expect(ran).toEqual(["start", "work", "finish"]);
    expect(attemptsOf(db, runId, "work")).toEqual(["0.1:completed"]);
  });

  it("resumes a loop in a fresh runtime after pausing between iterations", async () => {
    const db = database();
    const host = await flowHost();
    const runId = await createRun(db, host, loopGraph());

    const first = startRuntime(db, host);
    let works = 0;
    afterStep = (label) => {
      if (label === "work" && ++works === 2) void first.dispatcher.pauseRun(runId);
    };
    expect((await first.dispatcher.dispatch(runId)).status).toBe("paused");
    expect(ran).toEqual(["start", "work", "work"]);
    await first.dispatcher.stop();
    afterStep = undefined;

    const second = startRuntime(db, host);
    expect((await second.dispatcher.dispatch(runId)).status).toBe("completed");
    expect(ran).toEqual(["start", "work", "work", "work", "finish"]);
    expect(attemptsOf(db, runId, "work")).toEqual([
      "0.1:completed",
      "1.1:completed",
      "2.1:completed",
    ]);
  });
});

/** A straight chain of steps, `start → middle → end`, with graph-level limits. */
function chainGraph(
  policies: { readonly maxNodeExecutions?: number; readonly maxWallTimeMs?: number },
  middleType = "flow.step",
): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "chain-graph",
    revisionId: `rev-${JSON.stringify(policies)}-${middleType}`,
    inputs: [],
    outputs: [{ id: "result", schema: true, source: { nodeId: "end", port: "done" } }],
    nodes: [
      { id: "start", type: "flow.step", version: "1", config: { label: "start" } },
      { id: "middle", type: middleType, version: "1", config: { label: "middle" } },
      { id: "end", type: "flow.step", version: "1", config: { label: "end" } },
    ],
    edges: [
      { id: "a", kind: "control", from: { nodeId: "start" }, to: { nodeId: "middle" } },
      { id: "b", kind: "control", from: { nodeId: "middle" }, to: { nodeId: "end" } },
    ],
    entrypoints: [{ id: "main", nodeId: "start" }],
    policies: {
      ...policies,
      maxParallelism: 1,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
  };
}

function eventPayloads(db: SqliteDatabase, runId: string, eventType: string): readonly unknown[] {
  const rows = db
    .connection()
    .prepare(
      "SELECT payload_json AS payload FROM durable_events WHERE run_id = ? AND event_type = ? ORDER BY event_id",
    )
    .all(runId, eventType) as { readonly payload: string }[];
  return rows.map((row) => JSON.parse(row.payload) as unknown);
}

describe("hard limits (8.2)", () => {
  it("fails a run that uses up its node execution limit, before the next node starts", async () => {
    const db = database();
    const host = await flowHost();
    const runId = await createRun(db, host, chainGraph({ maxNodeExecutions: 2 }));
    const { dispatcher } = startRuntime(db, host);

    const report = await dispatcher.dispatch(runId);

    expect(report).toMatchObject({ status: "failed", code: "RUNTIME_BUDGET_EXCEEDED" });
    expect(ran).toEqual(["start", "middle"]);
    expect(eventPayloads(db, runId, "harness.run.budget-exceeded")).toEqual([
      { budget: "node-executions", limit: 2 },
    ]);
  });

  it("fails a run that passes its wall-time limit, before the next node starts", async () => {
    const db = database();
    const host = await flowHost();
    const runId = await createRun(db, host, chainGraph({ maxWallTimeMs: 10 }, "flow.slow"));
    const { dispatcher } = startRuntime(db, host);

    const report = await dispatcher.dispatch(runId);

    expect(report).toMatchObject({ status: "failed", code: "RUNTIME_BUDGET_EXCEEDED" });
    expect(ran).toEqual(["start", "middle"]);
    expect(eventPayloads(db, runId, "harness.run.budget-exceeded")).toEqual([
      { budget: "run-wall-time", limit: 10 },
    ]);
  });

  it("leaves a loop once its own wall-time bound has passed, and records why", async () => {
    const db = database();
    const host = await flowHost();
    const graph = loopGraph();
    const timed: GraphJsonV1 = {
      ...graph,
      graphId: "loop-timed",
      nodes: graph.nodes.map((item) =>
        item.id === "loop"
          ? { ...item, config: { maxIterations: 5, maxWallTimeMs: 10 } }
          : item.id === "work"
            ? { ...item, type: "flow.slow" }
            : item,
      ),
    };
    const runId = await createRun(db, host, timed);
    const { dispatcher } = startRuntime(db, host);

    expect((await dispatcher.dispatch(runId)).status).toBe("completed");
    expect(ran).toEqual(["start", "work", "finish"]);
    expect(eventPayloads(db, runId, "harness.loop.advanced")).toEqual([
      { iteration: 0, decision: "exit", reason: "max-wall-time" },
    ]);
  });

  it("records why a loop ended at its iteration bound", async () => {
    const db = database();
    const host = await flowHost();
    const runId = await createRun(db, host, loopGraph());
    const { dispatcher } = startRuntime(db, host);

    await dispatcher.dispatch(runId);

    expect(eventPayloads(db, runId, "harness.loop.advanced")).toEqual([
      { iteration: 0, decision: "continue" },
      { iteration: 1, decision: "continue" },
      { iteration: 2, decision: "exit", reason: "max-iterations" },
    ]);
  });
});
