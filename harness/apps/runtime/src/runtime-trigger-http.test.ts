import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SQLITE_MEMORY_PATH } from "@zet-harness/db";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";

import { RuntimeDaemon } from "./runtime-daemon.js";

let root: string;
const daemons: RuntimeDaemon[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zet-trigger-http-"));
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** One built-in condition node, so no plugin package is needed. */
const GRAPH: GraphJsonV1 = {
  schemaVersion: GRAPH_JSON_VERSION,
  graphId: "trigger-graph",
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

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function startDaemon() {
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path: SQLITE_MEMORY_PATH },
    probePathLimits: false,
    plugins: { directory: join(root, "plugins") },
  });
  daemons.push(daemon);
  await daemon.start();
  const base = `http://127.0.0.1:${String(daemon.snapshot().api.port)}`;
  const send = async (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { readonly body?: unknown; readonly headers?: Record<string, string> } = {},
  ): Promise<Reply> => {
    const writes = method !== "GET";
    const token = writes
      ? ((await (await fetch(`${base}/api/session`)).json()) as { readonly csrfToken: string })
          .csrfToken
      : undefined;
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(writes ? { "content-type": "application/json", "x-zet-csrf": token ?? "" } : {}),
        ...options.headers,
      },
      ...(writes ? { body: JSON.stringify(options.body ?? {}) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const until = async (runId: string, wanted: string): Promise<void> => {
    let status = "";
    for (let tries = 0; tries < 100 && status !== wanted; tries += 1) {
      const view = await send("GET", `/api/runs/${runId}`);
      status = (view.body["run"] as { readonly status: string }).status;
      if (status !== wanted) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status).toBe(wanted);
  };
  return { send, until };
}

describe("trigger endpoints (9.9)", () => {
  it("creates a manual trigger, fires it into a run, and lists it", async () => {
    const { send, until } = await startDaemon();

    const created = await send("POST", "/api/triggers", {
      body: { name: "Check the site", kind: "manual", graph: GRAPH },
    });
    expect(created.status).toBe(201);
    const trigger = created.body["trigger"] as {
      readonly triggerId: string;
      readonly kind: string;
      readonly enabled: boolean;
      readonly hasToken: boolean;
      readonly lastRunId: string | null;
    };
    expect(trigger).toMatchObject({ kind: "manual", enabled: true, hasToken: false });
    expect(created.body["token"]).toBeUndefined();

    const fired = await send("POST", `/api/triggers/${trigger.triggerId}/fire`);
    expect(fired.status).toBe(201);
    expect(fired.body["dispatched"]).toBe(true);
    const runId = fired.body["runId"] as string;
    await until(runId, "completed");

    const read = await send("GET", `/api/triggers/${trigger.triggerId}`);
    expect(read.body["trigger"]).toMatchObject({ lastRunId: runId });
    const listed = await send("GET", "/api/triggers");
    expect((listed.body["triggers"] as unknown[]).length).toBe(1);
  });

  it("gives a webhook trigger a token once and takes it at the hook", async () => {
    const { send, until } = await startDaemon();

    const created = await send("POST", "/api/triggers", {
      body: { name: "Deploy hook", kind: "webhook", graph: GRAPH },
    });
    expect(created.status).toBe(201);
    const token = created.body["token"] as string;
    expect(typeof token).toBe("string");
    const triggerId = (created.body["trigger"] as { readonly triggerId: string }).triggerId;
    expect(created.body["trigger"]).toMatchObject({ kind: "webhook", hasToken: true });

    // The token is shown once and never read back.
    expect((await send("GET", `/api/triggers/${triggerId}`)).body["token"]).toBeUndefined();

    const rejected = await send("POST", `/api/hooks/${triggerId}`, {
      headers: { "x-zet-trigger-token": "not-the-token" },
    });
    expect(rejected.status).toBe(401);
    expect((await send("POST", `/api/hooks/${triggerId}`)).status).toBe(401);

    const fired = await send("POST", `/api/hooks/${triggerId}`, {
      headers: { "x-zet-trigger-token": token },
    });
    expect(fired.status).toBe(201);
    await until(fired.body["runId"] as string, "completed");
  });

  it("keeps a cron trigger's schedule and refuses one that is not a schedule", async () => {
    const { send } = await startDaemon();

    const created = await send("POST", "/api/triggers", {
      body: { name: "Nightly", kind: "cron", cron: "0 3 * * *", graph: GRAPH },
    });
    expect(created.status).toBe(201);
    const trigger = created.body["trigger"] as {
      readonly triggerId: string;
      readonly cronExpression: string;
      readonly nextFireAtMs: number;
    };
    expect(trigger.cronExpression).toBe("0 3 * * *");
    expect(trigger.nextFireAtMs).toBeGreaterThan(Date.now());
    expect(new Date(trigger.nextFireAtMs).getUTCHours()).toBe(3);

    const changed = await send("PATCH", `/api/triggers/${trigger.triggerId}`, {
      body: { cron: "*/30 * * * *", enabled: false },
    });
    expect(changed.body["trigger"]).toMatchObject({
      cronExpression: "*/30 * * * *",
      enabled: false,
    });

    // A disabled trigger does not start work.
    const refused = await send("POST", `/api/triggers/${trigger.triggerId}/fire`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "TRIGGER_DISABLED" } });

    const bad = await send("POST", "/api/triggers", {
      body: { name: "Never", kind: "cron", cron: "every night", graph: GRAPH },
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: { code: "TRIGGER_INVALID", field: "cron" } });
    const missing = await send("POST", "/api/triggers", {
      body: { name: "No schedule", kind: "cron", graph: GRAPH },
    });
    expect(missing.status).toBe(400);
  });

  it("refuses unknown ids, unknown kinds, a bad graph and unknown fields, and deletes", async () => {
    const { send } = await startDaemon();
    const created = await send("POST", "/api/triggers", {
      body: { name: "Check", kind: "manual", graph: GRAPH },
    });
    const triggerId = (created.body["trigger"] as { readonly triggerId: string }).triggerId;

    expect((await send("GET", "/api/triggers/00000000-0000-7000-8000-000000000000")).status).toBe(
      404,
    );
    expect((await send("POST", "/api/triggers/not-an-id/fire")).status).toBe(404);
    const badKind = await send("POST", "/api/triggers", {
      body: { name: "Odd", kind: "telepathy", graph: GRAPH },
    });
    expect(badKind.status).toBe(400);
    const badGraph = await send("POST", "/api/triggers", {
      body: { name: "Broken", kind: "manual", graph: { ...GRAPH, nodes: [] } },
    });
    expect(badGraph.status).toBe(422);
    expect(badGraph.body).toMatchObject({ error: { code: "GRAPH_INVALID" } });
    const noGraph = await send("POST", "/api/triggers", {
      body: { name: "Nothing to run", kind: "manual" },
    });
    expect(noGraph.status).toBe(400);
    const unknownField = await send("PATCH", `/api/triggers/${triggerId}`, {
      body: { colour: "red" },
    });
    expect(unknownField.status).toBe(400);

    expect(await send("DELETE", `/api/triggers/${triggerId}`)).toMatchObject({
      status: 200,
      body: { deleted: true },
    });
    expect((await send("GET", `/api/triggers/${triggerId}`)).status).toBe(404);
  });
});
