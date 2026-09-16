import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PluginInstallError,
  installPluginPackage,
  parseGitSource,
  parseNpmSpec,
  type PluginProcessRunner,
} from "./plugin-install.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function pluginsDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zet-install-"));
  roots.push(root);
  const directory = join(root, "plugins");
  await mkdir(directory, { recursive: true });
  return directory;
}

const ENTRY = "export function activate() {}\n";

/** Write the files a real plugin package ships, including its integrity digest. */
async function writePluginPackage(
  directory: string,
  options: { readonly id?: string; readonly name?: string; readonly plugin?: boolean } = {},
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "index.mjs"), ENTRY, "utf8");
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: options.name ?? "example-plugin", version: "1.2.3", type: "module" }),
    "utf8",
  );
  if (options.plugin === false) return;
  await writeFile(
    join(directory, "zet-plugin.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: options.id ?? "com.example.installed",
      name: "Installed example",
      version: "1.2.3",
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

/** Stands in for npm and git: it makes the files they would make, and nothing else. */
function fakeRunner(
  write: (tool: "npm" | "git", args: readonly string[]) => Promise<void> | void,
  result: { readonly code?: number; readonly stderr?: string } = {},
): { readonly run: PluginProcessRunner; readonly calls: { tool: string; args: string[] }[] } {
  const calls: { tool: string; args: string[] }[] = [];
  const run: PluginProcessRunner = async (tool, args) => {
    calls.push({ tool, args: [...args] });
    await write(tool, args);
    return { code: result.code ?? 0, stdout: "", stderr: result.stderr ?? "" };
  };
  return { run, calls };
}

describe("reading an install source (10.11)", () => {
  it("accepts package names and versions, and refuses anything else", () => {
    expect(parseNpmSpec("example-plugin")).toEqual({ name: "example-plugin" });
    expect(parseNpmSpec("@scope/example")).toEqual({ name: "@scope/example" });
    expect(parseNpmSpec("@scope/example@1.2.3")).toEqual({
      name: "@scope/example",
      version: "1.2.3",
    });
    expect(parseNpmSpec("example@^1.0.0")).toEqual({ name: "example", version: "^1.0.0" });

    for (const bad of [
      "--registry=http://evil.example",
      "-x",
      "example plugin",
      "example;rm -rf /",
      "",
      "../escape",
      "example@1.2.3 --foo",
    ]) {
      expect(() => parseNpmSpec(bad), bad).toThrow(PluginInstallError);
    }
  });

  it("accepts https repositories only, without credentials or odd refs", () => {
    expect(parseGitSource("https://example.com/user/plugin.git").url.href).toBe(
      "https://example.com/user/plugin.git",
    );
    expect(parseGitSource("https://example.com/p.git", "v1.0.0").ref).toBe("v1.0.0");

    for (const bad of [
      ["http://example.com/p.git", undefined],
      ["git@example.com:user/p.git", undefined],
      ["ssh://example.com/p.git", undefined],
      ["https://user:pass@example.com/p.git", undefined],
      ["--upload-pack=touch pwned", undefined],
      ["https://example.com/p.git", "--exec=whoami"],
      ["https://example.com/p.git", "a ref"],
    ] as const) {
      expect(() => parseGitSource(bad[0], bad[1]), bad[0]).toThrow(PluginInstallError);
    }
  });
});

describe("installing a plugin package (10.11)", () => {
  it("installs from npm without running scripts, and leaves it disabled", async () => {
    const plugins = await pluginsDirectory();
    const { run, calls } = fakeRunner(async (_tool, args) => {
      const prefix = args[args.indexOf("--prefix") + 1]!;
      await writePluginPackage(join(prefix, "node_modules", "example-plugin"));
    });

    const installed = await installPluginPackage({
      pluginsDirectory: plugins,
      source: { kind: "npm", spec: "example-plugin@1.2.3" },
      allow: { npm: true },
      run,
    });

    expect(installed).toMatchObject({
      packageName: "example-plugin",
      pluginId: "com.example.installed",
      version: "1.2.3",
      source: "npm:example-plugin@1.2.3",
      enabled: false,
    });
    expect(calls[0]?.tool).toBe("npm");
    // A package's own install hooks must never run on the way in.
    expect(calls[0]?.args).toContain("--ignore-scripts");
    expect(calls[0]?.args).toContain("example-plugin@1.2.3");
    // The package is there, and nothing was left behind.
    expect(await readdir(plugins)).toEqual(["example-plugin"]);
  });

  it("clones a repository, drops its history and installs its dependencies without scripts", async () => {
    const plugins = await pluginsDirectory();
    const { run, calls } = fakeRunner(async (tool, args) => {
      if (tool !== "git") return;
      const directory = args[args.length - 1]!;
      await writePluginPackage(directory, { name: "@scope/repo-plugin" });
      await mkdir(join(directory, ".git"), { recursive: true });
      await writeFile(join(directory, ".git", "config"), "history", "utf8");
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          name: "@scope/repo-plugin",
          version: "1.2.3",
          type: "module",
          dependencies: { left: "^1.0.0" },
        }),
        "utf8",
      );
    });

    const installed = await installPluginPackage({
      pluginsDirectory: plugins,
      source: { kind: "git", url: "https://example.com/user/plugin.git", ref: "v1.0.0" },
      allow: { git: true },
      run,
    });

    expect(installed).toMatchObject({
      packageName: "scope-repo-plugin",
      source: "git:https://example.com/user/plugin.git#v1.0.0",
      enabled: false,
    });
    expect(calls.map((call) => call.tool)).toEqual(["git", "npm"]);
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(["clone", "--depth", "1", "--branch", "v1.0.0"]) as string[],
    );
    expect(calls[1]?.args).toContain("--ignore-scripts");
    expect(await readdir(join(plugins, "scope-repo-plugin"))).not.toContain(".git");
  });

  it("refuses a source this harness does not allow", async () => {
    const plugins = await pluginsDirectory();
    const { run, calls } = fakeRunner(() => undefined);

    const refused = await installPluginPackage({
      pluginsDirectory: plugins,
      source: { kind: "npm", spec: "example-plugin" },
      run,
    }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PluginInstallError);
    expect(refused).toMatchObject({ code: "INSTALL_NOT_ALLOWED" });
    // Nothing ran, so nothing could have been downloaded.
    expect(calls).toEqual([]);
  });

  it("removes a package that turns out not to be a plugin", async () => {
    const plugins = await pluginsDirectory();
    const { run } = fakeRunner(async (_tool, args) => {
      const prefix = args[args.indexOf("--prefix") + 1]!;
      await writePluginPackage(join(prefix, "node_modules", "example-plugin"), { plugin: false });
    });

    const failed = await installPluginPackage({
      pluginsDirectory: plugins,
      source: { kind: "npm", spec: "example-plugin" },
      allow: { npm: true },
      run,
    }).catch((error: unknown) => error);

    expect(failed).toMatchObject({ code: "INSTALL_NOT_A_PLUGIN" });
    expect(await readdir(plugins)).toEqual([]);
  });

  it("keeps what is already installed unless asked to replace it", async () => {
    const plugins = await pluginsDirectory();
    const stage = async (_tool: "npm" | "git", args: readonly string[]): Promise<void> => {
      const prefix = args[args.indexOf("--prefix") + 1]!;
      await writePluginPackage(join(prefix, "node_modules", "example-plugin"));
    };
    const first = fakeRunner(stage);
    await installPluginPackage({
      pluginsDirectory: plugins,
      source: { kind: "npm", spec: "example-plugin" },
      allow: { npm: true },
      run: first.run,
    });

    const second = fakeRunner(stage);
    const refused = await installPluginPackage({
      pluginsDirectory: plugins,
      source: { kind: "npm", spec: "example-plugin" },
      allow: { npm: true },
      run: second.run,
    }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "INSTALL_ALREADY_PRESENT" });

    const third = fakeRunner(stage);
    const replaced = await installPluginPackage({
      pluginsDirectory: plugins,
      source: { kind: "npm", spec: "example-plugin" },
      allow: { npm: true },
      replace: true,
      run: third.run,
    });
    expect(replaced.packageName).toBe("example-plugin");
    expect(await readdir(plugins)).toEqual(["example-plugin"]);
  });

  it("reports what the tool said when it fails, and leaves nothing behind", async () => {
    const plugins = await pluginsDirectory();
    const { run } = fakeRunner(() => undefined, { code: 1, stderr: "E404 Not Found" });

    const failed = await installPluginPackage({
      pluginsDirectory: plugins,
      source: { kind: "npm", spec: "no-such-plugin" },
      allow: { npm: true },
      run,
    }).catch((error: unknown) => error);

    expect(failed).toMatchObject({
      code: "INSTALL_COMMAND_FAILED",
      detail: "E404 Not Found",
    });
    expect(await readdir(plugins)).toEqual([]);
  });
});
