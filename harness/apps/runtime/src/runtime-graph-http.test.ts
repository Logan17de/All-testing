import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SQLITE_MEMORY_PATH } from "@zet-harness/db";

import { RuntimeDaemon } from "./runtime-daemon.js";

/** A real third-party plugin package, loaded from disk by the daemon under test. */
const ENTRY = `
const pure = {
  primitiveFamily: "pure",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "rerun",
  executionMode: "in-process",
  requiredCapabilities: [],
};
const text = { schema: { type: "string" } };
const node = (type, title, transform) => ({
  manifest: {
    type,
    version: "1",
    title,
    inputs: { input: text },
    outputs: { output: text },
    configSchema: { type: "object", additionalProperties: false },
    behavior: pure,
  },
  execute: (request) => ({ outputs: { output: transform(String(request.inputs.input)) } }),
});
export default {
  manifest: { id: "com.example.text", name: "Text", version: "1.0.0", apiVersion: 1, capabilities: [] },
  activate(context) {
    context.nodes.register(node("text.upper", "Uppercase", (value) => value.toUpperCase()));
    context.nodes.register(node("text.exclaim", "Exclaim", (value) => value + "!"));
  },
};
`;

let root: string;
const daemons: RuntimeDaemon[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zet-graph-http-"));
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

async function installTextPlugin(): Promise<string> {
  const plugins = join(root, "plugins");
  const directory = join(plugins, "text");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "index.mjs"), ENTRY, "utf8");
  await writeFile(
    join(directory, "zet-plugin.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "com.example.text",
      name: "Text",
      version: "1.0.0",
      apiVersion: 1,
      license: "MIT",
      entry: "./index.mjs",
      requestedCapabilities: [],
      nodes: [
        { type: "text.upper", version: "1", title: "Uppercase" },
        { type: "text.exclaim", version: "1", title: "Exclaim" },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(plugins, "plugins.json"),
    JSON.stringify({ plugins: [{ id: "com.example.text", enabled: true }] }),
    "utf8",
  );
  return plugins;
}

async function startDaemon(): Promise<string> {
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path: SQLITE_MEMORY_PATH },
    probePathLimits: false,
    plugins: { directory: await installTextPlugin() },
  });
  daemons.push(daemon);
  await daemon.start();
  return `http://127.0.0.1:${String(daemon.snapshot().api.port)}`;
}

async function sessionToken(base: string): Promise<string> {
  const response = await fetch(`${base}/api/session`);
  return ((await response.json()) as { readonly csrfToken: string }).csrfToken;
}

