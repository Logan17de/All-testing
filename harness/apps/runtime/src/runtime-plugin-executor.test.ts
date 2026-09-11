import { describe, expect, it } from "vitest";

import { CapabilityPermissionPolicy, PluginHost } from "@zet-harness/core";
import type { HarnessPlugin, NodeDefinition } from "@zet-harness/plugin-api";

import { createPluginNodeExecutor, isPluginExecutionError } from "./runtime-plugin-executor.js";
import type { RuntimeNodeExecution } from "./runtime-run-dispatcher.js";

function node(
  type: string,
  requiredCapabilities: readonly string[] = [],
  execute?: NodeDefinition["execute"],
): NodeDefinition {
  return {
    manifest: {
      type,
      version: "1",
      title: type,
      inputs: { value: { schema: true } },
      outputs: { value: { schema: true } },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      behavior: {
        primitiveFamily: requiredCapabilities.length > 0 ? "effect" : "pure",
        determinism: requiredCapabilities.length > 0 ? "nondeterministic" : "deterministic",
        effect: requiredCapabilities.length > 0 ? "external-read" : "none",
        idempotency: requiredCapabilities.length > 0 ? "idempotent" : "not-applicable",
        recovery: "rerun",
        executionMode: "in-process",
        requiredCapabilities,
      },
    },
    ...(execute === undefined
      ? {
          execute: (request) => ({
            outputs: { value: Number(request.inputs["value"] ?? 0) + 1 },
          }),
        }
      : { execute }),
  };
}

function plugin(id: string, definitions: readonly NodeDefinition[]): HarnessPlugin {
  const capabilities = [
    ...new Set(definitions.flatMap((d) => d.manifest.behavior.requiredCapabilities)),
  ].map((capability) => ({ id: capability }));
  return {
    manifest: { id, name: id, version: "1", apiVersion: 1, capabilities },
    activate(context) {
      for (const definition of definitions) context.nodes.register(definition);
    },
  };
}

function execution(type: string, value = 1): RuntimeNodeExecution {
  return {
    runId: "run-1",
    logicalEffectId: "effect-1",
    op: 0,
    attempt: 1,
    signal: new AbortController().signal,
    inputs: [{ port: "value", value }],
    operation: {
      type,
      version: "1",
      config: {},
    },
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => 0,
    },
  } as unknown as RuntimeNodeExecution;
}

async function denial(
  run: () => Promise<unknown>,
): Promise<{ code: string; missing: readonly string[] }> {
  try {
    await run();
  } catch (error: unknown) {
    if (isPluginExecutionError(error)) {
      return { code: error.code, missing: error.missingCapabilities };
    }
    throw error;
  }
  throw new Error("Expected the execution to be refused.");
}

describe("resolving a plugin node", () => {
  it("runs a node an in-process plugin registered", async () => {
    const host = new PluginHost();
    await host.activate(plugin("com.example.p", [node("vendor.increment")]));
    const executor = createPluginNodeExecutor({ host });

    const result = await executor(execution("vendor.increment", 41));
    expect(result.outputs).toEqual({ value: 42 });
    await host.dispose();
  });

  it("refuses a node no plugin provides", async () => {
    const executor = createPluginNodeExecutor({ host: new PluginHost() });
    expect((await denial(() => executor(execution("vendor.missing")))).code).toBe("unknown-node");
  });

  it("refuses a node with no executor", async () => {
    const host = new PluginHost();
    const control = node("vendor.control");
    await host.activate(plugin("com.example.c", [{ manifest: control.manifest }]));
    const executor = createPluginNodeExecutor({ host });
    expect((await denial(() => executor(execution("vendor.control")))).code).toBe("not-executable");
    await host.dispose();
  });

  it("reports a failing node as an execution failure", async () => {
    const host = new PluginHost();
    await host.activate(
      plugin("com.example.b", [
        node("vendor.boom", [], () => {
          throw new Error("node exploded");
        }),
      ]),
    );
    const executor = createPluginNodeExecutor({ host });
    expect((await denial(() => executor(execution("vendor.boom")))).code).toBe("execution-failed");
    await host.dispose();
  });

  it("prefers an in-process registration over a sandbox", async () => {
    const host = new PluginHost();
    await host.activate(
      plugin("com.example.p", [
        node("vendor.same", [], () => ({ outputs: { value: "in-process" } })),
      ]),
    );
    const executor = createPluginNodeExecutor({
      host,
      sandboxes: [
        {
          pluginId: "com.example.s",
          sandboxFlags: [],
          tools: [],
          close: () => Promise.resolve(),
          nodes: [node("vendor.same", [], () => ({ outputs: { value: "sandboxed" } }))],
        },
      ],
    });
    const result = await executor(execution("vendor.same"));
    expect(result.outputs).toEqual({ value: "in-process" });
    await host.dispose();
  });

  it("runs a node contributed by a sandboxed plugin", async () => {
    const executor = createPluginNodeExecutor({
      sandboxes: [
        {
          pluginId: "com.example.s",
          sandboxFlags: [],
          tools: [],
          close: () => Promise.resolve(),
          nodes: [node("vendor.sandboxed", [], () => ({ outputs: { value: "from sandbox" } }))],
        },
      ],
    });
    const result = await executor(execution("vendor.sandboxed"));
    expect(result.outputs).toEqual({ value: "from sandbox" });
  });
});

