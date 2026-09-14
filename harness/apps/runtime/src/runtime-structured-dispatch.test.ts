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
import {
  RuntimeGraphError,
  compileEditorGraph,
  createRunFromCompiledGraph,
} from "./runtime-graphs.js";
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

afterEach(async () => {
  for (const dispatcher of dispatchers.splice(0)) await dispatcher.stop();
  for (const host of hosts.splice(0)) await host.dispose();
  for (const database of databases.splice(0)) database.close();
  ran.length = 0;
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

const loop: NodeDefinition = {
  manifest: {
    type: "flow.loop",
    version: "1",
    title: "Loop",
    inputs: {},
    outputs: {},
    configSchema: {
      type: "object",
      properties: { maxIterations: { type: "integer", minimum: 1 } },
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

describe("loops before the scheduler can iterate them", () => {
  it("compiles a loop graph but refuses to store a run that could never progress", async () => {
    const db = database();
    const host = await flowHost();
    const graph: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "loop-graph",
      revisionId: "rev-1",
      inputs: [],
      outputs: [],
      nodes: [
        { id: "start", type: "flow.step", version: "1", config: { label: "start" } },
        { id: "loop", type: "flow.loop", version: "1", config: { maxIterations: 2 } },
        { id: "work", type: "flow.step", version: "1", config: { label: "work" } },
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
        {
          id: "again",
          kind: "control",
          from: { nodeId: "work" },
          to: { nodeId: "loop", port: "again" },
        },
        {
          id: "done",
          kind: "control",
          from: { nodeId: "loop", port: "done" },
          to: { nodeId: "finish" },
        },
      ],
      entrypoints: [{ id: "main", nodeId: "start" }],
      policies: {
        maxNodeExecutions: 10,
        maxParallelism: 2,
        capabilities: { required: [], optional: [], deny: [] },
      },
      options: { defaultEntrypoint: "main" },
    };

    const result = await compileEditorGraph(graph, { host }, new CapabilityPermissionPolicy());
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    const refusal = createRunFromCompiledGraph(db, result.compiled);
    await expect(refusal).rejects.toBeInstanceOf(RuntimeGraphError);
    await expect(refusal).rejects.toMatchObject({ code: "GRAPH_INVALID", statusCode: 422 });
    const runs = db.connection().prepare("SELECT COUNT(*) AS count FROM runs").get() as {
      readonly count: number;
    };
    expect(runs.count).toBe(0);
  });
});
