import { describe, expect, it } from "vitest";

import type { NodeDefinition } from "@zet-harness/plugin-api";

import { NodeCatalog } from "./node-catalog.js";

function makeDefinition(type: string, version: string, onExecute: () => void): NodeDefinition {
  return {
    manifest: {
      type,
      version,
      title: `${type}@${version}`,
      inputSchema: true,
      configSchema: true,
      outputSchema: true,
      behavior: {
        primitiveFamily: "effect",
        determinism: "nondeterministic",
        effect: "external-read",
        idempotency: "idempotent",
        recovery: "reuse",
        executionMode: "in-process",
        timeoutMs: 30_000,
        retry: { maxAttempts: 2, backoffMs: 100 },
        requiredCapabilities: ["network:http"],
      },
    },
    execute() {
      onExecute();
      throw new Error("executor must not run during manifest inspection");
    },
  };
}

describe("NodeCatalog", () => {
  it("inspects complete static manifests without executing node code", () => {
    let executions = 0;
    const catalog = new NodeCatalog();
    catalog.register(makeDefinition("test.http", "1", () => executions++));

    const manifest = catalog.requireManifest("test.http", "1");

    expect(executions).toBe(0);
    expect(manifest.type).toBe("test.http");
    expect(manifest.inputSchema).toBe(true);
    expect(manifest.behavior.effect).toBe("external-read");
    expect(manifest.behavior.requiredCapabilities).toEqual(["network:http"]);
    expect(catalog.listManifests()).toEqual([manifest]);
    expect(executions).toBe(0);
  });

  it("keeps node versions independently inspectable", () => {
    const catalog = new NodeCatalog();
    catalog.register(makeDefinition("test.echo", "1", () => undefined));
    catalog.register(makeDefinition("test.echo", "2", () => undefined));

    expect(catalog.requireManifest("test.echo", "1").version).toBe("1");
    expect(catalog.requireManifest("test.echo", "2").version).toBe("2");
    expect(catalog.size).toBe(2);
  });

  it("unregisters through the registry disposer without invoking executors", () => {
    let executions = 0;
    const catalog = new NodeCatalog();
    const dispose = catalog.register(makeDefinition("test.remove", "1", () => executions++));

    dispose();

    expect(catalog.has("test.remove", "1")).toBe(false);
    expect(catalog.getManifest("test.remove", "1")).toBeUndefined();
    expect(executions).toBe(0);
  });
});