describe("capabilities are checked on every invocation", () => {
  it("runs a node whose capabilities the host granted", async () => {
    const host = new PluginHost();
    await host.activate(plugin("com.example.r", [node("vendor.reader", ["fs:read"])]));
    const executor = createPluginNodeExecutor({
      host,
      policies: new Map([
        ["com.example.r", new CapabilityPermissionPolicy({ granted: ["fs:read"] })],
      ]),
    });
    await expect(executor(execution("vendor.reader"))).resolves.toBeDefined();
    await host.dispose();
  });

  it("refuses a node whose capability was not granted", async () => {
    const host = new PluginHost();
    await host.activate(plugin("com.example.r", [node("vendor.reader", ["fs:read"])]));
    const executor = createPluginNodeExecutor({
      host,
      policies: new Map([["com.example.r", new CapabilityPermissionPolicy({ granted: [] })]]),
    });
    const result = await denial(() => executor(execution("vendor.reader")));
    expect(result.code).toBe("capability-denied");
    expect(result.missing).toEqual(["fs:read"]);
    await host.dispose();
  });

  it("treats a plugin with no policy as granting nothing", async () => {
    const host = new PluginHost();
    await host.activate(plugin("com.example.r", [node("vendor.reader", ["fs:read"])]));
    // Failing open for an unmapped plugin would undo the capability model.
    const executor = createPluginNodeExecutor({ host });
    expect((await denial(() => executor(execution("vendor.reader")))).code).toBe(
      "capability-denied",
    );
    await host.dispose();
  });

  it("honours an explicit denial over a grant", async () => {
    const host = new PluginHost();
    await host.activate(plugin("com.example.r", [node("vendor.reader", ["fs:read"])]));
    const executor = createPluginNodeExecutor({
      host,
      policies: new Map([
        [
          "com.example.r",
          new CapabilityPermissionPolicy({ granted: ["fs:read"], denied: ["fs:read"] }),
        ],
      ]),
    });
    expect((await denial(() => executor(execution("vendor.reader")))).code).toBe(
      "capability-denied",
    );
    await host.dispose();
  });

  it("does not check a policy for a node that needs no capabilities", async () => {
    const host = new PluginHost();
    await host.activate(plugin("com.example.p", [node("vendor.increment")]));
    const executor = createPluginNodeExecutor({ host });
    await expect(executor(execution("vendor.increment"))).resolves.toBeDefined();
    await host.dispose();
  });

  it("checks the policy again on a second invocation", async () => {
    const host = new PluginHost();
    await host.activate(plugin("com.example.r", [node("vendor.reader", ["fs:read"])]));
    const executor = createPluginNodeExecutor({
      host,
      policies: new Map([["com.example.r", new CapabilityPermissionPolicy({ granted: [] })]]),
    });
    // A denial is not cached as an allow, and vice versa.
    expect((await denial(() => executor(execution("vendor.reader")))).code).toBe(
      "capability-denied",
    );
    expect((await denial(() => executor(execution("vendor.reader")))).code).toBe(
      "capability-denied",
    );
    await host.dispose();
  });
});
