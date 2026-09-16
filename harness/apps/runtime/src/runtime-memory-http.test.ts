import { afterEach, describe, expect, it } from "vitest";

import { SQLITE_MEMORY_PATH } from "@zet-harness/db";

import { RuntimeDaemon } from "./runtime-daemon.js";

const daemons: RuntimeDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
});

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function startDaemon(): Promise<{
  readonly send: (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ) => Promise<Reply>;
}> {
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path: SQLITE_MEMORY_PATH },
    probePathLimits: false,
  });
  daemons.push(daemon);
  await daemon.start();
  const base = `http://127.0.0.1:${String(daemon.snapshot().api.port)}`;
  const send = async (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
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
      },
      ...(writes ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { send };
}

describe("memory endpoints", () => {
  it("remembers, lists, changes, pins and forgets", async () => {
    const { send } = await startDaemon();
    const created = await send("POST", "/api/projects", { name: "Harness" });
    expect(created.status).toBe(201);
    const projectId = (created.body["project"] as { readonly projectId: string }).projectId;

    const remembered = await send("POST", `/api/projects/${projectId}/memories`, {
      title: "Deploys happen on Thursdays",
      body: "Release windows are Thursday afternoons.",
      kind: "fact",
    });
    expect(remembered.status).toBe(201);
    const memory = remembered.body["memory"] as {
      readonly memoryId: string;
      readonly kind: string;
      readonly pinned: boolean;
      readonly source: string;
    };
    expect(memory).toMatchObject({ kind: "fact", pinned: false, source: "person" });

    await send("POST", `/api/projects/${projectId}/memories`, {
      title: "Prefers short replies",
      body: "A few lines unless asked for detail.",
      kind: "preference",
      pinned: true,
    });
    const listed = await send("GET", `/api/projects/${projectId}/memories`);
    expect(
      (listed.body["memories"] as { readonly title: string }[]).map((entry) => entry.title),
    ).toEqual(["Prefers short replies", "Deploys happen on Thursdays"]);
    const pinned = await send("GET", `/api/projects/${projectId}/memories?pinned=true`);
    expect(pinned.body["memories"]).toHaveLength(1);
    const byKind = await send("GET", `/api/projects/${projectId}/memories?kind=fact`);
    expect(byKind.body["memories"]).toHaveLength(1);
    const found = await send("GET", `/api/projects/${projectId}/memories?q=thursday`);
    expect(
      (found.body["memories"] as { readonly title: string }[]).map((entry) => entry.title),
    ).toEqual(["Deploys happen on Thursdays"]);
    expect((await send("GET", `/api/projects/${projectId}/memories?q=%20`)).status).toBe(400);

    const changed = await send("PATCH", `/api/memories/${memory.memoryId}`, {
      body: "Thursday afternoons, never Fridays.",
      pinned: true,
    });
    expect(changed.status).toBe(200);
    expect(changed.body["memory"]).toMatchObject({
      body: "Thursday afternoons, never Fridays.",
      pinned: true,
    });
    expect((await send("GET", `/api/memories/${memory.memoryId}`)).body["memory"]).toMatchObject({
      pinned: true,
    });

    expect(await send("DELETE", `/api/memories/${memory.memoryId}`)).toMatchObject({
      status: 200,
      body: { forgotten: true },
    });
    expect((await send("GET", `/api/memories/${memory.memoryId}`)).status).toBe(404);
    expect(
      (await send("GET", `/api/projects/${projectId}/memories`)).body["memories"],
    ).toHaveLength(1);
  });

  it("refuses unknown ids, unknown fields and bad values", async () => {
    const { send } = await startDaemon();
    const created = await send("POST", "/api/projects", { name: "Harness" });
    const projectId = (created.body["project"] as { readonly projectId: string }).projectId;

    const missingProject = await send(
      "GET",
      "/api/projects/00000000-0000-7000-8000-000000000000/memories",
    );
    expect(missingProject.status).toBe(404);
    expect(missingProject.body).toMatchObject({ error: { code: "PROJECT_NOT_FOUND" } });

    const unknownField = await send("POST", `/api/projects/${projectId}/memories`, {
      title: "A",
      body: "B",
      colour: "red",
    });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body).toMatchObject({ error: { code: "MEMORY_INVALID", field: "colour" } });

    const badKind = await send("POST", `/api/projects/${projectId}/memories`, {
      title: "A",
      body: "B",
      kind: "rumour",
    });
    expect(badKind.status).toBe(400);
    const emptyTitle = await send("POST", `/api/projects/${projectId}/memories`, {
      title: "   ",
      body: "B",
    });
    expect(emptyTitle.status).toBe(400);
    expect(emptyTitle.body).toMatchObject({ error: { code: "MEMORY_INVALID", field: "title" } });

    expect((await send("GET", "/api/memories/00000000-0000-7000-8000-000000000000")).status).toBe(
      404,
    );
    expect((await send("GET", "/api/memories/not-an-id")).status).toBe(404);
    expect((await send("POST", `/api/memories/00000000-0000-7000-8000-000000000000`)).status).toBe(
      405,
    );
  });
});
