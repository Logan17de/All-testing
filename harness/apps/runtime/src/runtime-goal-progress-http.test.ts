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

async function send(
  base: string,
  method: "GET" | "POST",
  path: string,
  options: { readonly body?: unknown; readonly token?: string } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...(options.token === undefined ? {} : { "x-zet-csrf": options.token }),
    },
    ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
  });
  return (await response.json()) as Record<string, unknown>;
}

const field = (reply: Record<string, unknown>, key: string, name: string): string =>
  (reply[key] as Record<string, string>)[name] ?? "";

describe("goal progress over HTTP", () => {
  it("blocks, reopens and completes a goal as its todos change", async () => {
    const base = await startDaemon();
    const token = await sessionToken(base);
    const projectId = field(
      await send(base, "POST", "/api/projects", { body: { name: "Site" }, token }),
      "project",
      "projectId",
    );
    const goalId = field(
      await send(base, "POST", `/api/projects/${projectId}/goals`, {
        body: { title: "Launch" },
        token,
      }),
      "goal",
      "goalId",
    );
    const assets = field(
      await send(base, "POST", `/api/goals/${goalId}/todos`, { body: { title: "Assets" }, token }),
      "todo",
      "todoId",
    );
    const page = field(
      await send(base, "POST", `/api/goals/${goalId}/todos`, {
        body: { title: "Page", dependsOn: [assets] },
        token,
      }),
      "todo",
      "todoId",
    );
    const status = (todoId: string, body: unknown) =>
      send(base, "POST", `/api/todos/${todoId}/status`, { body, token });
    const goal = async () => (await send(base, "GET", `/api/goals/${goalId}`))["goal"];

    await status(assets, { status: "blocked", reason: "Waiting on the designer" });
    expect(await goal()).toMatchObject({
      status: "blocked",
      blockedBy: "todos",
      blockedReason: "Waiting on blocked todos: Assets",
    });

    await status(assets, { status: "in_progress" });
    expect(await goal()).toMatchObject({ status: "open", blockedBy: null });

    await status(assets, { status: "done" });
    expect(await goal()).toMatchObject({ status: "open" });
    await status(page, { status: "done" });
    expect(await goal()).toMatchObject({
      status: "completed",
      closedAtMs: expect.any(Number) as unknown,
    });

    await send(base, "POST", `/api/goals/${goalId}/status`, { body: { status: "open" }, token });
    expect(await goal()).toMatchObject({ status: "open", closedAtMs: null });
  });
});
