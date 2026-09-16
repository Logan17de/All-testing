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
  root = await mkdtemp(join(tmpdir(), "zet-revisions-"));
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

function graph(revisionId: string, changes: Partial<GraphJsonV1> = {}): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "watched",
    revisionId,
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
    ...changes,
  };
}

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
  const send = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> => {
    const writes = method === "POST";
    const csrf = writes
      ? ((await (await fetch(`${base}/api/session`)).json()) as { readonly csrfToken: string })
          .csrfToken
      : undefined;
    const response = await fetch(`${base}${path}`, {
      method,
      headers: writes ? { "content-type": "application/json", "x-zet-csrf": csrf ?? "" } : {},
      ...(writes ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { send };
}

describe("graph revisions and diffs (11.5)", () => {
  it("lists the revisions that were run, and what changed between two of them", async () => {
    const { send } = await startDaemon();

    await send("POST", "/api/runs", { graph: graph("rev-1") });
    // The new node is wired in: the compiler refuses a node nothing can reach.
    await send("POST", "/api/runs", {
      graph: graph("rev-2", {
        nodes: [
          {
            id: "check",
            type: "harness.condition",
            version: "1",
            config: { operator: "equals", compare: "stop" },
            bindings: [{ kind: "literal", port: "value", value: "go" }],
          },
          {
            id: "second",
            type: "harness.condition",
            version: "1",
            config: { operator: "equals", compare: "go" },
            bindings: [{ kind: "literal", port: "value", value: "go" }],
          },
        ],
        edges: [
          { id: "then", kind: "control", from: { nodeId: "check" }, to: { nodeId: "second" } },
        ],
      }),
    });

    const listed = await send("GET", "/api/graphs/watched/revisions");
    expect(listed.status).toBe(200);
    const revisions = listed.body["revisions"] as {
      readonly revisionId: string;
      readonly runs: number;
      readonly semanticHash: string;
    }[];
    expect(revisions.map((entry) => entry.revisionId).sort()).toEqual(["rev-1", "rev-2"]);
    expect(revisions.every((entry) => entry.runs === 1)).toBe(true);
    // Two different graphs compile to two different plans.
    expect(revisions[0]?.semanticHash).not.toBe(revisions[1]?.semanticHash);

    const diff = await send("GET", "/api/graphs/watched/diff?from=rev-1&to=rev-2");
    expect(diff.status).toBe(200);
    expect(diff.body["diff"]).toMatchObject({
      graphId: "watched",
      from: "rev-1",
      to: "rev-2",
      sameSemantics: false,
      summary: "1 node added, 1 node changed, 1 edge added.",
    });
    const changed = (diff.body["diff"] as { readonly nodesChanged: { readonly nodeId: string }[] })
      .nodesChanged;
    expect(changed.map((entry) => entry.nodeId)).toEqual(["check"]);
  });

  it("returns the document a revision ran with", async () => {
    const { send } = await startDaemon();
    await send("POST", "/api/runs", { graph: graph("rev-1") });

    const read = await send("GET", "/api/graphs/watched/revisions/rev-1");
    expect(read.status).toBe(200);
    expect(read.body["graph"]).toMatchObject({ graphId: "watched", revisionId: "rev-1" });
  });

  it("says when a revision or the ends of a diff are missing", async () => {
    const { send } = await startDaemon();
    await send("POST", "/api/runs", { graph: graph("rev-1") });

    expect((await send("GET", "/api/graphs/watched/revisions/rev-9")).status).toBe(404);
    const missing = await send("GET", "/api/graphs/watched/diff?from=rev-1&to=rev-9");
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: "GRAPH_REVISION_NOT_FOUND" } });
    expect((await send("GET", "/api/graphs/watched/diff?from=rev-1")).status).toBe(400);
    // A graph nobody ran has no revisions, which is an empty list rather than an error.
    expect((await send("GET", "/api/graphs/unknown/revisions")).body["revisions"]).toEqual([]);
    expect((await send("POST", "/api/graphs/watched/revisions")).status).toBe(405);
  });
});
