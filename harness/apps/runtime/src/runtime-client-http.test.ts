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
  root = await mkdtemp(join(tmpdir(), "zet-client-http-"));
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** A graph that pauses for a person, so a client has an approval to answer. */
const GATED_GRAPH: GraphJsonV1 = {
  schemaVersion: GRAPH_JSON_VERSION,
  graphId: "client-graph",
  revisionId: "rev-1",
  inputs: [],
  outputs: [{ id: "result", schema: true, source: { nodeId: "gate", port: "response" } }],
  nodes: [
    {
      id: "gate",
      type: "harness.human-approval",
      version: "1",
      config: { prompt: "Ship it?" },
    },
  ],
  edges: [],
  entrypoints: [{ id: "main", nodeId: "gate" }],
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

  /** The editor's way in: loopback plus the CSRF token. */
  const local = async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Reply> => {
    const writes = method !== "GET";
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

  /** A client's way in: a token, and no browser session at all. */
  const client = async (
    token: string | undefined,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Reply> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const until = async (runId: string, wanted: string): Promise<void> => {
    let status = "";
    for (let tries = 0; tries < 100 && status !== wanted; tries += 1) {
      const view = await local("GET", `/api/runs/${runId}`);
      status = (view.body["run"] as { readonly status: string }).status;
      if (status !== wanted) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status).toBe(wanted);
  };

  return { local, client, until };
}

describe("external client ingress (9.11)", () => {
  it("issues a token once, then answers to it instead of a browser session", async () => {
    const { local, client } = await startDaemon();

    const created = await local("POST", "/api/clients", {
      name: "Phone",
      scopes: ["read", "messages"],
    });
    expect(created.status).toBe(201);
    const token = created.body["token"] as string;
    const record = created.body["client"] as { readonly clientId: string };
    expect(typeof token).toBe("string");

    // Shown once: reading the client back never reveals it again.
    const read = await local("GET", `/api/clients/${record.clientId}`);
    expect(read.body["token"]).toBeUndefined();
    expect(read.body["client"]).toMatchObject({ name: "Phone", scopes: ["read", "messages"] });

    const whoami = await client(token, "GET", "/api/client/whoami");
    expect(whoami.status).toBe(200);
    expect(whoami.body["client"]).toMatchObject({ clientId: record.clientId });

    expect((await client(undefined, "GET", "/api/client/whoami")).status).toBe(401);
    expect((await client("not-a-token", "GET", "/api/client/whoami")).status).toBe(401);

    // The client's last use is recorded, so a person can see what is still in use.
    const listed = await local("GET", "/api/clients");
    expect((listed.body["clients"] as { readonly lastSeenAtMs: number | null }[])[0]).toMatchObject(
      { name: "Phone" },
    );
  });

  it("keeps scopes apart and stops a revoked client", async () => {
    const { local, client } = await startDaemon();
    const watcher = await local("POST", "/api/clients", { name: "Watcher", scopes: ["read"] });
    const token = watcher.body["token"] as string;
    const clientId = (watcher.body["client"] as { readonly clientId: string }).clientId;

    expect((await client(token, "GET", "/api/client/approvals")).status).toBe(200);
    // Reading is allowed; acting is not.
    const refused = await client(token, "POST", "/api/client/runs/run-missing/wake");
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "CLIENT_SCOPE_MISSING" } });

    const revoked = await local("DELETE", `/api/clients/${clientId}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body["client"]).toMatchObject({ name: "Watcher" });
    const after = await client(token, "GET", "/api/client/whoami");
    expect(after.status).toBe(401);
    expect(after.body).toMatchObject({ error: { code: "CLIENT_REVOKED" } });
  });

  it("wakes a run without creating work, and says so for a run that has finished", async () => {
    const { local, client, until } = await startDaemon();
    const session = await local("POST", "/api/clients", {
      name: "Bridge",
      scopes: ["read", "messages", "approvals"],
    });
    const token = session.body["token"] as string;

    const started = await local("POST", "/api/runs", { graph: GATED_GRAPH });
    const runId = started.body["runId"] as string;
    await until(runId, "waiting");

    const woken = await client(token, "POST", `/api/client/runs/${runId}/wake`);
    expect(woken.status).toBe(200);
    expect(woken.body).toMatchObject({ runId, status: "waiting", woken: true });
    // Waking again changes nothing: it only asks the dispatcher to look.
    expect((await client(token, "POST", `/api/client/runs/${runId}/wake`)).body).toMatchObject({
      woken: true,
    });

    const view = await client(token, "GET", `/api/client/runs/${runId}`);
    expect(view.body["run"]).toMatchObject({ runId, status: "waiting" });
    expect((await client(token, "POST", "/api/client/runs/run-missing/wake")).status).toBe(404);
  });

  it("answers a waiting approval once, and reports a repeated answer as a duplicate", async () => {
    const { local, client, until } = await startDaemon();
    const session = await local("POST", "/api/clients", {
      name: "Phone",
      scopes: ["read", "approvals"],
    });
    const token = session.body["token"] as string;

    const started = await local("POST", "/api/runs", { graph: GATED_GRAPH });
    const runId = started.body["runId"] as string;
    await until(runId, "waiting");

    const pending = await client(token, "GET", `/api/client/approvals?runId=${runId}`);
    const approval = (pending.body["approvals"] as { readonly approvalId: string }[])[0];
    expect(approval).toBeDefined();

    const answered = await client(token, "POST", `/api/client/approvals/${approval!.approvalId}`, {
      decision: "approved",
      payload: { ok: true },
    });
    expect(answered.status).toBe(200);
    expect(answered.body["approval"]).toMatchObject({ status: "approved" });
    await until(runId, "completed");

    // The same answer again is reported as the duplicate it is, not applied twice.
    const again = await client(token, "POST", `/api/client/approvals/${approval!.approvalId}`, {
      decision: "approved",
      payload: { ok: true },
    });
    expect(again.status).toBe(200);
    expect(again.body["duplicate"]).toBe(true);

    const bad = await client(token, "POST", `/api/client/approvals/${approval!.approvalId}`, {
      decision: "maybe",
    });
    expect(bad.status).toBe(400);
  });

  it("adds a message to a conversation and wakes the run working on it", async () => {
    const { local, client } = await startDaemon();
    const session = await local("POST", "/api/clients", {
      name: "Bridge",
      scopes: ["read", "messages"],
    });
    const token = session.body["token"] as string;
    const project = await local("POST", "/api/projects", { name: "Launch" });
    const projectId = (project.body["project"] as { readonly projectId: string }).projectId;
    const conversation = await local("POST", `/api/projects/${projectId}/conversations`, {
      title: "Planning",
    });
    const conversationId = (
      conversation.body["conversation"] as { readonly conversationId: string }
    ).conversationId;

    const sent = await client(
      token,
      "POST",
      `/api/client/conversations/${conversationId}/messages`,
      { text: "Ship on Thursday." },
    );
    expect(sent.status).toBe(201);
    expect(sent.body["message"]).toMatchObject({ role: "user", conversationId });
    expect(sent.body["woken"]).toBe(false);

    const read = await local("GET", `/api/conversations/${conversationId}`);
    expect((read.body["messages"] as { readonly role: string }[]).map((m) => m.role)).toEqual([
      "user",
    ]);

    const empty = await client(
      token,
      "POST",
      `/api/client/conversations/${conversationId}/messages`,
      { text: "   " },
    );
    expect(empty.status).toBe(400);
    const unknown = await client(
      token,
      "POST",
      "/api/client/conversations/00000000-0000-7000-8000-000000000000/messages",
      { text: "Hello" },
    );
    expect(unknown.status).toBe(404);
  });
});