interface JsonReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function post(base: string, path: string, body: unknown, token?: string): Promise<JsonReply> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { "x-zet-csrf": token }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function get(base: string, path: string): Promise<JsonReply> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function graph(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    graphId: "http-graph",
    revisionId: "rev-1",
    inputs: [],
    outputs: [{ id: "result", schema: true, source: { nodeId: "second", port: "output" } }],
    nodes: [
      {
        id: "first",
        type: "text.upper",
        version: "1",
        config: {},
        bindings: [{ kind: "literal", port: "input", value: "hello" }],
      },
      { id: "second", type: "text.exclaim", version: "1", config: {} },
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

async function waitForRun(base: string, runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const reply = await get(base, `/api/runs/${encodeURIComponent(runId)}`);
    const run = reply.body["run"] as Record<string, unknown>;
    if (["completed", "failed", "cancelled"].includes(String(run["status"]))) return run;
    if (Date.now() > deadline) throw new Error(`run stuck in ${String(run["status"])}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("editor endpoints on a running daemon", () => {
  it("lists the nodes enabled plugins provide", async () => {
    const base = await startDaemon();
    const reply = await get(base, "/api/nodes");
    const types = (reply.body["nodes"] as { manifest: { type: string } }[]).map(
      (node) => node.manifest.type,
    );
    expect(types).toEqual([
      "harness.condition",
      "harness.human-approval",
      "harness.join-all",
      "harness.join-any",
      "harness.route",
      "text.exclaim",
      "text.upper",
    ]);
  });

  it("refuses a graph POST that lacks the session CSRF token", async () => {
    const base = await startDaemon();
    const reply = await post(base, "/api/graphs/validate", { graph: graph() });
    expect(reply.status).toBe(403);
  });

  it("validates a graph through the real compiler", async () => {
    const base = await startDaemon();
    const reply = await post(
      base,
      "/api/graphs/validate",
      { graph: graph() },
      await sessionToken(base),
    );
    expect(reply.status).toBe(200);
    expect(reply.body["valid"]).toBe(true);
    expect(reply.body["diagnostics"]).toEqual([]);
  });

  it("returns located diagnostics for a graph that references a missing node type", async () => {
    const base = await startDaemon();
    const broken = graph({
      nodes: [
        { id: "first", type: "text.upper", version: "1", config: {} },
        { id: "second", type: "text.missing", version: "1", config: {} },
      ],
    });
    const reply = await post(
      base,
      "/api/graphs/validate",
      { graph: broken },
      await sessionToken(base),
    );
    expect(reply.body["valid"]).toBe(false);
    const diagnostics = reply.body["diagnostics"] as { nodeId?: string }[];
    expect(diagnostics.some((diagnostic) => diagnostic.nodeId === "second")).toBe(true);
  });

  it("runs an editor graph end to end through a plugin loaded from disk", async () => {
    const base = await startDaemon();
    const created = await post(base, "/api/runs", { graph: graph() }, await sessionToken(base));
    expect(created.status).toBe(201);
    expect(created.body["dispatched"]).toBe(true);

    const run = await waitForRun(base, String(created.body["runId"]));
    expect(run["status"]).toBe("completed");
    const nodes = run["nodes"] as { nodeId: string; status: string }[];
    expect(nodes.map((node) => [node.nodeId, node.status])).toEqual([
      ["first", "completed"],
      ["second", "completed"],
    ]);
    expect(JSON.stringify(run["attempts"])).toContain("HELLO!");
    // The inspector draws the stored document, not a client copy.
    expect((run["graph"] as { nodes: unknown[] }).nodes).toHaveLength(2);
  });

  it("lists a run it created", async () => {
    const base = await startDaemon();
    const created = await post(base, "/api/runs", { graph: graph() }, await sessionToken(base));
    const reply = await get(base, "/api/runs");
    const ids = (reply.body["runs"] as { runId: string }[]).map((run) => run.runId);
    expect(ids).toContain(created.body["runId"]);
  });

  it("refuses to run an invalid graph and returns why", async () => {
    const base = await startDaemon();
    const reply = await post(
      base,
      "/api/runs",
      { graph: graph({ entrypoints: [{ id: "main", nodeId: "nobody" }] }) },
      await sessionToken(base),
    );
    expect(reply.status).toBe(422);
    expect((reply.body["error"] as { code: string }).code).toBe("GRAPH_INVALID");
    expect((reply.body["diagnostics"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("refuses a revision id that already names different content", async () => {
    const base = await startDaemon();
    const token = await sessionToken(base);
    expect((await post(base, "/api/runs", { graph: graph() }, token)).status).toBe(201);
    const changed = graph({
      nodes: [
        {
          id: "first",
          type: "text.upper",
          version: "1",
          config: {},
          bindings: [{ kind: "literal", port: "input", value: "different" }],
        },
        { id: "second", type: "text.exclaim", version: "1", config: {} },
      ],
    });
    const reply = await post(base, "/api/runs", { graph: changed }, token);
    expect(reply.status).toBe(409);
  });

  it("refuses a body that is not JSON", async () => {
    const base = await startDaemon();
    const reply = await post(base, "/api/runs", "not json", await sessionToken(base));
    expect(reply.status).toBe(400);
  });

  it("reports an unknown run as not found", async () => {
    const base = await startDaemon();
    const reply = await get(base, "/api/runs/run-does-not-exist");
    expect(reply.status).toBe(404);
  });

  it("refuses the wrong method on the palette", async () => {
    const base = await startDaemon();
    const reply = await post(base, "/api/nodes", {}, await sessionToken(base));
    expect(reply.status).toBe(405);
  });
});

async function waitForStatus(base: string, runId: string, status: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const reply = await get(base, `/api/runs/${encodeURIComponent(runId)}`);
    const current = String((reply.body["run"] as Record<string, unknown>)["status"]);
    if (current === status) return;
    if (Date.now() > deadline) throw new Error(`run is ${current}, expected ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("human approval from an editor graph", () => {
  it("offers the approval node in every palette", async () => {
    const base = await startDaemon();
    const reply = await get(base, "/api/nodes");
    const approval = (
      reply.body["nodes"] as { manifest: { type: string }; pluginId: string }[]
    ).find((node) => node.manifest.type === "harness.human-approval");
    expect(approval?.pluginId).toBe("harness.human-approval-plugin");
  });

  it("pauses for a person, then completes once approved with a fresh token", async () => {
    const base = await startDaemon();
    const token = await sessionToken(base);
    const gated = graph({
      graphId: "approval-graph",
      nodes: [
        {
          id: "gate",
          type: "harness.human-approval",
          version: "1",
          config: { prompt: "Ship it?" },
        },
      ],
      edges: [],
      outputs: [{ id: "decision", schema: true, source: { nodeId: "gate", port: "response" } }],
      entrypoints: [{ id: "main", nodeId: "gate" }],
    });

    const created = await post(base, "/api/runs", { graph: gated }, token);
    expect(created.status).toBe(201);
    const runId = String(created.body["runId"]);
    await waitForStatus(base, runId, "waiting");

    const listed = await get(base, `/api/approvals?runId=${encodeURIComponent(runId)}`);
    const [pending] = listed.body["approvals"] as {
      approvalId: string;
      status: string;
      requestJson: string;
    }[];
    expect(pending?.status).toBe("pending");
    expect(pending?.requestJson).toContain("Ship it?");

    const approvalPath = `/api/approvals/${encodeURIComponent(pending?.approvalId ?? "")}`;
    const issued = await post(base, `${approvalPath}/token`, {}, token);
    expect(issued.status).toBe(200);
    const resumed = await post(
      base,
      `${approvalPath}/resume`,
      { resumeToken: issued.body["resumeToken"], decision: "approved", payload: { ok: true } },
      token,
    );
    expect(resumed.status).toBe(200);

    const run = await waitForRun(base, runId);
    expect(run["status"]).toBe("completed");
  });
});

describe("built-in control-flow nodes on a running daemon", () => {
  it("routes an editor graph through Condition, Route and Wait for all", async () => {
    const base = await startDaemon();
    const token = await sessionToken(base);
    const routed = graph({
      graphId: "control-flow-graph",
      nodes: [
        {
          id: "check",
          type: "harness.condition",
          version: "1",
          config: { operator: "equals", compare: "go" },
          bindings: [{ kind: "literal", port: "value", value: "go" }],
        },
        { id: "route", type: "harness.route", version: "1", config: {} },
        {
          id: "chosen",
          type: "text.upper",
          version: "1",
          config: {},
          bindings: [{ kind: "literal", port: "input", value: "chosen" }],
        },
        {
          id: "other",
          type: "text.upper",
          version: "1",
          config: {},
          bindings: [{ kind: "literal", port: "input", value: "other" }],
        },
        { id: "join", type: "harness.join-all", version: "1", config: {} },
        {
          id: "done",
          type: "text.exclaim",
          version: "1",
          config: {},
          bindings: [{ kind: "literal", port: "input", value: "done" }],
        },
      ],
      edges: [
        {
          id: "c1",
          kind: "data",
          from: { nodeId: "check", port: "branch" },
          to: { nodeId: "route", port: "branch" },
        },
        {
          id: "c2",
          kind: "control",
          from: { nodeId: "route", port: "yes" },
          to: { nodeId: "chosen" },
        },
        {
          id: "c3",
          kind: "control",
          from: { nodeId: "route", port: "no" },
          to: { nodeId: "other" },
        },
        {
          id: "c4",
          kind: "control",
          from: { nodeId: "chosen" },
          to: { nodeId: "join", port: "a" },
        },
        { id: "c5", kind: "control", from: { nodeId: "other" }, to: { nodeId: "join", port: "b" } },
        {
          id: "c6",
          kind: "control",
          from: { nodeId: "join", port: "out" },
          to: { nodeId: "done" },
        },
      ],
      outputs: [{ id: "result", schema: true, source: { nodeId: "done", port: "output" } }],
      entrypoints: [{ id: "main", nodeId: "check" }],
    });

    const created = await post(base, "/api/runs", { graph: routed }, token);
    expect(created.status).toBe(201);
    const run = await waitForRun(base, String(created.body["runId"]));

    expect(run["status"]).toBe("completed");
    const nodes = run["nodes"] as { nodeId: string; status: string }[];
    expect(Object.fromEntries(nodes.map((node) => [node.nodeId, node.status]))).toEqual({
      check: "completed",
      route: "completed",
      chosen: "completed",
      other: "skipped",
      join: "completed",
      done: "completed",
    });
  });
});
