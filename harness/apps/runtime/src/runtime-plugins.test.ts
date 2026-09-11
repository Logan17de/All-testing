import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SQLITE_MEMORY_PATH } from "@zet-harness/db";

import { RuntimeDaemon } from "./runtime-daemon.js";
import { loadRuntimePlugins } from "./runtime-plugins.js";

let pluginsDirectory: string;

const ENTRY_SOURCE = `export default {
  manifest: {
    id: "com.example.demo",
    name: "Demo",
    version: "1.0.0",
    apiVersion: 1,
    capabilities: [],
  },
  activate(context) {
    context.nodes.register({
      manifest: {
        type: "demo.echo",
        version: "1",
        title: "Echo",
        inputs: {},
        outputs: { value: { schema: true } },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        behavior: {
          primitiveFamily: "pure",
          determinism: "deterministic",
          effect: "none",
          idempotency: "not-applicable",
          recovery: "rerun",
          executionMode: "in-process",
          requiredCapabilities: [],
        },
      },
      execute() {
        return { outputs: { value: "echo" } };
      },
    });
  },
};
`;

async function installPackage(
  name: string,
  options: {
    readonly id?: string;
    readonly entrySource?: string;
    readonly withIntegrity?: boolean;
    readonly requestedCapabilities?: readonly string[];
    readonly nodes?: readonly { type: string; version: string; title: string }[];
  } = {},
): Promise<void> {
  const directory = join(pluginsDirectory, name);
  await mkdir(directory, { recursive: true });
  const entrySource = options.entrySource ?? ENTRY_SOURCE;
  await writeFile(join(directory, "index.mjs"), entrySource, "utf8");

  const manifest: Record<string, unknown> = {
    manifestVersion: 1,
    id: options.id ?? "com.example.demo",
    name: "Demo",
    version: "1.0.0",
    apiVersion: 1,
    license: "MIT",
    entry: "./index.mjs",
    requestedCapabilities: options.requestedCapabilities ?? [],
    nodes: options.nodes ?? [{ type: "demo.echo", version: "1", title: "Echo" }],
  };
  if (options.withIntegrity === true) {
    manifest["integrity"] = {
      algorithm: "sha256",
      files: { "index.mjs": createHash("sha256").update(entrySource, "utf8").digest("hex") },
    };
  }
  await writeFile(join(directory, "zet-plugin.json"), JSON.stringify(manifest), "utf8");
}

async function writeConfig(document: unknown): Promise<void> {
  await writeFile(join(pluginsDirectory, "plugins.json"), JSON.stringify(document), "utf8");
}

beforeEach(async () => {
  pluginsDirectory = await mkdtemp(join(tmpdir(), "zet-runtime-plugins-"));
});

afterEach(async () => {
  await rm(pluginsDirectory, { recursive: true, force: true, maxRetries: 3 });
});

