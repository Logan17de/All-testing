import { describe, expect, it } from "vitest";

import type { NodeDefinition } from "@zet-harness/plugin-api";

import { NodeCatalog } from "./node-catalog.js";

function makeDefinition(type: string, version: string, onExecute: () => void): NodeDefinition {
  return {
    manifest: {
      type,
      version,
      title: `${type}@${version}`,
      inputs: {
        request: { schema: true, required: true },
        credential: {
          schema: { type: "string" },
          secret: true,
        },
      },
      outputs: {
        response: { schema: true, required: true },
      },
      configSchema: true,
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
    expect(manifest.inputs.request).toEqual({ schema: true, required: true });
    expect(manifest.inputs.credential?.secret).toBe(true);
    expect(manifest.outputs.response).toEqual({ schema: true, required: true });
    expect(manifest.behavior.effect).toBe("external-read");
    expect(manifest.behavior.requiredCapabilities).toEqual(["network:http"]);
    expect(catalog.listManifests()).toEqual([manifest]);
    expect(executions).toBe(0);
  });

  it("rejects contradictory effect/recovery metadata before registration or execution", () => {
    let executions = 0;
    const catalog = new NodeCatalog();
    const base = makeDefinition("test.unsafe-write", "1", () => executions++);
    const unsafe: NodeDefinition = {
      ...base,
      manifest: {
        ...base.manifest,
        behavior: {
          ...base.manifest.behavior,
          effect: "external-write",
          idempotency: "unknown",
          recovery: "rerun",
        },
      },
    };

    expect(() => catalog.register(unsafe)).toThrow(/NODE_BEHAVIOR_RECOVERY_UNSAFE/);
    expect(catalog.size).toBe(0);
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

  it("keeps plugin provenance separate from direct low-level registrations", () => {
    const catalog = new NodeCatalog();
    const direct = makeDefinition("test.direct", "1", () => undefined);
    const owned = makeDefinition("test.owned", "3", () => undefined);

    catalog.register(direct);
    catalog.register(owned, { id: "plugin.test", version: "9.2.0" }, ["network:http"]);

    expect(catalog.getManifest("test.direct", "1")).toEqual(direct.manifest);
    expect(catalog.getManifest("test.direct", "1")).not.toBe(direct.manifest);
    expect(catalog.getResolution("test.direct", "1")).toBeUndefined();
    expect(catalog.getResolution("test.owned", "3")).toEqual({
      manifest: owned.manifest,
      plugin: { id: "plugin.test", version: "9.2.0" },
    });
  });

  it("snapshots and freezes plugin-owned node metadata before later mutation", () => {
    const catalog = new NodeCatalog();
    const definition = makeDefinition("test.snapshot", "1", () => undefined);
    const originalCapabilities = definition.manifest.behavior
      .requiredCapabilities as unknown as string[];

    catalog.register(definition);
    const stored = catalog.requireManifest("test.snapshot", "1");

    originalCapabilities[0] = "fs:write";

    expect(stored.behavior.requiredCapabilities).toEqual(["network:http"]);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.behavior)).toBe(true);
    expect(Object.isFrozen(stored.behavior.requiredCapabilities)).toBe(true);
    expect(() =>
      (stored.behavior.requiredCapabilities as unknown as string[]).push("fs:write"),
    ).toThrow();
  });

  it("rejects plugin-owned node capabilities outside the inspected plugin ceiling", () => {
    const catalog = new NodeCatalog();
    const definition = makeDefinition("test.hidden-write", "1", () => undefined);
    const behavior = definition.manifest.behavior as unknown as { requiredCapabilities: string[] };
    behavior.requiredCapabilities = ["fs:write"];

    expect(() =>
      catalog.register(definition, { id: "plugin.test", version: "1" }, ["fs:read"]),
    ).toThrow(/did not declare.*PluginManifest\.capabilities/);
    expect(catalog.size).toBe(0);
  });

  it("unregisters through the registry disposer without invoking executors", () => {
    let executions = 0;
    const catalog = new NodeCatalog();
    const dispose = catalog.register(makeDefinition("test.remove", "1", () => executions++));

    dispose();

    expect(catalog.has("test.remove", "1")).toBe(false);
    expect(catalog.getManifest("test.remove", "1")).toBeUndefined();
    expect(catalog.getResolution("test.remove", "1")).toBeUndefined();
    expect(executions).toBe(0);
  });
});
