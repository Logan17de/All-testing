import { afterEach, describe, expect, it } from "vitest";

import { CapabilityPermissionPolicy, PluginHost } from "@zet-harness/core";
import { SQLITE_MEMORY_PATH, SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";
import type { HarnessPlugin, NodeDefinition } from "@zet-harness/plugin-api";

import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { forkRun } from "./runtime-fork.js";
import {
  RuntimeGraphError,
  compileEditorGraph,
  createCompositeNodeResolver,
  createRunFromCompiledGraph,
  listPaletteNodes,
  listRecentRuns,
  readRunView,
  type CompiledGraph,
} from "./runtime-graphs.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import { createPluginNodeExecutor } from "./runtime-plugin-executor.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";
import { RuntimeRunDispatcher } from "./runtime-run-dispatcher.js";

const databases: SqliteDatabase[] = [];
const dispatchers: RuntimeRunDispatcher[] = [];
const hosts: PluginHost[] = [];

afterEach(async () => {
  for (const dispatcher of dispatchers.splice(0)) await dispatcher.stop();
  for (const host of hosts.splice(0)) await host.dispose();
  for (const database of databases.splice(0)) database.close();
});

/** Uppercases a string: pure, so the scheduler may rerun it freely. */
const upper: NodeDefinition = {
  manifest: {
    type: "test.upper",
    version: "1",
    title: "Uppercase",
    inputs: { input: { schema: { type: "string" } } },
    outputs: { output: { schema: { type: "string" } } },
    configSchema: { type: "object", additionalProperties: false },
    behavior: {
      primitiveFamily: "pure",
      determinism: "deterministic",
      effect: "none",
      idempotency: "not-applicable",
      recovery: "rerun",
      executionMode: "in-process",
      requiredCapabilities: [],
    },
  },
  execute: (request) => {
    const value = request.inputs["input"];
    return { outputs: { output: typeof value === "string" ? value.toUpperCase() : "" } };
  },
};

const exclaim: NodeDefinition = {
  manifest: { ...upper.manifest, type: "test.exclaim", title: "Exclaim" },
  execute: (request) => {
    const value = request.inputs["input"];
    return { outputs: { output: `${typeof value === "string" ? value : ""}!` } };
  },
};

const plugin: HarnessPlugin = {
  manifest: { id: "test.nodes", name: "Test nodes", version: "1.0.0", apiVersion: 1 },
  activate(context) {
    context.nodes.register(upper);
    context.nodes.register(exclaim);
  },
};

async function hostWithNodes(): Promise<PluginHost> {
  const host = new PluginHost();
  hosts.push(host);
  await host.activate(plugin);
  return host;
}

function database(): SqliteDatabase {
  const db = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  db.open();
  runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
  databases.push(db);
  return db;
}

/** What the editor produces: two nodes joined by a data edge. */
function editorGraph(overrides: Partial<GraphJsonV1> = {}): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "editor-graph",
    revisionId: "rev-1",
    inputs: [],
    outputs: [{ id: "result", schema: true, source: { nodeId: "second", port: "output" } }],
    nodes: [
      {
        id: "first",
        type: "test.upper",
        version: "1",
        config: {},
        bindings: [{ kind: "literal", port: "input", value: "hello" }],
      },
      { id: "second", type: "test.exclaim", version: "1", config: {} },
    ],
    edges: [
      {
        id: "edge-1",
        kind: "data",
        from: { nodeId: "first", port: "output" },
        to: { nodeId: "second", port: "input" },
      },
    ],
    entrypoints: [{ id: "main", nodeId: "first" }],
    policies: {
      maxNodeExecutions: 8,
      maxParallelism: 2,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
    ...overrides,
  };
}

