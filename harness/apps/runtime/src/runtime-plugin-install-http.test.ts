import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SQLITE_MEMORY_PATH } from "@zet-harness/db";

import { RuntimeDaemon } from "./runtime-daemon.js";

let root: string;
const daemons: RuntimeDaemon[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zet-install-http-"));
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

const ENTRY = "export function activate() {}\n";

/** A plugin package already sitting in the plugins directory, as if installed. */
async function writeInstalledPlugin(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "index.mjs"), ENTRY, "utf8");
  await writeFile(
    join(directory, "zet-plugin.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "com.example.installed",
      name: "Installed example",
      version: "1.0.0",
      apiVersion: 1,
      license: "MIT",
      entry: "./index.mjs",
      requestedCapabilities: [],
      nodes: [{ type: "example.reverse-text", version: "1", title: "Reverse text" }],
      integrity: {
        algorithm: "sha256",
        files: { "index.mjs": createHash("sha256").update(ENTRY).digest("hex") },
      },
    }),
    "utf8",
  );
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function startDaemon(install?: { readonly npm?: boolean; readonly git?: boolean }) {
  const plugins = join(root, "plugins");
  await mkdir(plugins, { recursive: true });
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path: SQLITE_MEMORY_PATH },
    probePathLimits: false,
    plugins: { directory: plugins, ...(install === undefined ? {} : { install }) },
  });
  daemons.push(daemon);
  await daemon.start();
  const base = `http://127.0.0.1:${String(daemon.snapshot().api.port)}`;
  const send = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> => {
    const writes = method === "POST";
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
  return { send, plugins, daemon };
}

describe("installing a plugin over HTTP (10.11)", () => {
  it("refuses to install at all unless the host allowed it", async () => {
    const { send, plugins } = await startDaemon();

    const refused = await send("POST", "/api/plugins/install", {
      kind: "npm",
      spec: "example-plugin",
    });

    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "INSTALL_NOT_ALLOWED" } });
    expect(await readdir(plugins)).toEqual([]);
  });

  it("refuses a source it cannot read, without running anything", async () => {
    const { send } = await startDaemon({ npm: true });

    expect((await send("POST", "/api/plugins/install", { kind: "carrier-pigeon" })).status).toBe(
      400,
    );
    expect((await send("POST", "/api/plugins/install", { kind: "npm" })).status).toBe(400);
    const badSpec = await send("POST", "/api/plugins/install", {
      kind: "npm",
      spec: "--registry=http://evil.example",
    });
    expect(badSpec.status).toBe(400);
    expect(badSpec.body).toMatchObject({ error: { code: "INSTALL_SOURCE_INVALID" } });

    // git is still off, even though npm was allowed.
    const git = await send("POST", "/api/plugins/install", {
      kind: "git",
      url: "https://example.com/user/plugin.git",
    });
    expect(git.status).toBe(403);
    expect(git.body).toMatchObject({ error: { code: "INSTALL_NOT_ALLOWED" } });
  });

  it("shows a plugin dropped into the directory without enabling it", async () => {
    const { send, plugins, daemon } = await startDaemon({ npm: true });
    // A package that arrived while the daemon was running, as an install leaves one.
    await writeInstalledPlugin(join(plugins, "example-plugin"));

    // Re-reading the directory is manifests only, which is what installing does too.
    await daemon.rescanPlugins();

    const listed = await send("GET", "/api/plugins");
    const installed = listed.body["installed"] as {
      readonly id: string;
      readonly enabled: boolean;
      readonly grantedCapabilities: readonly string[];
    }[];
    expect(installed.map((entry) => entry.id)).toEqual(["com.example.installed"]);
    // Installed is not enabled, and nothing was granted.
    expect(installed[0]).toMatchObject({ enabled: false, grantedCapabilities: [] });
    expect(listed.body["activated"]).toEqual([]);
  });

  it("says whether this harness installs at all, and from where", async () => {
    const closed = await startDaemon();
    expect((await closed.send("GET", "/api/plugins")).body["install"]).toEqual({
      npm: false,
      git: false,
    });

    const open = await startDaemon({ git: true });
    expect((await open.send("GET", "/api/plugins")).body["install"]).toEqual({
      npm: false,
      git: true,
    });
  });

  it("answers 405 for anything but POST", async () => {
    const { send } = await startDaemon({ npm: true });
    expect((await send("GET", "/api/plugins/install")).status).toBe(405);
  });
});
