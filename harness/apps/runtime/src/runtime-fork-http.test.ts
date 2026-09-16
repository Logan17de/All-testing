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
  root = await mkdtemp(join(tmpdir(), "zet-fork-http-"));
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** A graph of one built-in condition node, so no plugin package is needed. */
const GRAPH: GraphJsonV1 = {
  schemaVersion: GRAPH_JSON_VERSION,
  graphId: "fork-http",
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

describe("POST /api/runs/:id/fork", () => {
  it("forks a finished run into a new run that completes, and refuses bad fork points", async () => {
    const daemon = new RuntimeDaemon({
      api: { port: 0 },
      database: { path: SQLITE_MEMORY_PATH },
      probePathLimits: false,
      plugins: { directory: join(root, "plugins") },
    });
    daemons.push(daemon);
    await daemon.start();
    const base = `http://127.0.0.1:${String(daemon.snapshot().api.port)}`;
    const send = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> => {
      const session = (await (await fetch(`${base}/api/session`)).json()) as {
        readonly csrfToken: string;
      };
      const response = await fetch(`${base}${path}`, {
        method,
        headers:
          method === "POST"
            ? { "content-type": "application/json", "x-zet-csrf": session.csrfToken }
            : {},
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
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

    const created = await send("POST", "/api/runs", { graph: GRAPH });
    expect(created.status).toBe(201);
    const runId = created.body["runId"] as string;
    await until(runId, "completed");

    const forked = await send("POST", `/api/runs/${runId}/fork`, {});
    expect(forked.status).toBe(201);
    expect(forked.body).toMatchObject({
      fork: { parentRunId: runId, reused: 1, rerun: 0 },
      dispatched: true,
    });
    const forkId = (forked.body["fork"] as { readonly runId: string }).runId;
    await until(forkId, "completed");

    const replay = await send("GET", `/api/runs/${forkId}/replay`);
    expect(replay.body["replay"]).toMatchObject({
      runId: forkId,
      status: "completed",
      consistent: true,
    });
    const steps = (replay.body["replay"] as { readonly steps: readonly Record<string, unknown>[] })
      .steps;
    expect(steps.map((step) => [step["kind"], step["nodeId"], step["outcome"]])).toEqual([
      ["attempt", "check", "completed"],
      ["run", null, "forked"],
      ["run", null, "completed"],
    ]);

    const bad = await send("POST", `/api/runs/${runId}/fork`, { throughEventId: "soon" });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ error: { code: "FORK_POINT_INVALID" } });
    const missing = await send("POST", "/api/runs/run-missing/fork", {});
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: "RUN_NOT_FOUND" } });
    expect((await send("GET", `/api/runs/${runId}/fork`)).status).toBe(405);
  });
});
