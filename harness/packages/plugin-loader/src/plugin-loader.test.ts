import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PluginHost, validatePluginConfig } from "@zet-harness/core";

import {
  describeInstallation,
  discoverPluginPackages,
  enforceDeclaredNodes,
  loadPluginPackage,
  verifyPackageIntegrity,
  type DiscoveredPluginPackage,
  type LoadedPluginPackage,
  type PluginLoadFailure,
} from "./plugin-loader.js";

let pluginsDirectory: string;

/** A complete, working third-party plugin package written to disk. */
const ENTRY_SOURCE = `export default {
  manifest: {
    id: "com.example.greeter",
    name: "Greeter",
    version: "1.2.3",
    apiVersion: 1,
    capabilities: [],
  },
  activate(context) {
    context.nodes.register({
      manifest: {
        type: "example.greeter",
        version: "1",
        title: "Greeter",
        inputs: {},
        outputs: { greeting: { schema: true } },
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
        return { outputs: { greeting: "hello" } };
      },
    });
  },
};
`;

function manifestDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: "com.example.greeter",
    name: "Greeter",
    version: "1.2.3",
    apiVersion: 1,
    license: "MIT",
    entry: "./index.mjs",
    requestedCapabilities: [],
    nodes: [{ type: "example.greeter", version: "1", title: "Greeter" }],
    ...overrides,
  };
}

async function writePackage(
  name: string,
  options: {
    readonly manifest?: Record<string, unknown>;
    readonly entrySource?: string;
    readonly withIntegrity?: boolean;
  } = {},
): Promise<string> {
  const directory = join(pluginsDirectory, name);
  await mkdir(directory, { recursive: true });
  const entrySource = options.entrySource ?? ENTRY_SOURCE;
  await writeFile(join(directory, "index.mjs"), entrySource, "utf8");

  const manifest = options.manifest ?? manifestDocument();
  if (options.withIntegrity === true) {
    manifest["integrity"] = {
      algorithm: "sha256",
      files: { "index.mjs": createHash("sha256").update(entrySource, "utf8").digest("hex") },
    };
  }
  await writeFile(join(directory, "zet-plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  return directory;
}

async function discoverOne(name = "greeter"): Promise<DiscoveredPluginPackage> {
  const result = await discoverPluginPackages({ pluginsDirectory });
  const found = result.packages.find((entry) => entry.packageName === name);
  if (found === undefined) throw new Error(`package ${name} was not discovered`);
  return found;
}

function isFailure(value: LoadedPluginPackage | PluginLoadFailure): value is PluginLoadFailure {
  return "code" in value;
}

beforeEach(async () => {
  pluginsDirectory = await mkdtemp(join(tmpdir(), "zet-plugins-"));
});

afterEach(async () => {
  await rm(pluginsDirectory, { recursive: true, force: true, maxRetries: 3 });
});

describe("discovery", () => {
  it("treats a missing plugins directory as an empty installation", async () => {
    const result = await discoverPluginPackages({
      pluginsDirectory: join(pluginsDirectory, "nope"),
    });
    expect(result.packages).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("requires an absolute plugins directory", async () => {
    await expect(discoverPluginPackages({ pluginsDirectory: "relative" })).rejects.toThrow(
      TypeError,
    );
  });

  it("discovers a valid package", async () => {
    await writePackage("greeter");
    const result = await discoverPluginPackages({ pluginsDirectory });
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]?.manifest.id).toBe("com.example.greeter");
  });

  it("returns packages in a stable order", async () => {
    await writePackage("zeta", { manifest: manifestDocument({ id: "com.example.zeta" }) });
    await writePackage("alpha", { manifest: manifestDocument({ id: "com.example.alpha" }) });
    const result = await discoverPluginPackages({ pluginsDirectory });
    expect(result.packages.map((entry) => entry.packageName)).toEqual(["alpha", "zeta"]);
  });

  it("reports a package with no manifest without failing the whole scan", async () => {
    await mkdir(join(pluginsDirectory, "empty"), { recursive: true });
    await writePackage("greeter");
    const result = await discoverPluginPackages({ pluginsDirectory });
    expect(result.packages).toHaveLength(1);
    expect(result.failures[0]?.code).toBe("manifest-missing");
  });

  it("reports invalid JSON", async () => {
    const directory = join(pluginsDirectory, "broken");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "zet-plugin.json"), "{ not json", "utf8");
    const result = await discoverPluginPackages({ pluginsDirectory });
    expect(result.failures[0]?.code).toBe("manifest-unreadable");
  });

  it("reports a manifest that fails validation", async () => {
    await writePackage("bad", { manifest: manifestDocument({ license: undefined }) });
    const result = await discoverPluginPackages({ pluginsDirectory });
    expect(result.failures[0]?.code).toBe("manifest-invalid");
  });

  it("refuses a package that needs a newer harness", async () => {
    await writePackage("future", { manifest: manifestDocument({ minHarnessVersion: "9.0.0" }) });
    const result = await discoverPluginPackages({ pluginsDirectory, harnessVersion: "0.1.0" });
    expect(result.failures[0]?.message).toContain("requires harness 9.0.0");
  });

  it("accepts a package whose minimum the harness satisfies", async () => {
    await writePackage("ok", { manifest: manifestDocument({ minHarnessVersion: "0.1.0" }) });
    const result = await discoverPluginPackages({ pluginsDirectory, harnessVersion: "0.2.0" });
    expect(result.packages).toHaveLength(1);
  });

  it("imports nothing during discovery", async () => {
    // A package whose entry throws on import must still be discoverable.
    await writePackage("explosive", { entrySource: "throw new Error('boom');\n" });
    const result = await discoverPluginPackages({ pluginsDirectory });
    expect(result.packages).toHaveLength(1);
  });
});

