import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RuntimeDaemon } from "./runtime-daemon.js";

let root: string;
const daemons: RuntimeDaemon[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zet-setup-")));
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function startDaemon() {
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path: join(root, "harness.sqlite") },
    probePathLimits: false,
  });
  daemons.push(daemon);
  await daemon.start();
  const base = `http://127.0.0.1:${String(daemon.snapshot().api.port)}`;
  const send = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> => {
    const writes = method !== "GET";
    const csrf = writes
      ? ((await (await fetch(`${base}/api/session`)).json()) as { readonly csrfToken: string })
          .csrfToken
      : undefined;
    const response = await fetch(`${base}${path}`, {
      method,
      headers: writes ? { "content-type": "application/json", "x-zet-csrf": csrf ?? "" } : {},
      ...(writes && body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { daemon, send };
}

describe("first-run setup", () => {
  it("is not complete until a workspace is chosen, and remembers it across restarts", async () => {
    const project = join(root, "my-project");
    await mkdir(project);
    const first = await startDaemon();

    expect((await first.send("GET", "/api/setup")).body["setup"]).toEqual({
      workspace: null,
      modelsConfigured: 0,
      complete: false,
    });

    const chosen = await first.send("POST", "/api/setup/workspace", { path: project });
    expect(chosen).toEqual({
      status: 200,
      body: { workspace: { path: project, exists: true } },
    });
    expect((await first.send("GET", "/api/setup")).body["setup"]).toMatchObject({
      workspace: { path: project, exists: true },
      complete: true,
    });

    await first.daemon.stop();
    daemons.splice(0);
    const second = await startDaemon();
    expect((await second.send("GET", "/api/setup/workspace")).body).toEqual({
      workspace: { path: project, exists: true },
    });
  });

  it("starts new projects in the workspace unless they name their own folder", async () => {
    const project = join(root, "my-project");
    const elsewhere = join(root, "elsewhere");
    await mkdir(project);
    await mkdir(elsewhere);
    const { send } = await startDaemon();

    const before = await send("POST", "/api/projects", { name: "Before" });
    expect(before.body["project"]).toMatchObject({ workspacePath: null });

    await send("POST", "/api/setup/workspace", { path: project });
    const inWorkspace = await send("POST", "/api/projects", { name: "Inside" });
    expect(inWorkspace.body["project"]).toMatchObject({ workspacePath: project });
    const ownFolder = await send("POST", "/api/projects", {
      name: "Own",
      workspacePath: elsewhere,
    });
    expect(ownFolder.body["project"]).toMatchObject({ workspacePath: elsewhere });
  });

  it("refuses a workspace it could not work in", async () => {
    const { send } = await startDaemon();
    const file = join(root, "notes.txt");
    await writeFile(file, "hello", "utf8");

    const refusal = async (path: unknown) =>
      (
        (await send("POST", "/api/setup/workspace", { path })).body["error"] as {
          readonly code: string;
        }
      ).code;

    expect(await refusal("relative/folder")).toBe("WORKSPACE_INVALID");
    expect(await refusal(join(root, "missing"))).toBe("WORKSPACE_NOT_FOUND");
    expect(await refusal(file)).toBe("WORKSPACE_INVALID");
    expect(await refusal(parse(root).root)).toBe("WORKSPACE_TOO_BROAD");
    expect(await refusal("")).toBe("WORKSPACE_INVALID");
    expect((await send("GET", "/api/setup")).body["setup"]).toMatchObject({ complete: false });
  });

  it("lists folders, and only folders, for the folder picker", async () => {
    await mkdir(join(root, "beta"));
    await mkdir(join(root, "Alpha"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "readme.md"), "not a folder", "utf8");
    const { send } = await startDaemon();

    const listed = await send("GET", `/api/setup/folders?path=${encodeURIComponent(root)}`);
    expect(listed.status).toBe(200);
    const folders = listed.body["folders"] as {
      readonly path: string;
      readonly parent: string | null;
      readonly roots: readonly string[];
      readonly folders: readonly { readonly name: string; readonly path: string }[];
    };
    expect(folders.path).toBe(root);
    expect(folders.folders).toEqual([
      { name: "Alpha", path: join(root, "Alpha") },
      { name: "beta", path: join(root, "beta") },
    ]);
    expect(folders.parent).not.toBeNull();
    expect(folders.roots.length).toBeGreaterThan(0);

    expect(
      (await send("GET", `/api/setup/folders?path=${encodeURIComponent(join(root, "gone"))}`))
        .status,
    ).toBe(404);
    expect((await send("GET", "/api/setup/folders?path=relative")).status).toBe(400);
  });
});
