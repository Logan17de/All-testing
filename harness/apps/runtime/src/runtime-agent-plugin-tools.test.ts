import { expect, it, vi } from "vitest";
import { PluginHost } from "@zet-harness/core";
import {
  PLUGIN_API_VERSION,
  type AdapterInvocationContext,
  type HarnessPlugin,
  type ToolAdapter,
} from "@zet-harness/plugin-api";
import { collectInstalledAgentPluginTools } from "./runtime-agent-plugin-tools.js";
function context(signal = new AbortController().signal): AdapterInvocationContext {
  return {
    runId: "r",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "e",
    signal,
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => 0,
    },
  };
}
function tool(effect: "external-read" | "external-write" = "external-read"): ToolAdapter {
  return {
    manifest: {
      id: "test.plugin.tool",
      version: "1",
      title: "Fixture tool",
      inputSchema: true,
      outputSchema: true,
      behavior: {
        primitiveFamily: "effect",
        determinism: "nondeterministic",
        effect,
        idempotency: effect === "external-read" ? "idempotent" : "unknown",
        recovery: "manual",
        executionMode: "in-process",
        requiredCapabilities: ["fixture:access"],
      },
    },
    invoke: vi.fn(() => Promise.resolve({ value: { success: true } })),
  };
}
function plugin(adapter: ToolAdapter, id = "test.owner"): HarnessPlugin {
  return {
    manifest: {
      id,
      name: id,
      version: "1",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: [{ id: "fixture:access" }],
    },
    activate: (ctx) => ctx.tools.register(adapter),
  };
}
async function fixture(effect: "external-read" | "external-write" = "external-read") {
  const host = new PluginHost();
  const original = tool(effect);
  await host.activate(plugin(original));
  const state = { granted: true };
  const approve = vi.fn(() => Promise.resolve(true));
  const options = { host, allows: () => state.granted, approve };
  return { host, original, state, approve, options };
}
it("offers active granted plugin reads by default and excludes unowned registrations", async () => {
  const { host, original, options, approve } = await fixture();
  const unowned = tool();
  host.tools.register({ ...unowned, manifest: { ...unowned.manifest, id: "unowned.tool" } });
  const collected = collectInstalledAgentPluginTools(options);
  expect(collected.map((entry) => entry.owner)).toEqual([JSON.stringify(["test.owner", "1"])]);
  expect(await collected[0]!.adapter.invoke({ query: "fixture" }, context())).toEqual({
    value: { success: true },
  });
  expect(original.invoke).toHaveBeenCalledTimes(1);
  expect(approve).not.toHaveBeenCalled();
  await host.unload("test.owner");
});
it("revocation denies stale tools without invocation", async () => {
  const { host, original, state, options } = await fixture();
  const adapter = collectInstalledAgentPluginTools(options)[0]!.adapter;
  state.granted = false;
  expect(collectInstalledAgentPluginTools(options)).toEqual([]);
  await expect(adapter.invoke({}, context())).rejects.toThrow("authority");
  expect(original.invoke).not.toHaveBeenCalled();
  await host.unload("test.owner");
});
it("write approval uses immutable exact input and decline prevents invocation", async () => {
  const { host, original, options } = await fixture("external-write");
  const input = { nested: { value: "original" } };
  const approve = vi.fn((request: { tool: string; args: unknown }) => {
    expect(request).toMatchObject({
      tool: "test.plugin.tool",
      args: { nested: { value: "original" } },
    });
    input.nested.value = "changed";
    return Promise.resolve(true);
  });
  const adapter = collectInstalledAgentPluginTools({ ...options, approve })[0]!.adapter;
  await adapter.invoke(input, context());
  expect(original.invoke).toHaveBeenCalledWith(
    { nested: { value: "original" } },
    expect.anything(),
  );
  const denied = collectInstalledAgentPluginTools({
    ...options,
    approve: () => Promise.resolve(false),
  })[0]!.adapter;
  await expect(denied.invoke({}, context())).rejects.toThrow("approval");
  expect(original.invoke).toHaveBeenCalledTimes(1);
  await host.unload("test.owner");
});
it("hot replacement cannot inherit captured tool identity or approval", async () => {
  const { host, original, options } = await fixture("external-write");
  const replacement = tool("external-write");
  const adapter = collectInstalledAgentPluginTools({
    ...options,
    approve: async () => {
      await host.unload("test.owner");
      await host.activate(plugin(replacement));
      return true;
    },
  })[0]!.adapter;
  await expect(adapter.invoke({}, context())).rejects.toThrow("authority");
  expect(original.invoke).not.toHaveBeenCalled();
  expect(replacement.invoke).not.toHaveBeenCalled();
  await host.unload("test.owner");
});
it("cancellation and grant revocation during consent prevent execution", async () => {
  const { host, original, state, options } = await fixture("external-write");
  const controller = new AbortController();
  const adapter = collectInstalledAgentPluginTools({
    ...options,
    approve: () => {
      state.granted = false;
      controller.abort();
      return Promise.resolve(true);
    },
  })[0]!.adapter;
  await expect(adapter.invoke({}, context(controller.signal))).rejects.toThrow();
  expect(original.invoke).not.toHaveBeenCalled();
  await host.unload("test.owner");
});
it("invalid, cyclic, oversized and accessor input is refused before consent", async () => {
  const { host, original, options, approve } = await fixture("external-write");
  const adapter = collectInstalledAgentPluginTools(options)[0]!.adapter;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const getter = vi.fn(() => "secret");
  const accessor = Object.defineProperty({}, "private", { enumerable: true, get: getter });
  for (const input of [cyclic, accessor, { value: "x".repeat(131073) }, { value: Infinity }])
    await expect(adapter.invoke(input as never, context())).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
  expect(original.invoke).not.toHaveBeenCalled();
  await host.unload("test.owner");
});
it("rechecks grant after approval and never invokes a revoked write tool", async () => {
  const { host, original, state, options } = await fixture("external-write");
  const adapter = collectInstalledAgentPluginTools({
    ...options,
    approve: () => {
      state.granted = false;
      return Promise.resolve(true);
    },
  })[0]!.adapter;
  await expect(adapter.invoke({}, context())).rejects.toThrow("authority");
  expect(original.invoke).not.toHaveBeenCalled();
  await host.unload("test.owner");
});
it("plugin failures never expose raw credentials in persisted failure reasons", async () => {
  const { host, original, options } = await fixture();
  vi.mocked(original.invoke).mockRejectedValue(new Error("private-provider-token-fixture"));
  const adapter = collectInstalledAgentPluginTools(options)[0]!.adapter;
  await expect(adapter.invoke({}, context())).rejects.toThrow(
    "Installed plugin tool execution failed.",
  );
  await host.unload("test.owner");
});
