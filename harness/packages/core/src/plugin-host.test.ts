import { describe, expect, it } from "vitest";

import {
  PLUGIN_API_VERSION,
  type HarnessPlugin,
  type NodeDefinition,
  type PluginContext,
} from "@zet-harness/plugin-api";

import { PluginHost } from "./plugin-host.js";

function makeNode(type: string): NodeDefinition {
  return {
    manifest: {
      type,
      version: "1",
      title: type,
      inputSchema: true,
      configSchema: true,
      outputSchema: true,
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
      return { outputs: request.inputs };
    },
  };
}

function makePlugin(id: string, activate: HarnessPlugin["activate"]): HarnessPlugin {
  return {
    manifest: {
      id,
      name: id,
      version: "1",
      apiVersion: PLUGIN_API_VERSION,
    },
    activate,
  };
}

describe("PluginHost lifecycle", () => {
  it("unloads registrations and cleanup callbacks in reverse registration order", async () => {
    const host = new PluginHost();
    const cleanupOrder: string[] = [];

    const plugin = makePlugin("test.reverse-cleanup", (context) => {
      context.nodes.register(makeNode("test.reverse-cleanup.node"));
      context.onDispose(() => {
        expect(host.nodes.has("test.reverse-cleanup.node", "1")).toBe(true);
        cleanupOrder.push("second");
      });
      context.onDispose(() => {
        cleanupOrder.push("third");
      });
    });

    await host.activate(plugin);
    expect(host.nodes.has("test.reverse-cleanup.node", "1")).toBe(true);

    await expect(host.unload(plugin.manifest.id)).resolves.toBe(true);

    expect(cleanupOrder).toEqual(["third", "second"]);
    expect(host.nodes.has("test.reverse-cleanup.node", "1")).toBe(false);
    expect(host.has(plugin.manifest.id)).toBe(false);
  });

  it("rolls back partial activation and never publishes a failed plugin", async () => {
    const host = new PluginHost();
    const cleanupOrder: string[] = [];

    const plugin = makePlugin("test.partial-activation", (context) => {
      context.nodes.register(makeNode("test.partial-activation.node"));
      context.onDispose(() => {
        cleanupOrder.push("cleanup");
      });
      throw new Error("activation exploded");
    });

    await expect(host.activate(plugin)).rejects.toThrow("activation exploded");

    expect(cleanupOrder).toEqual(["cleanup"]);
    expect(host.has(plugin.manifest.id)).toBe(false);
    expect(host.nodes.has("test.partial-activation.node", "1")).toBe(false);
  });

  it("rejects duplicate activation without disturbing the active instance", async () => {
    const host = new PluginHost();
    let activations = 0;

    const plugin = makePlugin("test.duplicate", () => {
      activations += 1;
    });

    await host.activate(plugin);

    await expect(host.activate(plugin)).rejects.toThrow("already active or activating");
    expect(activations).toBe(1);
    expect(host.has(plugin.manifest.id)).toBe(true);
  });

  it("returns false for missing plugins and makes unload idempotent at the host boundary", async () => {
    const host = new PluginHost();
    const plugin = makePlugin("test.unload-idempotent", () => undefined);

    await expect(host.unload(plugin.manifest.id)).resolves.toBe(false);

    await host.activate(plugin);
    await expect(host.unload(plugin.manifest.id)).resolves.toBe(true);
    await expect(host.unload(plugin.manifest.id)).resolves.toBe(false);
    expect(host.size).toBe(0);
  });

  it("runs every disposer even when cleanup fails and reports all cleanup errors", async () => {
    const host = new PluginHost();
    const cleanupOrder: string[] = [];

    const plugin = makePlugin("test.cleanup-errors", (context) => {
      context.onDispose(() => {
        cleanupOrder.push("first");
        throw new Error("first cleanup failed");
      });
      context.onDispose(() => {
        cleanupOrder.push("second");
        throw new Error("second cleanup failed");
      });
    });

    await host.activate(plugin);

    let caught: unknown;
    try {
      await host.unload(plugin.manifest.id);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
    expect(cleanupOrder).toEqual(["second", "first"]);
    expect(host.has(plugin.manifest.id)).toBe(false);
  });

  it("rejects unload while activation is still in progress", async () => {
    const host = new PluginHost();
    let releaseActivation: (() => void) | undefined;

    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });

    const plugin = makePlugin("test.concurrent-unload", async () => {
      await activationGate;
    });

    const activation = host.activate(plugin);

    await expect(host.unload(plugin.manifest.id)).rejects.toThrow(
      "cannot be unloaded while activation is in progress",
    );

    releaseActivation?.();
    await activation;
    await expect(host.unload(plugin.manifest.id)).resolves.toBe(true);
  });

  it("closes the activation context after activate returns", async () => {
    const host = new PluginHost();
    let capturedContext: PluginContext | undefined;

    const plugin = makePlugin("test.closed-context", (context) => {
      capturedContext = context;
    });

    await host.activate(plugin);

    expect(capturedContext).toBeDefined();
    expect(() => capturedContext?.onDispose(() => undefined)).toThrow(
      "attempted to register cleanup after activation completed",
    );
    expect(() => capturedContext?.nodes.register(makeNode("test.closed-context.late"))).toThrow(
      "attempted to register a node after activation completed",
    );

    await host.dispose();
  });
});
