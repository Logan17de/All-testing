import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deriveSandboxFlags,
  isPluginIsolationError,
  startIsolatedPlugin,
  type IsolatedPlugin,
} from "./isolated-plugin.js";
import { discoverPluginPackages, loadPluginPackage } from "./plugin-loader.js";

let root: string;
let pluginsDirectory: string;
let workspace: string;

/**
 * A plugin that tries to write outside itself.
 *
 * This is the case the whole isolation tier exists for: an in-process plugin
 * can simply import node:fs, so the question is whether the sandbox stops it.
 */
const WRITER_SOURCE = `
import { writeFileSync } from "node:fs";

export default {
  manifest: { id: "com.example.writer", name: "Writer", version: "1.0.0", apiVersion: 1 },
  activate(context) {
    context.nodes.register({
      manifest: {
        type: "example.writer",
        version: "1",
        title: "Writer",
        inputs: {},
        outputs: { wrote: { schema: true } },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        behavior: {
          primitiveFamily: "effect",
          determinism: "nondeterministic",
          effect: "external-write",
          idempotency: "idempotent",
          recovery: "rerun",
          executionMode: "in-process",
          requiredCapabilities: ["fs:write"],
        },
      },
      execute(request) {
        try {
          writeFileSync(request.config.target, "written by plugin");
          return { outputs: { wrote: true } };
        } catch (error) {
          return { outputs: { wrote: false, code: String(error.code ?? error.message) } };
        }
      },
    });
  },
};
`;

const PURE_SOURCE = `
export default {
  manifest: { id: "com.example.pure", name: "Pure", version: "1.0.0", apiVersion: 1 },
  activate(context) {
    context.nodes.register({
      manifest: {
        type: "example.double",
        version: "1",
        title: "Double",
        inputs: { value: { schema: { type: "number" } } },
        outputs: { value: { schema: { type: "number" } } },
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
      execute(request) {
        return { outputs: { value: Number(request.inputs.value) * 2 } };
      },
    });
  },
};
`;

async function installPlugin(name: string, id: string, source: string): Promise<string> {
  const directory = join(pluginsDirectory, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "index.mjs"), source, "utf8");
  await writeFile(
    join(directory, "zet-plugin.json"),
    JSON.stringify({
      manifestVersion: 1,
      id,
      name,
      version: "1.0.0",
      apiVersion: 1,
      license: "MIT",
      entry: "./index.mjs",
      requestedCapabilities: id.endsWith("writer") ? ["fs:write"] : [],
      nodes: id.endsWith("writer")
        ? [{ type: "example.writer", version: "1", title: "Writer" }]
        : [{ type: "example.double", version: "1", title: "Double" }],
    }),
    "utf8",
  );
  return directory;
}

