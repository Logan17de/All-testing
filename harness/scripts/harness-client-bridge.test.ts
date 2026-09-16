import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HarnessClient, HarnessClientError } from "@zet-harness/client";
import { SQLITE_MEMORY_PATH } from "@zet-harness/db";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";

import { RuntimeDaemon } from "../apps/runtime/src/runtime-daemon.js";

let root: string;
const daemons: RuntimeDaemon[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zet-bridge-"));
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** A graph that pauses for a person, so the bridge has something to answer. */
const GATED_GRAPH: GraphJsonV1 = {
  schemaVersion: GRAPH_JSON_VERSION,
  graphId: "bridge-graph",
  revisionId: "rev-1",
  inputs: [],
  outputs: [{ id: "result", schema: true, source: { nodeId: "gate", port: "response" } }],
  nodes: [
    { id: "gate", type: "harness.human-approval", version: "1", config: { prompt: "Ship?" } },
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

/** The editor side: everything a person does before handing a client its token. */
async function startHarness() {
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path: SQLITE_MEMORY_PATH },
    probePathLimits: false,
    plugins: { directory: join(root, "plugins") },
  });
  daemons.push(daemon);
  await daemon.start();
  const origin = `http://127.0.0.1:${String(daemon.snapshot().api.port)}`;

  const local = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    const writes = method === "POST";
    const csrf = writes
      ? ((await (await fetch(`${origin}/api/session`)).json()) as { readonly csrfToken: string })
          .csrfToken
      : undefined;
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: writes ? { "content-type": "application/json", "x-zet-csrf": csrf ?? "" } : {},
      ...(writes ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    return (await response.json()) as Record<string, unknown>;
  };

  const issueToken = async (scopes: readonly string[]): Promise<string> => {
    const created = await local("POST", "/api/clients", { name: "Bridge", scopes });
    return created["token"] as string;
  };

  const runStatus = async (runId: string): Promise<string> => {
    const view = await local("GET", `/api/runs/${runId}`);
    return (view["run"] as { readonly status: string }).status;
  };

  const until = async (runId: string, wanted: string): Promise<void> => {
    let status = "";
    for (let tries = 0; tries < 100 && status !== wanted; tries += 1) {
      status = await runStatus(runId);
      if (status !== wanted) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status).toBe(wanted);
  };

  return { origin, local, issueToken, until, runStatus, daemon };
}

describe("the client bridge (9.12)", () => {
  it("carries a client from its token to answering a waiting run", async () => {
    const { origin, local, issueToken, until, runStatus } = await startHarness();
    const token = await issueToken(["read", "messages", "approvals"]);
    const client = new HarnessClient({ origin, token });

    const identity = await client.whoami();
    expect(identity).toMatchObject({ name: "Bridge" });
    expect(identity.scopes).toEqual(["read", "messages", "approvals"]);

    const started = await local("POST", "/api/runs", { graph: GATED_GRAPH });
    const runId = started["runId"] as string;
    await until(runId, "waiting");

    // Watching: the run, and what it is waiting for.
    expect(await client.run(runId)).toMatchObject({ runId, status: "waiting" });
    const waiting = await client.pendingApprovals(runId);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ runId, status: "pending" });

    // Waking is safe at any time and starts nothing.
    expect(await client.wake(runId)).toMatchObject({ runId, status: "waiting", woken: true });

    // Answering carries the run to the end.
    const answered = await client.answerApproval(waiting[0]!.approvalId, "approved", { ok: true });
    expect(answered.duplicate).toBe(false);
    await until(runId, "completed");

    // The same answer again is a duplicate, not a second decision.
    const again = await client.answerApproval(waiting[0]!.approvalId, "approved", { ok: true });
    expect(again.duplicate).toBe(true);
    expect(await runStatus(runId)).toBe("completed");

    // A finished run has nothing to wake, and says so rather than failing.
    expect(await client.wake(runId)).toMatchObject({ status: "completed", woken: false });
    expect(await client.pendingApprovals(runId)).toEqual([]);
  });

  it("adds to a conversation and reports what the harness refuses", async () => {
    const { origin, local, issueToken } = await startHarness();
    const client = new HarnessClient({ origin, token: await issueToken(["read", "messages"]) });

    const project = await local("POST", "/api/projects", { name: "Launch" });
    const projectId = (project["project"] as { readonly projectId: string }).projectId;
    const conversation = await local("POST", `/api/projects/${projectId}/conversations`, {
      title: "Planning",
    });
    const conversationId = (conversation["conversation"] as { readonly conversationId: string })
      .conversationId;

    const sent = await client.sendMessage(conversationId, "Ship on Thursday.");
    expect(sent).toMatchObject({ conversationId, woken: false });

    const read = await local("GET", `/api/conversations/${conversationId}`);
    expect(
      (read["messages"] as { readonly role: string }[]).map((message) => message.role),
    ).toEqual(["user"]);

    // This client may not answer for a person, and the refusal says exactly that.
    const refused = await client
      .answerApproval("approval-v1:00000000-0000-7000-8000-000000000000", "approved")
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HarnessClientError);
    expect(refused).toMatchObject({ code: "CLIENT_SCOPE_MISSING", status: 403 });

    const unknown = await client.run("run-missing").catch((error: unknown) => error);
    expect(unknown).toMatchObject({ status: 404 });
  });

  it("refuses a token the harness does not know, and one that was revoked", async () => {
    const { origin, issueToken } = await startHarness();
    const token = await issueToken(["read"]);
    const client = new HarnessClient({ origin, token });
    const identity = await client.whoami();

    const stranger = new HarnessClient({ origin, token: "not-a-token" });
    const rejected = await stranger.whoami().catch((error: unknown) => error);
    expect(rejected).toMatchObject({ code: "CLIENT_TOKEN_REJECTED", status: 401 });

    const csrf = (
      (await (await fetch(`${origin}/api/session`)).json()) as { readonly csrfToken: string }
    ).csrfToken;
    await fetch(`${origin}/api/clients/${identity.clientId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-zet-csrf": csrf },
    });
    const revoked = await client.whoami().catch((error: unknown) => error);
    expect(revoked).toMatchObject({ code: "CLIENT_REVOKED", status: 401 });
  });

  it("follows the harness's event stream and can carry on from the last id", async () => {
    const { origin, issueToken, daemon } = await startHarness();
    const client = new HarnessClient({ origin, token: await issueToken(["read"]) });

    const controller = new AbortController();
    const received: {
      readonly id: number | null;
      readonly event: string;
      readonly data: unknown;
    }[] = [];
    const reading = (async () => {
      for await (const event of client.events({ signal: controller.signal })) {
        received.push(event);
        if (received.length === 2) break;
      }
    })();

    // Give the stream a moment to open before anything is published to it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const first = daemon.publishEvent("bridge.hello", { step: 1 });
    daemon.publishEvent("bridge.hello", { step: 2 });
    await reading;
    controller.abort();

    expect(received.map((event) => event.event)).toEqual(["bridge.hello", "bridge.hello"]);
    expect(received.map((event) => event.data)).toEqual([{ step: 1 }, { step: 2 }]);
    expect(received[0]?.id).toBe(first.id);

    // Carrying on from the last id seen replays what came after it, and no more.
    const resumed = new AbortController();
    const after: unknown[] = [];
    const rereading = (async () => {
      for await (const event of client.events({ cursor: first.id, signal: resumed.signal })) {
        after.push(event.data);
        break;
      }
    })();
    await rereading;
    resumed.abort();
    expect(after).toEqual([{ step: 2 }]);
  });
});
