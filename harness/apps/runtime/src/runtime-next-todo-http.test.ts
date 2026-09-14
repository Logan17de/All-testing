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

function id(reply: JsonReply, key: string, field: string): string {
  return (reply.body[key] as Record<string, unknown>)[field] as string;
}

const MISSING_ID = "01890a5d-ac96-774b-bcce-b302099a8057";

describe("next runnable todo endpoints", () => {
  it("serves the next todo to take and every runnable todo, in order", async () => {
    const base = await startDaemon();
    const token = await sessionToken(base);
    const projectId = id(
      await send(base, "POST", "/api/projects", { body: { name: "Site" }, token }),
      "project",
      "projectId",
    );
    const goal = async (title: string, priority: number) =>
      id(
        await send(base, "POST", `/api/projects/${projectId}/goals`, {
          body: { title, priority },
          token,
        }),
        "goal",
        "goalId",
      );
    const first = await goal("First", 5);
    const second = await goal("Second", 50);
    const todo = async (goalId: string, body: unknown) =>
      id(await send(base, "POST", `/api/goals/${goalId}/todos`, { body, token }), "todo", "todoId");
    const design = await todo(first, { title: "Design" });
    const build = await todo(first, { title: "Build", dependsOn: [design] });
    const other = await todo(second, { title: "Other" });

    const next = async () =>
      (await send(base, "GET", `/api/projects/${projectId}/todos/next`)).body;
    const status = (todoId: string, value: string) =>
      send(base, "POST", `/api/todos/${todoId}/status`, { body: { status: value }, token });

    expect(await next()).toMatchObject({ todo: { todoId: design }, goal: { goalId: first } });
    const runnable = await send(base, "GET", `/api/projects/${projectId}/todos/runnable`);
    expect(
      (runnable.body["todos"] as { readonly todo: { readonly todoId: string } }[]).map(
        (item) => item.todo.todoId,
      ),
    ).toEqual([design, other]);

    await status(design, "in_progress");
    expect(await next()).toMatchObject({ todo: { todoId: other } });
    await status(design, "done");
    expect(await next()).toMatchObject({ todo: { todoId: build } });

    const scoped = await send(
      base,
      "GET",
      `/api/projects/${projectId}/todos/runnable?goalId=${second}`,
    );
    expect(scoped.body["todos"] as unknown[]).toHaveLength(1);
    expect(
      (await send(base, "GET", `/api/projects/${projectId}/todos/runnable?limit=1`)).body[
        "todos"
      ] as unknown[],
    ).toHaveLength(1);
    const badLimit = await send(base, "GET", `/api/projects/${projectId}/todos/runnable?limit=0`);
    expect(badLimit.status).toBe(400);
    expect(badLimit.body["error"]).toMatchObject({ field: "limit" });

    await status(build, "in_progress");
    await status(build, "done");
    await status(other, "done");
    expect(await next()).toEqual({ todo: null, goal: null });

    expect((await send(base, "GET", `/api/projects/${MISSING_ID}/todos/next`)).body).toMatchObject({
      error: { code: "PROJECT_NOT_FOUND" },
    });
    expect(
      (await send(base, "POST", `/api/projects/${projectId}/todos/next`, { token })).status,
    ).toBe(405);
  });
});