describe("loadRuntimePlugins", () => {
  it("requires an absolute plugins directory", async () => {
    await expect(loadRuntimePlugins({ directory: "relative" })).rejects.toThrow(TypeError);
  });

  it("reports an empty installation for a missing directory", async () => {
    const loaded = await loadRuntimePlugins({ directory: join(pluginsDirectory, "absent") });
    expect(loaded.report.installed).toEqual([]);
    expect(loaded.report.activated).toEqual([]);
  });

  it("lists an installed plugin without activating it", async () => {
    await installPackage("demo");
    const loaded = await loadRuntimePlugins({ directory: pluginsDirectory });
    expect(loaded.report.installed.map((view) => view.id)).toEqual(["com.example.demo"]);
    expect(loaded.report.activated).toEqual([]);
    expect(loaded.host.size).toBe(0);
  });

  it("does not enable a plugin merely because it is installed", async () => {
    await installPackage("demo");
    await writeConfig({ plugins: [{ id: "com.example.demo" }] });
    const loaded = await loadRuntimePlugins({ directory: pluginsDirectory });
    expect(loaded.report.activated).toEqual([]);
  });

  it("activates a plugin the configuration enables", async () => {
    await installPackage("demo");
    await writeConfig({ plugins: [{ id: "com.example.demo", enabled: true }] });
    const loaded = await loadRuntimePlugins({ directory: pluginsDirectory });
    expect(loaded.report.activated).toEqual(["com.example.demo"]);
    expect(loaded.host.nodes.has("demo.echo", "1")).toBe(true);
    await loaded.host.dispose();
  });

  it("builds a policy from host grants alone", async () => {
    await installPackage("demo", { requestedCapabilities: ["fs:read", "fs:write"] });
    await writeConfig({
      plugins: [{ id: "com.example.demo", enabled: true, grantedCapabilities: ["fs:read"] }],
    });
    const loaded = await loadRuntimePlugins({ directory: pluginsDirectory });
    const policy = loaded.policies.get("com.example.demo");
    expect(policy?.allows("fs:read")).toBe(true);
    // Requested but not granted.
    expect(policy?.allows("fs:write")).toBe(false);
    await loaded.host.dispose();
  });

  it("reports requested capabilities that were withheld", async () => {
    await installPackage("demo", { requestedCapabilities: ["network:https"] });
    await writeConfig({ plugins: [{ id: "com.example.demo", enabled: true }] });
    const loaded = await loadRuntimePlugins({ directory: pluginsDirectory });
    expect(loaded.report.installed[0]?.withheldCapabilities).toEqual(["network:https"]);
    await loaded.host.dispose();
  });

  it("keeps going when one plugin fails to activate", async () => {
    await installPackage("good");
    await installPackage("bad", {
      id: "com.example.bad",
      nodes: [{ type: "demo.other", version: "1", title: "Other" }],
    });
    await writeConfig({
      plugins: [
        { id: "com.example.demo", enabled: true },
        { id: "com.example.bad", enabled: true },
      ],
    });
    const loaded = await loadRuntimePlugins({ directory: pluginsDirectory });
    // The bad package registers demo.echo, which its manifest does not declare.
    expect(loaded.report.activated).toEqual(["com.example.demo"]);
    expect(loaded.report.failures.length).toBeGreaterThan(0);
    await loaded.host.dispose();
  });

  it("can require integrity for every plugin", async () => {
    await installPackage("demo");
    await writeConfig({ plugins: [{ id: "com.example.demo", enabled: true }] });
    const loaded = await loadRuntimePlugins({
      directory: pluginsDirectory,
      requireIntegrity: true,
    });
    expect(loaded.report.activated).toEqual([]);
    expect(loaded.report.failures[0]?.code).toBe("integrity-mismatch");
  });

  it("activates a signed plugin under a strict integrity policy", async () => {
    await installPackage("demo", { withIntegrity: true });
    await writeConfig({ plugins: [{ id: "com.example.demo", enabled: true }] });
    const loaded = await loadRuntimePlugins({
      directory: pluginsDirectory,
      requireIntegrity: true,
    });
    expect(loaded.report.activated).toEqual(["com.example.demo"]);
    await loaded.host.dispose();
  });

  it("reports a malformed configuration file without loading anything", async () => {
    await installPackage("demo");
    await writeFile(join(pluginsDirectory, "plugins.json"), "{ broken", "utf8");
    const loaded = await loadRuntimePlugins({ directory: pluginsDirectory });
    expect(loaded.report.configDefects.length).toBeGreaterThan(0);
    expect(loaded.report.activated).toEqual([]);
  });

  it("treats an absent configuration file as nothing enabled", async () => {
    await installPackage("demo");
    const loaded = await loadRuntimePlugins({ directory: pluginsDirectory });
    expect(loaded.report.configDefects).toEqual([]);
    expect(loaded.report.activated).toEqual([]);
  });
});

