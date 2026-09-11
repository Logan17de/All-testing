import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { CapabilityPermissionPolicy, PluginHost, validatePluginConfig } from "@zet-harness/core";
import {
  describeInstallation,
  discoverPluginPackages,
  enforceDeclaredNodes,
  loadPluginPackage,
  verifyPackageIntegrity,
  type LoadedPluginPackage,
  type PluginLoadFailure,
} from "@zet-harness/plugin-loader";

/**
 * Loads the example plugin from its real location in the repository.
 *
 * The example is what an outside author copies, so a broken example is worse
 * than no example. This test fails CI if it stops working.
 */
const examplesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..", "examples");
const examplePath = join(examplesDirectory, "hello-plugin", "index.mjs");

function isFailure(value: LoadedPluginPackage | PluginLoadFailure): value is PluginLoadFailure {
  return "code" in value;
}

async function discoverExample() {
  const result = await discoverPluginPackages({
    pluginsDirectory: examplesDirectory,
    harnessVersion: "0.1.0",
  });
  const found = result.packages.find((entry) => entry.manifest.id === "com.example.hello");
  if (found === undefined) {
    throw new Error(`example plugin not discovered; failures: ${JSON.stringify(result.failures)}`);
  }
  return found;
}

let originalSource: string | undefined;

afterAll(async () => {
  if (originalSource !== undefined) {
    await writeFile(examplePath, originalSource, "utf8");
  }
});

describe("the shipped example plugin", () => {
  it("is discovered with a valid manifest", async () => {
    const discovered = await discoverExample();
    expect(discovered.manifest.license).toBe("MIT");
    expect(discovered.manifest.nodes.map((node) => node.type)).toEqual(["example.reverse-text"]);
  });

  it("requests no capabilities, because it touches nothing outside itself", async () => {
    const discovered = await discoverExample();
    expect(discovered.manifest.requestedCapabilities).toEqual([]);
  });

  it("passes its own integrity check", async () => {
    const verification = await verifyPackageIntegrity(await discoverExample());
    expect(verification.unsigned).toBe(false);
    expect(verification.verified).toBe(true);
  });

  it("loads even under the strictest integrity policy", async () => {
    const loaded = await loadPluginPackage(await discoverExample(), { requireIntegrity: true });
    expect(isFailure(loaded)).toBe(false);
  });

  it("activates and registers exactly the node it declared", async () => {
    const loaded = await loadPluginPackage(await discoverExample());
    if (isFailure(loaded)) throw new Error(loaded.message);

    const host = new PluginHost();
    try {
      await host.activate(enforceDeclaredNodes(loaded));
      expect(host.nodes.has("example.reverse-text", "1")).toBe(true);
    } finally {
      await host.dispose();
    }
  });

  it("actually computes its declared output", async () => {
    const loaded = await loadPluginPackage(await discoverExample());
    if (isFailure(loaded)) throw new Error(loaded.message);

    const host = new PluginHost();
    try {
      await host.activate(enforceDeclaredNodes(loaded));
      const definition = host.nodes.getDefinition("example.reverse-text", "1");
      const result = await definition?.execute?.(
        { inputs: { text: "harness" }, config: {} },
        { signal: new AbortController().signal },
      );
      expect(result?.outputs).toEqual({ text: "ssenrah" });
    } finally {
      await host.dispose();
    }
  });

  it("honours its own configuration schema", async () => {
    const loaded = await loadPluginPackage(await discoverExample());
    if (isFailure(loaded)) throw new Error(loaded.message);

    const host = new PluginHost();
    try {
      await host.activate(enforceDeclaredNodes(loaded));
      const definition = host.nodes.getDefinition("example.reverse-text", "1");
      const result = await definition?.execute?.(
        { inputs: { text: "abc" }, config: { separator: "-" } },
        { signal: new AbortController().signal },
      );
      expect(result?.outputs).toEqual({ text: "c-b-a" });
    } finally {
      await host.dispose();
    }
  });

  it("is disabled until a host enables it", async () => {
    const view = describeInstallation(await discoverExample(), undefined);
    expect(view.enabled).toBe(false);
  });

  it("becomes enabled only through host configuration", async () => {
    const config = validatePluginConfig({
      plugins: [{ id: "com.example.hello", enabled: true }],
    });
    const view = describeInstallation(await discoverExample(), config.entries[0]);
    expect(view.enabled).toBe(true);
    expect(view.grantedCapabilities).toEqual([]);
  });

  it("receives a default-deny policy when the host grants nothing", () => {
    const policy = new CapabilityPermissionPolicy({ granted: [] });
    expect(policy.allows("fs:read")).toBe(false);
  });

  it("is refused after tampering, and the tampered code never runs", async () => {
    originalSource = await readFile(examplePath, "utf8");
    await writeFile(
      examplePath,
      `${originalSource}\nglobalThis.__zetExampleTampered = true;\n`,
      "utf8",
    );

    const loaded = await loadPluginPackage(await discoverExample());
    expect(isFailure(loaded)).toBe(true);
    if (isFailure(loaded)) expect(loaded.code).toBe("integrity-mismatch");
    expect((globalThis as Record<string, unknown>)["__zetExampleTampered"]).toBeUndefined();

    await writeFile(examplePath, originalSource, "utf8");
    originalSource = undefined;
  });
});