describe("integrity", () => {
  it("reports a package with no integrity block as unsigned", async () => {
    await writePackage("greeter");
    const verification = await verifyPackageIntegrity(await discoverOne());
    expect(verification.unsigned).toBe(true);
    expect(verification.verified).toBe(false);
  });

  it("verifies matching digests", async () => {
    await writePackage("greeter", { withIntegrity: true });
    const verification = await verifyPackageIntegrity(await discoverOne());
    expect(verification.verified).toBe(true);
    expect(verification.unsigned).toBe(false);
  });

  it("detects a tampered file", async () => {
    await writePackage("greeter", { withIntegrity: true });
    await writeFile(join(pluginsDirectory, "greeter", "index.mjs"), "export default {};\n", "utf8");
    const verification = await verifyPackageIntegrity(await discoverOne());
    expect(verification.verified).toBe(false);
    expect(verification.failures[0]?.code).toBe("integrity-mismatch");
  });

  it("detects a file listed in integrity but missing", async () => {
    await writePackage("greeter", {
      manifest: manifestDocument({
        integrity: { algorithm: "sha256", files: { "absent.js": "a".repeat(64) } },
      }),
    });
    const verification = await verifyPackageIntegrity(await discoverOne());
    expect(verification.failures[0]?.code).toBe("integrity-file-missing");
  });

  it("refuses an integrity path that escapes the package", async () => {
    // The manifest validator rejects traversal, so such a package never
    // reaches verification at all.
    await writePackage("greeter", {
      manifest: manifestDocument({
        integrity: { algorithm: "sha256", files: { "../outside.js": "a".repeat(64) } },
      }),
    });
    const result = await discoverPluginPackages({ pluginsDirectory });
    expect(result.failures[0]?.code).toBe("manifest-invalid");
  });
});

describe("loading", () => {
  it("loads a valid package", async () => {
    await writePackage("greeter");
    const loaded = await loadPluginPackage(await discoverOne());
    expect(isFailure(loaded)).toBe(false);
    if (!isFailure(loaded)) expect(loaded.plugin.manifest.id).toBe("com.example.greeter");
  });

  it("verifies integrity before importing the entry", async () => {
    await writePackage("greeter", { withIntegrity: true });
    await writeFile(
      join(pluginsDirectory, "greeter", "index.mjs"),
      "globalThis.__zetPwned = true;\nexport default {};\n",
      "utf8",
    );
    const loaded = await loadPluginPackage(await discoverOne());
    expect(isFailure(loaded)).toBe(true);
    // The tampered module must not have run.
    expect((globalThis as Record<string, unknown>)["__zetPwned"]).toBeUndefined();
  });

  it("can refuse unsigned packages by policy", async () => {
    await writePackage("greeter");
    const loaded = await loadPluginPackage(await discoverOne(), { requireIntegrity: true });
    expect(isFailure(loaded)).toBe(true);
    if (isFailure(loaded)) expect(loaded.code).toBe("integrity-mismatch");
  });

  it("loads an unsigned package when policy allows it", async () => {
    await writePackage("greeter");
    const loaded = await loadPluginPackage(await discoverOne(), { requireIntegrity: false });
    expect(isFailure(loaded)).toBe(false);
    if (!isFailure(loaded)) expect(loaded.unsigned).toBe(true);
  });

  it("refuses a missing entry file", async () => {
    await writePackage("greeter", { manifest: manifestDocument({ entry: "./absent.mjs" }) });
    const loaded = await loadPluginPackage(await discoverOne());
    expect(isFailure(loaded) && loaded.code).toBe("entry-missing");
  });

  it("refuses a module that exports no plugin", async () => {
    await writePackage("greeter", { entrySource: "export default 42;\n" });
    const loaded = await loadPluginPackage(await discoverOne());
    expect(isFailure(loaded) && loaded.code).toBe("no-plugin-export");
  });

  it("refuses a module whose import throws", async () => {
    await writePackage("greeter", { entrySource: "throw new Error('boom');\n" });
    const loaded = await loadPluginPackage(await discoverOne());
    expect(isFailure(loaded) && loaded.code).toBe("import-failed");
  });

  it("refuses a plugin whose identity disagrees with its package manifest", async () => {
    await writePackage("greeter", {
      entrySource: ENTRY_SOURCE.replace("com.example.greeter", "com.example.impostor"),
    });
    const loaded = await loadPluginPackage(await discoverOne());
    expect(isFailure(loaded) && loaded.code).toBe("identity-mismatch");
  });

  it("refuses a plugin whose version disagrees with its package manifest", async () => {
    await writePackage("greeter", {
      entrySource: ENTRY_SOURCE.replace('version: "1.2.3"', 'version: "9.9.9"'),
    });
    const loaded = await loadPluginPackage(await discoverOne());
    expect(isFailure(loaded) && loaded.code).toBe("identity-mismatch");
  });
});