describe("RuntimeDaemon plugin startup", () => {
  it("reports an empty plugin set when plugins are not configured", () => {
    const daemon = new RuntimeDaemon({
      api: { port: 0 },
      database: { path: SQLITE_MEMORY_PATH },
      probePathLimits: false,
    });
    expect(daemon.snapshot().plugins.activated).toEqual([]);
    expect(daemon.plugins).toBeUndefined();
  });

  it("loads and activates enabled plugins during startup", async () => {
    await installPackage("demo");
    await writeConfig({ plugins: [{ id: "com.example.demo", enabled: true }] });

    const daemon = new RuntimeDaemon({
      api: { port: 0 },
      database: { path: SQLITE_MEMORY_PATH },
      probePathLimits: false,
      plugins: { directory: pluginsDirectory },
    });

    await daemon.start();
    try {
      const snapshot = daemon.snapshot();
      expect(snapshot.plugins.activated).toEqual(["com.example.demo"]);
      expect(daemon.plugins?.nodes.has("demo.echo", "1")).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it("still starts when a plugin fails to load", async () => {
    await installPackage("broken", {
      id: "com.example.broken",
      entrySource: "throw new Error('bad plugin');\n",
    });
    await writeConfig({ plugins: [{ id: "com.example.broken", enabled: true }] });

    const daemon = new RuntimeDaemon({
      api: { port: 0 },
      database: { path: SQLITE_MEMORY_PATH },
      probePathLimits: false,
      plugins: { directory: pluginsDirectory },
    });

    await daemon.start();
    try {
      // One bad third-party package must not stop the runtime from starting.
      expect(daemon.snapshot().state).toBe("running");
      expect(daemon.snapshot().plugins.failures.length).toBeGreaterThan(0);
      expect(daemon.snapshot().plugins.activated).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it("surfaces installed-but-disabled plugins for a host UI", async () => {
    await installPackage("demo", { requestedCapabilities: ["fs:read"] });

    const daemon = new RuntimeDaemon({
      api: { port: 0 },
      database: { path: SQLITE_MEMORY_PATH },
      probePathLimits: false,
      plugins: { directory: pluginsDirectory },
    });

    await daemon.start();
    try {
      const [view] = daemon.snapshot().plugins.installed;
      expect(view?.id).toBe("com.example.demo");
      expect(view?.enabled).toBe(false);
      expect(view?.requestedCapabilities).toEqual(["fs:read"]);
      expect(view?.grantedCapabilities).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it("unloads plugins when the daemon stops", async () => {
    await installPackage("demo");
    await writeConfig({ plugins: [{ id: "com.example.demo", enabled: true }] });

    const daemon = new RuntimeDaemon({
      api: { port: 0 },
      database: { path: SQLITE_MEMORY_PATH },
      probePathLimits: false,
      plugins: { directory: pluginsDirectory },
    });

    await daemon.start();
    const host = daemon.plugins;
    await daemon.stop();
    expect(host?.size).toBe(0);
  });
});

describe("plugins HTTP endpoint", () => {
  it("serves the installed plugin list over the local API", async () => {
    await installPackage("demo", { requestedCapabilities: ["fs:read"] });
    await writeConfig({ plugins: [{ id: "com.example.demo", enabled: true }] });

    const daemon = new RuntimeDaemon({
      api: { port: 0 },
      database: { path: SQLITE_MEMORY_PATH },
      probePathLimits: false,
      plugins: { directory: pluginsDirectory },
    });

    await daemon.start();
    try {
      const port = daemon.snapshot().api.port;
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/plugins`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        installed: { id: string; requestedCapabilities: string[] }[];
        activated: string[];
      };
      expect(body.activated).toEqual(["com.example.demo"]);
      expect(body.installed[0]?.requestedCapabilities).toEqual(["fs:read"]);
    } finally {
      await daemon.stop();
    }
  });

  it("refuses a non-GET request to the plugins endpoint", async () => {
    const daemon = new RuntimeDaemon({
      api: { port: 0 },
      database: { path: SQLITE_MEMORY_PATH },
      probePathLimits: false,
      plugins: { directory: pluginsDirectory },
    });

    await daemon.start();
    try {
      const port = daemon.snapshot().api.port;
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/plugins`, {
        method: "POST",
      });
      // Enabling a plugin is a configuration decision, not an HTTP call.
      expect(response.status).toBe(405);
    } finally {
      await daemon.stop();
    }
  });
});

describe("isolated plugins", () => {
  it("runs in-process unless the configuration asks for isolation", async () => {
    await installPackage("demo");
    await writeConfig({ plugins: [{ id: "com.example.demo", enabled: true }] });
    const loaded = await loadRuntimePlugins({ directory: pluginsDirectory });
    try {
      expect(loaded.report.isolated).toEqual([]);
      expect(loaded.sandboxes).toEqual([]);
      expect(loaded.host.nodes.has("demo.echo", "1")).toBe(true);
    } finally {
      await loaded.host.dispose();
    }
  });

  it("starts a sandboxed child when isolation is requested", async () => {
    await installPackage("demo");
    await writeConfig({
      plugins: [{ id: "com.example.demo", enabled: true, isolated: true }],
    });
    const loaded = await loadRuntimePlugins({
      directory: pluginsDirectory,
      workspaceRoot: pluginsDirectory,
    });
    try {
      expect(loaded.report.isolated).toEqual(["com.example.demo"]);
      expect(loaded.report.activated).toEqual(["com.example.demo"]);
      expect(loaded.sandboxes).toHaveLength(1);
      // The plugin's code runs in the child, so it registers nothing here.
      expect(loaded.host.nodes.has("demo.echo", "1")).toBe(false);
    } finally {
      for (const sandbox of loaded.sandboxes) await sandbox.close();
      await loaded.host.dispose();
    }
  }, 40_000);

  it("exposes the sandboxed plugin's node through the proxy", async () => {
    await installPackage("demo");
    await writeConfig({
      plugins: [{ id: "com.example.demo", enabled: true, isolated: true }],
    });
    const loaded = await loadRuntimePlugins({ directory: pluginsDirectory });
    try {
      const sandbox = loaded.sandboxes[0];
      expect(sandbox?.nodes.map((node) => node.manifest.type)).toEqual(["demo.echo"]);
    } finally {
      for (const sandbox of loaded.sandboxes) await sandbox.close();
      await loaded.host.dispose();
    }
  }, 40_000);

  it("sandboxes with no filesystem grant by default", async () => {
    await installPackage("demo");
    await writeConfig({
      plugins: [{ id: "com.example.demo", enabled: true, isolated: true }],
    });
    const loaded = await loadRuntimePlugins({
      directory: pluginsDirectory,
      workspaceRoot: pluginsDirectory,
    });
    try {
      const flags = loaded.sandboxes[0]?.sandboxFlags ?? [];
      expect(flags).toContain("--permission");
      expect(flags.some((flag) => flag.startsWith("--allow-fs-write="))).toBe(false);
    } finally {
      for (const sandbox of loaded.sandboxes) await sandbox.close();
      await loaded.host.dispose();
    }
  }, 40_000);

  it("stops sandboxed plugins when the daemon stops", async () => {
    await installPackage("demo");
    await writeConfig({
      plugins: [{ id: "com.example.demo", enabled: true, isolated: true }],
    });

    const daemon = new RuntimeDaemon({
      api: { port: 0 },
      database: { path: SQLITE_MEMORY_PATH },
      probePathLimits: false,
      plugins: { directory: pluginsDirectory },
    });

    await daemon.start();
    expect(daemon.snapshot().plugins.isolated).toEqual(["com.example.demo"]);
    await daemon.stop();
    // A sandbox is its own process; shutdown must not leave it running.
    expect(daemon.snapshot().state).toBe("stopped");
  }, 40_000);
});
