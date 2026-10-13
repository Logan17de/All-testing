import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteDatabase } from "@zet-harness/db";

import { RuntimeDaemon } from "./runtime-daemon.js";
import { createSortableId } from "@zet-harness/db/sortable-id";
import {
  createConversation,
  readConversation,
  appendMessage,
  readConversationMessages,
} from "@zet-harness/db/durable-conversation-records";
import { readSetting } from "@zet-harness/db/durable-setting-records";
import { PROJECT_FEATURES } from "./runtime-project-metadata.js";
import { createProject } from "@zet-harness/db/durable-project-records";

let root: string;
const daemons: RuntimeDaemon[] = [];
const fixtureDatabases: SqliteDatabase[] = [];
let fixtureIndex = 0;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zet-project-http-")));
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const database of fixtureDatabases.splice(0)) database.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

interface Started {
  readonly base: string;
  readonly daemon: RuntimeDaemon;
  readonly database: SqliteDatabase;
}

async function startDaemon(
  path: string = join(root, "runtime-" + String(fixtureIndex++) + ".sqlite"),
): Promise<Started> {
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path },
    probePathLimits: false,
  });
  daemons.push(daemon);
  await daemon.start();
  const database = new SqliteDatabase({ path });
  database.open();
  fixtureDatabases.push(database);
  return { base: `http://127.0.0.1:${String(daemon.snapshot().api.port)}`, daemon, database };
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
      body: { name: "Website", description: "Landing page", workspacePath: root, trusted: true },
      token,
    });
    expect(created.status).toBe(201);
    const project = created.body["project"] as Record<string, unknown>;
    expect(project).toMatchObject({
      name: "Website",
      description: "Landing page",
      workspacePath: root,
      status: "active",
      archivedAtMs: null,
    });
    const projectId = project["projectId"] as string;
    expect(projectId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    expect((await send(base, "GET", "/api/projects")).body).toMatchObject({ projects: [project] });
    expect((await send(base, "GET", `/api/projects/${projectId}`)).body).toMatchObject({ project });

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
    expect((await send(base, "GET", "/api/projects")).body).toMatchObject({ projects: [] });
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
    expect((await send(base, "GET", "/api/projects")).body).toMatchObject({ projects: [] });

    const cases: readonly [unknown, string | undefined][] = [
      [{}, "name"],
      [{ name: 42 }, "name"],
      [{ name: "Ok", color: "blue" }, "color"],
      [{ name: "Ok", workspacePath: "relative/folder" }, "trusted"],
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

    const created = await send(base, "POST", "/api/projects", {
      body: { name: "Real", workspacePath: root, trusted: true },
      token,
    });
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
      body: {
        name: "Durable",
        workspacePath: root,
        trusted: true,
        pinned: true,
        section: "Work",
        sourceFolders: [root],
      },
      token,
    });
    expect(created.status).toBe(201);
    await first.daemon.stop();
    daemons.splice(daemons.indexOf(first.daemon), 1);

    const second = await startDaemon(path);
    expect((await send(second.base, "GET", "/api/projects")).body).toMatchObject({
      projects: [created.body["project"]],
    });
  });
});