async function compile(host: PluginHost, graph: unknown = editorGraph()): Promise<CompiledGraph> {
  const result = await compileEditorGraph(graph, { host }, new CapabilityPermissionPolicy());
  if (!result.valid) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`);
  return result.compiled;
}

describe("palette", () => {
  it("lists every registered node with the plugin that provides it", async () => {
    const host = await hostWithNodes();
    const palette = listPaletteNodes({ host });
    expect(palette.map((node) => node.manifest.type)).toEqual(["test.exclaim", "test.upper"]);
    expect(palette.every((node) => node.pluginId === "test.nodes" && !node.isolated)).toBe(true);
  });

  it("includes sandboxed nodes and marks them isolated", () => {
    const palette = listPaletteNodes({
      sandboxes: [
        {
          pluginId: "sandboxed.plugin",
          pluginVersion: "2.0.0",
          sandboxFlags: [],
          tools: [],
          close: () => Promise.resolve(),
          nodes: [upper],
        },
      ],
    });
    expect(palette[0]).toMatchObject({ pluginId: "sandboxed.plugin", isolated: true });
  });

  it("resolves sandboxed nodes with their plugin version for plan pins", () => {
    const resolver = createCompositeNodeResolver({
      sandboxes: [
        {
          pluginId: "sandboxed.plugin",
          pluginVersion: "2.0.0",
          sandboxFlags: [],
          tools: [],
          close: () => Promise.resolve(),
          nodes: [upper],
        },
      ],
    });
    expect(resolver.getResolution("test.upper", "1")?.plugin).toEqual({
      id: "sandboxed.plugin",
      version: "2.0.0",
    });
  });
});

describe("compiling editor graphs", () => {
  it("compiles a valid graph through every compiler stage", async () => {
    const host = await hostWithNodes();
    const compiled = await compile(host);
    expect(compiled.identity.semanticHash).toMatch(/^sha256:/u);
    expect(compiled.identity.nodePins.map((pin) => pin.pluginId)).toEqual([
      "test.nodes",
      "test.nodes",
    ]);
  });

  it("reports an unknown node type as a located diagnostic", async () => {
    const host = await hostWithNodes();
    const graph = editorGraph();
    const result = await compileEditorGraph(
      {
        ...graph,
        nodes: [graph.nodes[0], { id: "second", type: "test.missing", version: "1", config: {} }],
      },
      { host },
      new CapabilityPermissionPolicy(),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics.some((diagnostic) => diagnostic.nodeId === "second")).toBe(true);
    }
  });

  it("reports an edge to a port that does not exist", async () => {
    const host = await hostWithNodes();
    const result = await compileEditorGraph(
      editorGraph({
        edges: [
          {
            id: "edge-1",
            kind: "data",
            from: { nodeId: "first", port: "output" },
            to: { nodeId: "second", port: "no-such-port" },
          },
        ],
      }),
      { host },
      new CapabilityPermissionPolicy(),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics.some((diagnostic) => diagnostic.edgeId === "edge-1")).toBe(true);
    }
  });

  it("refuses a document that is not Graph JSON at all", async () => {
    const host = await hostWithNodes();
    const result = await compileEditorGraph(
      { nope: true },
      { host },
      new CapabilityPermissionPolicy(),
    );
    expect(result.valid).toBe(false);
  });

  it("gives an unchanged graph the same semantic identity when only editor layout moves", async () => {
    const host = await hostWithNodes();
    const plain = await compile(host);
    const moved = await compile(
      host,
      editorGraph({ editor: { nodes: { first: { position: { x: 300, y: 120 } } } } }),
    );
    expect(moved.identity.semanticHash).toBe(plain.identity.semanticHash);
  });
});

describe("storing runs", () => {
  it("creates a pending run bound to a stored plan", async () => {
    const host = await hostWithNodes();
    const db = database();
    const created = await createRunFromCompiledGraph(db, await compile(host));
    const [summary] = listRecentRuns(db);
    expect(summary).toMatchObject({
      runId: created.runId,
      status: "pending",
      graphId: "editor-graph",
    });
  });

  it("reuses the stored plan when an unchanged graph is run again", async () => {
    const host = await hostWithNodes();
    const db = database();
    const compiled = await compile(host);
    const first = await createRunFromCompiledGraph(db, compiled);
    const second = await createRunFromCompiledGraph(db, compiled);
    expect(second.runId).not.toBe(first.runId);
    expect(second.compiledPlanId).toBe(first.compiledPlanId);
  });

  it("refuses a revision id that already names different content", async () => {
    const host = await hostWithNodes();
    const db = database();
    await createRunFromCompiledGraph(db, await compile(host));
    const changed = await compile(
      host,
      editorGraph({
        nodes: [
          {
            id: "first",
            type: "test.upper",
            version: "1",
            config: {},
            bindings: [{ kind: "literal", port: "input", value: "different" }],
          },
          { id: "second", type: "test.exclaim", version: "1", config: {} },
        ],
      }),
    );
    const error = await createRunFromCompiledGraph(db, changed).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeGraphError);
    expect((error as RuntimeGraphError).code).toBe("GRAPH_REVISION_CONFLICT");
  });

  it("shows a fork's parent and lists the forks made from a run", async () => {
    const host = await hostWithNodes();
    const db = database();
    const { runId } = await createRunFromCompiledGraph(db, await compile(host));
    const fork = await forkRun(db, runId);

    const forkView = readRunView(db, fork.runId, (value) => value);
    expect(forkView.forkedFrom).toEqual({
      parentRunId: runId,
      throughEventId: fork.throughEventId,
      parentCheckpointId: null,
      checkpointId: fork.checkpointId,
    });
    expect(forkView.forks).toEqual([]);

    const parentView = readRunView(db, runId, (value) => value);
    expect(parentView.forkedFrom).toBeNull();
    expect(parentView.forks).toMatchObject([
      { runId: fork.runId, status: "pending", throughEventId: fork.throughEventId },
    ]);
    expect(listRecentRuns(db).find((summary) => summary.runId === fork.runId)?.parentRunId).toBe(
      runId,
    );
  });

  it("reports a missing run as not found", () => {
    const db = database();
    expect(() => readRunView(db, "run-missing", (value) => value)).toThrow(RuntimeGraphError);
  });
});

describe("editor graph to executed run", () => {
  it("runs a graph built in the editor through the durable dispatcher", async () => {
    const host = await hostWithNodes();
    const db = database();
    const { runId } = await createRunFromCompiledGraph(db, await compile(host));

    const authority = new CapabilityPermissionPolicy();
    const redaction = new RuntimeRedactionRegistry();
    const approvals = new RuntimeHumanApprovals(db, {
      redaction,
      authority,
      onResolved: (id) => {
        dispatcher.wake(id);
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

    const report = await dispatcher.dispatch(runId);
    expect(report.status).toBe("completed");

    const view = readRunView(db, runId, (value) => redaction.redact(value));
    expect(view.status).toBe("completed");
    expect(view.nodes.map((node) => [node.nodeId, node.status])).toEqual([
      ["first", "completed"],
      ["second", "completed"],
    ]);

    // The second node received the first node's committed output.
    const secondAttempt = view.attempts.find((attempt) => attempt.opIndex === 1);
    expect(JSON.stringify(secondAttempt?.outputs)).toContain("HELLO!");
    expect(view.timeline.some((event) => event.eventType === "harness.attempt.completed")).toBe(
      true,
    );
  });
});