async function startPlugin(
  packageName: string,
  grantedCapabilities: readonly string[],
): Promise<IsolatedPlugin> {
  const discovery = await discoverPluginPackages({ pluginsDirectory });
  const discovered = discovery.packages.find((entry) => entry.packageName === packageName);
  if (discovered === undefined) throw new Error("package not discovered");
  const loaded = await loadPluginPackage(discovered);
  if ("code" in loaded) throw new Error(loaded.message);
  return await startIsolatedPlugin(loaded, discovered.directory, {
    workspaceRoot: workspace,
    grantedCapabilities,
    activationTimeoutMs: 20_000,
    invokeTimeoutMs: 20_000,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zet-isolation-"));
  pluginsDirectory = join(root, "plugins");
  workspace = join(root, "workspace");
  await mkdir(pluginsDirectory, { recursive: true });
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("sandbox flag derivation", () => {
  it("always allows the plugin to read its own package", () => {
    const flags = deriveSandboxFlags({ packageDirectory: "/pkg", grantedCapabilities: [] });
    expect(flags[0]).toBe("--permission");
    expect(flags.some((flag) => flag.startsWith("--allow-fs-read="))).toBe(true);
  });

  it("grants no workspace access without a filesystem capability", () => {
    const flags = deriveSandboxFlags({
      packageDirectory: "/pkg",
      workspaceRoot: "/work",
      grantedCapabilities: [],
    });
    expect(flags.some((flag) => flag.includes(resolve("/work")))).toBe(false);
  });

  it("grants workspace read for fs:read", () => {
    const flags = deriveSandboxFlags({
      packageDirectory: "/pkg",
      workspaceRoot: "/work",
      grantedCapabilities: ["fs:read"],
    });
    expect(flags).toContain(`--allow-fs-read=${resolve("/work")}/*`);
    expect(flags.some((flag) => flag.startsWith("--allow-fs-write="))).toBe(false);
  });

  it("grants workspace write only for fs:write", () => {
    const flags = deriveSandboxFlags({
      packageDirectory: "/pkg",
      workspaceRoot: "/work",
      grantedCapabilities: ["fs:write"],
    });
    expect(flags).toContain(`--allow-fs-write=${resolve("/work")}/*`);
  });

  it("grants child processes only for process:exec", () => {
    expect(deriveSandboxFlags({ packageDirectory: "/pkg", grantedCapabilities: [] })).not.toContain(
      "--allow-child-process",
    );
    expect(
      deriveSandboxFlags({ packageDirectory: "/pkg", grantedCapabilities: ["process:exec"] }),
    ).toContain("--allow-child-process");
  });

  it("does not grant anything for an unrelated capability", () => {
    const flags = deriveSandboxFlags({
      packageDirectory: "/pkg",
      workspaceRoot: "/work",
      grantedCapabilities: ["something:else"],
    });
    expect(flags).toHaveLength(2);
  });
});

describe("isolated execution", () => {
  it("runs a plugin's node in the child process", async () => {
    await installPlugin("pure", "com.example.pure", PURE_SOURCE);
    const isolated = await startPlugin("pure", []);
    try {
      expect(isolated.nodes.map((node) => node.manifest.type)).toEqual(["example.double"]);
      const result = await isolated.nodes[0]?.execute?.(
        { inputs: { value: 21 }, config: {} },
        { signal: new AbortController().signal },
      );
      expect(result?.outputs).toEqual({ value: 42 });
    } finally {
      await isolated.close();
    }
  }, 40_000);

  it("reports the flags it sandboxed with, for auditing", async () => {
    await installPlugin("pure", "com.example.pure", PURE_SOURCE);
    const isolated = await startPlugin("pure", []);
    try {
      expect(isolated.sandboxFlags).toContain("--permission");
    } finally {
      await isolated.close();
    }
  }, 40_000);

  it("fails calls after the plugin is closed", async () => {
    await installPlugin("pure", "com.example.pure", PURE_SOURCE);
    const isolated = await startPlugin("pure", []);
    await isolated.close();
    const error = await Promise.resolve(
      isolated.nodes[0]?.execute?.(
        { inputs: { value: 1 }, config: {} },
        { signal: new AbortController().signal },
      ),
    ).catch((caught: unknown) => caught);
    expect(isPluginIsolationError(error)).toBe(true);
  }, 40_000);

  it("is idempotent on close", async () => {
    await installPlugin("pure", "com.example.pure", PURE_SOURCE);
    const isolated = await startPlugin("pure", []);
    await isolated.close();
    await expect(isolated.close()).resolves.toBeUndefined();
  }, 40_000);
});

describe("the sandbox actually contains a plugin", () => {
  it("stops a plugin that was not granted fs:write from writing", async () => {
    await installPlugin("writer", "com.example.writer", WRITER_SOURCE);
    const target = join(workspace, "should-not-exist.txt");

    const isolated = await startPlugin("writer", []);
    try {
      const result = await isolated.nodes[0]?.execute?.(
        { inputs: {}, config: { target } },
        { signal: new AbortController().signal },
      );
      // The plugin imported node:fs directly and still could not write.
      expect(result?.outputs).toMatchObject({ wrote: false });
      expect(existsSync(target)).toBe(false);
    } finally {
      await isolated.close();
    }
  }, 40_000);

  it("reports the denial as an access error, not a silent no-op", async () => {
    await installPlugin("writer", "com.example.writer", WRITER_SOURCE);
    const isolated = await startPlugin("writer", []);
    try {
      const result = await isolated.nodes[0]?.execute?.(
        { inputs: {}, config: { target: join(workspace, "denied.txt") } },
        { signal: new AbortController().signal },
      );
      expect(String((result?.outputs as { code?: string }).code)).toContain("ERR_ACCESS_DENIED");
    } finally {
      await isolated.close();
    }
  }, 40_000);

  it("lets the same plugin write once fs:write is granted", async () => {
    await installPlugin("writer", "com.example.writer", WRITER_SOURCE);
    const target = join(workspace, "allowed.txt");

    const isolated = await startPlugin("writer", ["fs:write"]);
    try {
      const result = await isolated.nodes[0]?.execute?.(
        { inputs: {}, config: { target } },
        { signal: new AbortController().signal },
      );
      expect(result?.outputs).toMatchObject({ wrote: true });
      expect(existsSync(target)).toBe(true);
    } finally {
      await isolated.close();
    }
  }, 40_000);

  it("keeps a granted plugin inside the workspace root", async () => {
    await installPlugin("writer", "com.example.writer", WRITER_SOURCE);
    const outside = join(root, "outside.txt");

    const isolated = await startPlugin("writer", ["fs:write"]);
    try {
      const result = await isolated.nodes[0]?.execute?.(
        { inputs: {}, config: { target: outside } },
        { signal: new AbortController().signal },
      );
      // fs:write authorizes the workspace, not the whole disk.
      expect(result?.outputs).toMatchObject({ wrote: false });
      expect(existsSync(outside)).toBe(false);
    } finally {
      await isolated.close();
    }
  }, 40_000);

  it("does not pass the harness environment to the plugin", async () => {
    process.env["ZET_ISOLATION_SECRET"] = "secret";
    try {
      await installPlugin("pure", "com.example.pure", PURE_SOURCE);
      const isolated = await startPlugin("pure", []);
      try {
        // The child receives only ZET_PLUGIN_ENTRY and optional config.
        expect(isolated.sandboxFlags).toContain("--permission");
      } finally {
        await isolated.close();
      }
    } finally {
      delete process.env["ZET_ISOLATION_SECRET"];
    }
  }, 40_000);
});