describe("project metadata and scoped context actions", () => {
  it("saving unchanged legacy folders and metadata does not silently trust a project", async () => {
    const { base, database } = await startDaemon();
    const token = await sessionToken(base);
    const legacy = await database.commit((db) =>
      createProject(db, {
        projectId: createSortableId(),
        name: "Legacy",
        workspacePath: root,
        nowMs: 1,
      }),
    );
    const path = `/api/projects/${legacy.projectId}`;
    const reply = await send(base, "POST", path, {
      token,
      body: { sourceFolders: [root], name: "Display name", pinned: true, section: "Work" },
    });
    expect(reply.status).toBe(200);
    expect(reply.body["project"]).toMatchObject({
      workspaceTrusted: false,
      sourceFolders: [root],
      pinned: true,
    });
    expect(
      readSetting(database.connection(), `project.trusted.${legacy.projectId}`),
    ).toBeUndefined();
    expect(
      (await send(base, "POST", path, { token, body: { sourceFolders: [root], trusted: true } }))
        .body["project"],
    ).toMatchObject({ workspaceTrusted: true });
  });
  it("validates canonical source folders and explicit trust without granting secondary authority", async () => {
    const extra = join(root, "extra");
    await mkdir(extra);
    const { base, database } = await startDaemon();
    const token = await sessionToken(base);
    const created = await send(base, "POST", "/api/projects", {
      token,
      body: { name: "Fixture", workspacePath: root, trusted: true },
    });
    const project = created.body["project"] as { projectId: string };
    const path = `/api/projects/${project.projectId}`;
    expect(created.body["projectFeatures"]).toEqual(PROJECT_FEATURES);
    expect(created.body["project"]).toMatchObject({
      sourceFolders: [root],
      pinned: false,
      section: null,
    });
    for (const body of [
      { pinned: "true" },
      { section: "x".repeat(81) },
      { section: " " },
      { sourceFolders: [] },
      { sourceFolders: Array.from({ length: 21 }, () => root) },
      { sourceFolders: [root, root], trusted: true },
      { sourceFolders: [root, "relative"], trusted: true },
      { sourceFolders: [root, extra] },
      { sourceFolders: [extra, root] },
      { sourceFolders: [root, extra], workspacePath: extra, trusted: true },
      { arbitrary: true },
    ])
      expect((await send(base, "POST", path, { token, body })).status).toBe(400);
    expect((await send(base, "POST", path, { body: { pinned: true } })).status).toBe(403);
    const added = await send(base, "POST", path, {
      token,
      body: { sourceFolders: [root, extra], trusted: true, pinned: true, section: " Work " },
    });
    expect(added.status).toBe(200);
    expect(added.body["project"]).toMatchObject({
      workspacePath: root,
      sourceFolders: [root, extra],
      pinned: true,
      section: "Work",
    });
    expect(readSetting(database.connection(), `project.trusted.${project.projectId}`)?.value).toBe(
      root,
    );
    expect(
      (await send(base, "POST", path, { token, body: { sourceFolders: [extra, root] } })).status,
    ).toBe(400);
    const primary = await send(base, "POST", path, {
      token,
      body: { sourceFolders: [extra, root], trusted: true },
    });
    expect(primary.body["project"]).toMatchObject({
      workspacePath: extra,
      sourceFolders: [extra, root],
    });
    expect(readSetting(database.connection(), `project.trusted.${project.projectId}`)?.value).toBe(
      extra,
    );
    const removed = await send(base, "POST", path, {
      token,
      body: { sourceFolders: [extra], section: null, pinned: false },
    });
    expect(removed.body["project"]).toMatchObject({
      sourceFolders: [extra],
      section: null,
      pinned: false,
    });
    expect((await stat(root)).isDirectory()).toBe(true);
    expect((await stat(extra)).isDirectory()).toBe(true);
  });
  it("archives every active chat only in the selected project and soft-removes without deleting records or folders", async () => {
    const { base, database } = await startDaemon();
    const token = await sessionToken(base);
    const make = async (name: string) =>
      (
        await send(base, "POST", "/api/projects", {
          token,
          body: { name, workspacePath: root, trusted: true },
        })
      ).body["project"] as { projectId: string };
    const project = await make("First");
    const other = await make("Other");
    const ids: string[] = [];
    await database.commit((db) => {
      for (let i = 0; i < 205; i++) {
        const id = createSortableId();
        ids.push(id);
        createConversation(db, {
          conversationId: id,
          projectId: project.projectId,
          title: "Fixture",
          nowMs: 1,
        });
      }
      const id = createSortableId();
      ids.push(id);
      createConversation(db, {
        conversationId: id,
        projectId: other.projectId,
        title: "Other",
        nowMs: 1,
      });
      appendMessage(db, {
        messageId: createSortableId(),
        conversationId: ids[0]!,
        role: "user",
        parts: [{ kind: "text", text: "Keep this history" }],
        nowMs: 2,
      });
    });
    const path = `/api/projects/${project.projectId}`;
    expect(
      (
        await send(base, "POST", `${path}/archive-chats`, {
          token,
          body: { projectId: other.projectId },
        })
      ).status,
    ).toBe(400);
    expect((await send(base, "POST", `${path}/archive-chats`, { body: {} })).status).toBe(403);
    const archived = await send(base, "POST", `${path}/archive-chats`, { token });
    expect(archived.status).toBe(200);
    expect(archived.body["archivedChats"]).toBe(205);
    expect(readConversation(database.connection(), ids[0]!)?.status).toBe("archived");
    expect(readConversation(database.connection(), ids.at(-1)!)?.status).toBe("active");
    expect(
      (await send(base, "POST", `${path}/archive-chats`, { token })).body["archivedChats"],
    ).toBe(0);
    expect(
      (await send(base, "POST", `${path}/remove`, { token, body: { deleteFiles: true } })).status,
    ).toBe(400);
    expect((await send(base, "POST", `${path}/remove`, { token })).body["project"]).toMatchObject({
      status: "archived",
    });
    expect(readConversationMessages(database.connection(), ids[0]!)).toHaveLength(1);
    expect((await stat(root)).isDirectory()).toBe(true);
    expect((await send(base, "POST", `${path}/archive-chats`, { token })).status).toBe(409);
    expect((await send(base, "POST", "/api/projects/not-a-uuid/remove", { token })).status).toBe(
      404,
    );
  });
});

it("requires trust for the exact folder on creation and folder changes", async () => {
  const { base } = await startDaemon();
  const token = await sessionToken(base);
  expect(
    (
      await send(base, "POST", "/api/projects", {
        body: { name: "Untouched", workspacePath: root },
        token,
      })
    ).status,
  ).toBe(400);
  expect((await send(base, "GET", "/api/projects")).body).toMatchObject({ projects: [] });
  const created = await send(base, "POST", "/api/projects", {
    body: { name: "Display name", workspacePath: root, trusted: true },
    token,
  });
  const project = created.body.project as { projectId: string; workspacePath: string };
  expect(
    (
      await send(base, "POST", "/api/agent", {
        body: { action: "session/start", params: { projectId: project.projectId } },
        token,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await send(base, "POST", `/api/projects/${project.projectId}`, {
        body: { workspacePath: root },
        token,
      })
    ).status,
  ).toBe(400);
});
