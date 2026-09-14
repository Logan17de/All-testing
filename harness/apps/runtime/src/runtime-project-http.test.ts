import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SQLITE_MEMORY_PATH } from "@zet-harness/db";

import { RuntimeDaemon } from "./runtime-daemon.js";

let root: string;
const daemons: RuntimeDaemon[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zet-project-http-"));
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

interface Started {
  readonly base: string;
  readonly daemon: RuntimeDaemon;
}

async function startDaemon(path: string = SQLITE_MEMORY_PATH): Promise<Started> {
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path },
    probePathLimits: false,
  });
  daemons.push(daemon);
  await daemon.start();
  return { base: `http://127.0.0.1:${String(daemon.snapshot().api.port)}`, daemon };
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
    ...(method === "POST"
      ? {
          body:
            typeof options.body === "string" ? options.body : JSON.stringify(options.body ?? {}),
        }
      : {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("project endpoints", () => {
  it("creates, lists, reads, changes, archives and restores a project", async () => {
    const { base } = await startDaemon();
    const token = await sessionToken(base);

    const created = await send(base, "POST", "/api/projects", {
      body: { name: "Website", description: "Landing page" },
      token,
    });
    expect(created.status).toBe(201);
    const project = created.body["project"] as Record<string, unknown>;
    expect(project).toMatchObject({
      name: "Website",
      description: "Landing page",
      workspacePath: null,
      status: "active",
      archivedAtMs: null,
    });
    const projectId = project["projectId"] as string;
    expect(projectId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    expect((await send(base, "GET", "/api/projects")).body).toEqual({ projects: [project] });
    expect((await send(base, "GET", `/api/projects/${projectId}`)).body).toEqual({ project });

    const renamed = await send(base, "POST", `/api/projects/${projectId}`, {
      body: { name: "Marketing site" },
      token,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body["project"]).toMatchObject({
      projectId,
      name: "Marketing site",
      description: "Landing page",
    });

    const archived = await send(base, "POST", `/api/projects/${projectId}/archive`, { token });
    expect(archived.status).toBe(200);
    expect(archived.body["project"]).toMatchObject({ status: "archived" });
    expect((await send(base, "GET", "/api/projects")).body).toEqual({ projects: [] });
    expect(
      ((await send(base, "GET", "/api/projects?status=archived")).body["projects"] as unknown[])
        .length,
    ).toBe(1);

    const refused = await send(base, "POST", `/api/projects/${projectId}`, {
      body: { name: "Again" },
      token,
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "PROJECT_ARCHIVED" } });

    const restored = await send(base, "POST", `/api/projects/${projectId}/restore`, { token });
    expect(restored.body["project"]).toMatchObject({ status: "active", archivedAtMs: null });
  });

  it("refuses writes without the session token, and malformed requests", async () => {
    const { base } = await startDaemon();
    const token = await sessionToken(base);

    expect((await send(base, "POST", "/api/projects", { body: { name: "No token" } })).status).toBe(
      403,
    );
    expect((await send(base, "GET", "/api/projects")).body).toEqual({ projects: [] });

    const cases: readonly [unknown, string | undefined][] = [
      [{}, "name"],
      [{ name: 42 }, "name"],
      [{ name: "Ok", color: "blue" }, "color"],
      [{ name: "Ok", workspacePath: "relative/folder" }, "workspacePath"],
      ["{", undefined],
    ];
    for (const [body, field] of cases) {
      const reply = await send(base, "POST", "/api/projects", { body, token });
      expect(reply.status).toBe(400);
      expect(reply.body["error"]).toMatchObject({
        code: "PROJECT_INVALID",
        ...(field === undefined ? {} : { field }),
      });
    }

    expect((await send(base, "GET", "/api/projects?status=deleted")).status).toBe(400);
    expect((await send(base, "GET", "/api/projects/not-an-id")).body).toMatchObject({
      error: { code: "PROJECT_NOT_FOUND" },
    });
    expect(
      (await send(base, "GET", "/api/projects/01890a5d-ac96-774b-bcce-b302099a8057")).status,
    ).toBe(404);

    const created = await send(base, "POST", "/api/projects", { body: { name: "Real" }, token });
    const projectId = (created.body["project"] as Record<string, unknown>)["projectId"] as string;
    expect((await send(base, "GET", `/api/projects/${projectId}/archive`)).status).toBe(405);
    expect(
      (
        await send(base, "POST", `/api/projects/${projectId}/archive`, {
          body: { name: "x" },
          token,
        })
      ).status,
    ).toBe(400);
  });

  it("keeps projects across a runtime restart", async () => {
    const path = join(root, "runtime.sqlite");
    const first = await startDaemon(path);
    const token = await sessionToken(first.base);
    const created = await send(first.base, "POST", "/api/projects", {
      body: { name: "Durable", workspacePath: join(root, "work") },
      token,
    });
    expect(created.status).toBe(201);
    await first.daemon.stop();
    daemons.splice(daemons.indexOf(first.daemon), 1);

    const second = await startDaemon(path);
    expect((await send(second.base, "GET", "/api/projects")).body).toEqual({
      projects: [created.body["project"]],
    });
  });
});
