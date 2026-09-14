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

describe("goal and todo endpoints", () => {
  it("plans a goal with ordered, dependent todos and moves it to completion", async () => {
    const base = await startDaemon();
    const token = await sessionToken(base);
    const projectId = object(
      await send(base, "POST", "/api/projects", { body: { name: "Site" }, token }),
      "project",
    )["projectId"] as string;
    const conversationId = object(
      await send(base, "POST", `/api/projects/${projectId}/conversations`, { token }),
      "conversation",
    )["conversationId"] as string;

    const created = await send(base, "POST", `/api/projects/${projectId}/goals`, {
      body: { title: "Ship the landing page", priority: 10, conversationId },
      token,
    });
    expect(created.status).toBe(201);
    expect(object(created, "goal")).toMatchObject({
      title: "Ship the landing page",
      priority: 10,
      status: "open",
      conversationId,
    });
    const goalId = object(created, "goal")["goalId"] as string;

    const todo = async (body: unknown) =>
      object(await send(base, "POST", `/api/goals/${goalId}/todos`, { body, token }), "todo");
    const design = await todo({ title: "Design" });
    const designId = design["todoId"] as string;
    const build = await todo({ title: "Build", dependsOn: [designId] });
    const buildId = build["todoId"] as string;
    expect(design).toMatchObject({ position: 0, status: "pending", dependsOn: [] });
    expect(build).toMatchObject({ position: 1, dependsOn: [designId] });

    const status = (todoId: string, body: unknown) =>
      send(base, "POST", `/api/todos/${todoId}/status`, { body, token });
    expect((await status(buildId, { status: "in_progress" })).body).toMatchObject({
      error: { code: "TODO_DEPENDENCIES_UNFINISHED" },
    });
    expect(
      (
        await send(base, "POST", `/api/goals/${goalId}/status`, {
          body: { status: "completed" },
          token,
        })
      ).body,
    ).toMatchObject({ error: { code: "GOAL_HAS_OPEN_TODOS" } });

    expect(object(await status(designId, { status: "in_progress" }), "todo")).toMatchObject({
      status: "in_progress",
      startedAtMs: expect.any(Number) as unknown,
    });
    expect(object(await status(designId, { status: "done" }), "todo")).toMatchObject({
      status: "done",
      finishedAtMs: expect.any(Number) as unknown,
    });

    const unexplained = await status(buildId, { status: "blocked" });
    expect(unexplained.status).toBe(400);
    expect(unexplained.body).toMatchObject({ error: { field: "reason" } });
    expect(
      object(await status(buildId, { status: "blocked", reason: "Waiting on copy" }), "todo"),
    ).toMatchObject({ blockedReason: "Waiting on copy" });
    const skipped = await status(buildId, { status: "done" });
    expect(skipped.status).toBe(409);
    expect(skipped.body).toMatchObject({ error: { code: "TODO_TRANSITION_INVALID" } });
    expect((await status(buildId, { status: "in_progress" })).status).toBe(200);
    expect((await status(buildId, { status: "done" })).status).toBe(200);

    const read = await send(base, "GET", `/api/goals/${goalId}`);
    expect(
      (read.body["todos"] as { readonly status: string }[]).map((item) => item.status),
    ).toEqual(["done", "done"]);
    expect(object(await send(base, "GET", `/api/todos/${buildId}`), "todo")).toMatchObject({
      todoId: buildId,
      dependsOn: [designId],
    });

    const completed = await send(base, "POST", `/api/goals/${goalId}/status`, {
      body: { status: "completed" },
      token,
    });
    expect(object(completed, "goal")).toMatchObject({
      status: "completed",
      closedAtMs: expect.any(Number) as unknown,
    });
    expect(
      (await send(base, "POST", `/api/goals/${goalId}/todos`, { body: { title: "Late" }, token }))
        .status,
    ).toBe(409);
    expect(
      (await send(base, "GET", `/api/projects/${projectId}/goals?status=completed`)).body[
        "goals"
      ] as unknown[],
    ).toHaveLength(1);
  });

  it("refuses unknown ids, malformed input, and writes without the session token", async () => {
    const base = await startDaemon();
    const token = await sessionToken(base);

    expect((await send(base, "GET", `/api/projects/${MISSING_ID}/goals`)).body).toMatchObject({
      error: { code: "PROJECT_NOT_FOUND" },
    });
    expect((await send(base, "GET", `/api/goals/${MISSING_ID}`)).body).toMatchObject({
      error: { code: "GOAL_NOT_FOUND" },
    });
    expect((await send(base, "GET", "/api/todos/not-an-id")).body).toMatchObject({
      error: { code: "TODO_NOT_FOUND" },
    });

    const projectId = object(
      await send(base, "POST", "/api/projects", { body: { name: "P" }, token }),
      "project",
    )["projectId"] as string;
    expect(
      (
        await send(base, "POST", `/api/projects/${projectId}/goals`, {
          body: { title: "No token" },
        })
      ).status,
    ).toBe(403);

    const goalCases: readonly (readonly [unknown, string])[] = [
      [{}, "title"],
      [{ title: "x", priority: 1.5 }, "priority"],
      [{ title: "x", colour: "red" }, "colour"],
      [{ title: "x", conversationId: MISSING_ID }, "conversationId"],
    ];
    for (const [body, field] of goalCases) {
      const reply = await send(base, "POST", `/api/projects/${projectId}/goals`, { body, token });
      expect(reply.status).toBe(400);
      expect(reply.body["error"]).toMatchObject({ code: "GOAL_INVALID", field });
    }

    const goalId = object(
      await send(base, "POST", `/api/projects/${projectId}/goals`, {
        body: { title: "Real" },
        token,
      }),
      "goal",
    )["goalId"] as string;
    const todoCases: readonly (readonly [unknown, string])[] = [
      [{ title: "t", dependsOn: "nope" }, "dependsOn"],
      [{ title: "t", dependsOn: [MISSING_ID] }, "dependsOn"],
    ];
    for (const [body, field] of todoCases) {
      const reply = await send(base, "POST", `/api/goals/${goalId}/todos`, { body, token });
      expect(reply.status).toBe(400);
      expect(reply.body["error"]).toMatchObject({ field });
    }
    const badStatus = await send(base, "POST", `/api/goals/${goalId}/status`, {
      body: { status: "finished" },
      token,
    });
    expect(badStatus.status).toBe(400);
    expect(badStatus.body["error"]).toMatchObject({ field: "status" });
    expect((await send(base, "GET", `/api/goals/${goalId}/status`)).status).toBe(405);
  });
});
