import { afterEach, describe, expect, it } from "vitest";

import { SQLITE_MEMORY_PATH } from "@zet-harness/db";

import { RuntimeDaemon } from "./runtime-daemon.js";

const daemons: RuntimeDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
});

async function startDaemon(): Promise<string> {
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path: SQLITE_MEMORY_PATH },
    probePathLimits: false,
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

async function send(
  base: string,
  method: "GET" | "POST",
  path: string,
  options: { readonly body?: unknown; readonly token?: string } = {},
): Promise<JsonReply> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...(options.token === undefined ? {} : { "x-zet-csrf": options.token }),
    },
    ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function object(reply: JsonReply, key: string): Record<string, unknown> {
  return reply.body[key] as Record<string, unknown>;
}

const MISSING_ID = "01890a5d-ac96-774b-bcce-b302099a8057";

describe("conversation endpoints", () => {
  it("starts a conversation, appends messages, branches on retry and reads a branch back", async () => {
    const base = await startDaemon();
    const token = await sessionToken(base);
    const projectId = object(
      await send(base, "POST", "/api/projects", { body: { name: "Chat" }, token }),
      "project",
    )["projectId"] as string;

    const started = await send(base, "POST", `/api/projects/${projectId}/conversations`, {
      body: { title: "First chat" },
      token,
    });
    expect(started.status).toBe(201);
    const conversation = object(started, "conversation");
    expect(conversation).toMatchObject({ projectId, title: "First chat", status: "active" });
    const conversationId = conversation["conversationId"] as string;

    const post = (body: unknown) =>
      send(base, "POST", `/api/conversations/${conversationId}/messages`, { body, token });
    const question = await post({ role: "user", parts: [{ kind: "text", text: "What is 2+2?" }] });
    expect(question.status).toBe(201);
    const questionId = object(question, "message")["messageId"] as string;
    const answer = await post({
      role: "assistant",
      parts: [
        { kind: "reasoning", text: "Add them." },
        { kind: "text", text: "4" },
      ],
    });
    expect(object(answer, "message")).toMatchObject({
      parentMessageId: questionId,
      role: "assistant",
    });
    const retry = await post({
      role: "assistant",
      parts: [{ kind: "text", text: "Four." }],
      parentMessageId: questionId,
    });
    const retryId = object(retry, "message")["messageId"] as string;

    const read = await send(base, "GET", `/api/conversations/${conversationId}`);
    expect(read.status).toBe(200);
    expect(object(read, "conversation")).toMatchObject({ conversationId, title: "First chat" });
    expect(read.body["messages"] as unknown[]).toHaveLength(3);

    const branch = await send(
      base,
      "GET",
      `/api/conversations/${conversationId}/messages/${retryId}/path`,
    );
    expect(
      (branch.body["messages"] as { readonly messageId: string }[]).map((item) => item.messageId),
    ).toEqual([questionId, retryId]);

    const listed = await send(base, "GET", `/api/projects/${projectId}/conversations`);
    expect(listed.body["conversations"] as unknown[]).toHaveLength(1);

    const renamed = await send(base, "POST", `/api/conversations/${conversationId}`, {
      body: { title: "Arithmetic" },
      token,
    });
    expect(object(renamed, "conversation")).toMatchObject({ title: "Arithmetic" });

    expect(
      (await send(base, "POST", `/api/conversations/${conversationId}/archive`, { token })).status,
    ).toBe(200);
    const refused = await post({ role: "user", parts: [{ kind: "text", text: "Still there?" }] });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "CONVERSATION_ARCHIVED" } });
    const restored = await send(base, "POST", `/api/conversations/${conversationId}/restore`, {
      token,
    });
    expect(object(restored, "conversation")).toMatchObject({ status: "active" });
  });

  it("refuses unknown projects and conversations, malformed messages, and writes without the session token", async () => {
    const base = await startDaemon();
    const token = await sessionToken(base);

    expect(
      (await send(base, "GET", `/api/projects/${MISSING_ID}/conversations`)).body,
    ).toMatchObject({ error: { code: "PROJECT_NOT_FOUND" } });
    expect(
      (await send(base, "POST", `/api/projects/${MISSING_ID}/conversations`, { token })).status,
    ).toBe(404);
    expect((await send(base, "GET", `/api/conversations/${MISSING_ID}`)).body).toMatchObject({
      error: { code: "CONVERSATION_NOT_FOUND" },
    });

    const projectId = object(
      await send(base, "POST", "/api/projects", { body: { name: "P" }, token }),
      "project",
    )["projectId"] as string;
    expect((await send(base, "POST", `/api/projects/${projectId}/conversations`)).status).toBe(403);
    const conversationId = object(
      await send(base, "POST", `/api/projects/${projectId}/conversations`, { token }),
      "conversation",
    )["conversationId"] as string;

    const cases: readonly (readonly [unknown, string])[] = [
      [{ role: "user" }, "parts"],
      [{ role: 7, parts: [] }, "role"],
      [
        { role: "user", parts: [{ kind: "tool-call", callId: "c", name: "n", arguments: {} }] },
        "parts[0]",
      ],
      [{ role: "user", parts: [{ kind: "text", text: "hi" }], mood: "happy" }, "mood"],
      [
        { role: "user", parts: [{ kind: "text", text: "hi" }], parentMessageId: MISSING_ID },
        "parentMessageId",
      ],
    ];
    for (const [body, field] of cases) {
      const reply = await send(base, "POST", `/api/conversations/${conversationId}/messages`, {
        body,
        token,
      });
      expect(reply.status).toBe(400);
      expect(reply.body["error"]).toMatchObject({ code: "CONVERSATION_INVALID", field });
    }

    expect(
      (await send(base, "GET", `/api/conversations/${conversationId}/messages/${MISSING_ID}/path`))
        .status,
    ).toBe(404);
    expect((await send(base, "GET", `/api/conversations/${conversationId}/archive`)).status).toBe(
      405,
    );
  });
});