describe("declared node enforcement", () => {
  it("activates a plugin that registers only what it declared", async () => {
    await writePackage("greeter");
    const loaded = await loadPluginPackage(await discoverOne());
    if (isFailure(loaded)) throw new Error(loaded.message);

    const host = new PluginHost();
    await host.activate(enforceDeclaredNodes(loaded));
    expect(host.nodes.has("example.greeter", "1")).toBe(true);
    await host.dispose();
  });

  it("refuses activation when a plugin registers an undeclared node", async () => {
    await writePackage("greeter", {
      manifest: manifestDocument({
        nodes: [{ type: "example.something-else", version: "1", title: "Other" }],
      }),
    });
    const loaded = await loadPluginPackage(await discoverOne());
    if (isFailure(loaded)) throw new Error(loaded.message);

    const host = new PluginHost();
    await expect(host.activate(enforceDeclaredNodes(loaded))).rejects.toThrow(/does not declare/u);
    expect(host.size).toBe(0);
    await host.dispose();
  });

  it("rolls back so an undeclared registration leaves no node behind", async () => {
    await writePackage("greeter", {
      manifest: manifestDocument({ nodes: [] }),
    });
    const loaded = await loadPluginPackage(await discoverOne());
    if (isFailure(loaded)) throw new Error(loaded.message);

    const host = new PluginHost();
    await expect(host.activate(enforceDeclaredNodes(loaded))).rejects.toThrow();
    expect(host.nodes.has("example.greeter", "1")).toBe(false);
    await host.dispose();
  });
});

describe("installation is not authorization", () => {
  it("shows requested capabilities as withheld when nothing is granted", async () => {
    await writePackage("greeter", {
      manifest: manifestDocument({ requestedCapabilities: ["fs:read", "network:https"] }),
    });
    const view = describeInstallation(await discoverOne(), undefined);
    expect(view.requestedCapabilities).toEqual(["fs:read", "network:https"]);
    expect(view.grantedCapabilities).toEqual([]);
    expect(view.withheldCapabilities).toEqual(["fs:read", "network:https"]);
  });

  it("is disabled by default when no configuration names it", async () => {
    await writePackage("greeter");
    expect(describeInstallation(await discoverOne(), undefined).enabled).toBe(false);
  });

  it("reports only the capabilities the host actually granted", async () => {
    await writePackage("greeter", {
      manifest: manifestDocument({ requestedCapabilities: ["fs:read", "fs:write"] }),
    });
    const config = validatePluginConfig({
      plugins: [{ id: "com.example.greeter", enabled: true, grantedCapabilities: ["fs:read"] }],
    });
    const view = describeInstallation(await discoverOne(), config.entries[0]);
    expect(view.grantedCapabilities).toEqual(["fs:read"]);
    expect(view.withheldCapabilities).toEqual(["fs:write"]);
    expect(view.enabled).toBe(true);
  });

  it("does not grant a capability the package never requested", async () => {
    await writePackage("greeter", {
      manifest: manifestDocument({ requestedCapabilities: ["fs:read"] }),
    });
    const config = validatePluginConfig({
      plugins: [
        {
          id: "com.example.greeter",
          enabled: true,
          grantedCapabilities: ["fs:read", "git:commit"],
        },
      ],
    });
    const view = describeInstallation(await discoverOne(), config.entries[0]);
    // The grant list is host policy, but the plugin's effective set is still
    // bounded by what it declared it needs.
    expect(view.grantedCapabilities).toEqual(["fs:read"]);
  });

  it("surfaces the package license", async () => {
    await writePackage("greeter", { manifest: manifestDocument({ license: "Apache-2.0" }) });
    expect(describeInstallation(await discoverOne(), undefined).license).toBe("Apache-2.0");
  });

  it("flags an unsigned package in the installation view", async () => {
    await writePackage("greeter");
    expect(describeInstallation(await discoverOne(), undefined).unsigned).toBe(true);
  });
});
