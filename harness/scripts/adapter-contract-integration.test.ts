import { describe, expect, it, vi } from "vitest";

import { ModelCatalog, PluginHost, ToolCatalog } from "@zet-harness/core";
import { createScriptedModelAdapter } from "@zet-harness/models";
import {
  PLUGIN_API_VERSION,
  type AdapterInvocationContext,
  type HarnessPlugin,
  type ModelAdapter,
  type ModelRequest,
  type ModelResult,
  type ModelStreamEvent,
  type PluginContext,
  type ToolAdapter,
} from "@zet-harness/plugin-api";
import { PlainDagRun, SchedulerConcurrency } from "@zet-harness/scheduler";
import { createMockExecutionIr, createMockExecutionOp } from "@zet-harness/scheduler/testing";
import { createScriptedToolAdapter } from "@zet-harness/tools";

const request: ModelRequest = {
  messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
};
const answer = (text: string): ModelResult => ({
  message: { role: "assistant", parts: [{ kind: "text", text }] },
  finishReason: "stop",
});
function context(signal = new AbortController().signal): AdapterInvocationContext {
  return {
    runId: "test-run",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "test-effect",
    signal,
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: (count = 1): number => {
        if (count !== 0) throw new Error("Unexpected mock internal retry.");
        return 1;
      },
    },
  };
}
function plugin(
  activate: HarnessPlugin["activate"],
  capabilities: readonly string[] = [],
): HarnessPlugin {
  return {
    manifest: {
      id: "test.adapters",
      name: "Adapter fixtures",
      version: "1",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: capabilities.map((id) => ({ id })),
    },
    activate,
  };
}
function model(): ModelAdapter {
  return createScriptedModelAdapter([answer("first"), answer("second")]);
}
function tool(): ToolAdapter {
  return createScriptedToolAdapter([{ value: { success: true } }]);
}

describe("public model/tool registration services", () => {
  it("registers and inspects both kinds without invoking them, then unloads together", async () => {
    const host = new PluginHost();
    const fixture = model();
    const generate = vi.fn(fixture.generate);
    const invoke = vi.fn(tool().invoke);
    await host.activate(
      plugin((ctx) => {
        ctx.models.register({ ...fixture, generate });
        ctx.tools.register({ ...tool(), invoke });
        for (const registry of [ctx.models, ctx.tools]) {
          expect(Object.isFrozen(registry)).toBe(true);
          expect(Reflect.ownKeys(registry)).toEqual(["register"]);
          expect(Reflect.set(registry, "grant", vi.fn())).toBe(false);
        }
      }),
    );
    expect(host.models.getResolution(fixture.manifest.id, "1")?.plugin).toEqual({
      id: "test.adapters",
      version: "1",
    });
    expect(host.models.listManifests()).toHaveLength(1);
    expect(host.tools.listManifests()).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    await host.dispose();
    expect(host.models.size).toBe(0);
    expect(host.tools.size).toBe(0);
  });

  it("rolls back mixed services and cleanup callbacks in reverse order", async () => {
    const host = new PluginHost();
    const observations: number[][] = [];
    await expect(
      host.activate(
        plugin((ctx) => {
          ctx.models.register(model());
          ctx.onDispose(() => {
            observations.push([host.models.size, host.tools.size]);
          });
          ctx.tools.register(tool());
          ctx.onDispose(() => {
            observations.push([host.models.size, host.tools.size]);
          });
          throw new Error("activation failed");
        }),
      ),
    ).rejects.toThrow("activation failed");
    expect(observations).toEqual([
      [1, 1],
      [1, 0],
    ]);
    expect(host.size + host.models.size + host.tools.size).toBe(0);
  });

  it("closes both registry facades after activation", async () => {
    const host = new PluginHost();
    let captured!: PluginContext;
    await host.activate(
      plugin((ctx) => {
        captured = ctx;
      }),
    );
    expect(() => captured.models.register(model())).toThrow("after activation completed");
    expect(() => captured.tools.register(tool())).toThrow("after activation completed");
    await host.dispose();
  });

  it.each(["model", "tool"] as const)(
    "rejects an undeclared %s capability and rolls back",
    async (kind) => {
      const host = new PluginHost();
      const capabilities = ["fs:read"];
      const proposed = plugin((ctx) => {
        // Alter the original declaration after the host has inspected it.
        (proposed.manifest.capabilities as { id: string }[]).push({ id: "shell:run" });
        if (kind === "model") {
          const value = model();
          ctx.models.register({
            ...value,
            manifest: { ...value.manifest, requiredCapabilities: ["shell:run"] },
          });
        } else {
          const value = tool();
          ctx.tools.register({
            ...value,
            manifest: {
              ...value.manifest,
              behavior: { ...value.manifest.behavior, requiredCapabilities: ["shell:run"] },
            },
          });
        }
      }, capabilities);
      await expect(host.activate(proposed)).rejects.toThrow("plugin did not declare");
      expect(host.models.size + host.tools.size + host.size).toBe(0);
    },
  );

  it("snapshots metadata and pins methods while preserving their original receiver", async () => {
    const catalog = new ModelCatalog();
    const caps = ["network:https"];
    const original = {
      manifest: { ...model().manifest, requiredCapabilities: caps },
      response: answer("pinned"),
      generate() {
        return Promise.resolve(this.response);
      },
      stream: model().stream,
    } as ModelAdapter & { response: ModelResult };
    catalog.register(original, { id: "owner", version: "2" }, caps);
    caps.push("shell:run");
    const replacement = vi.fn(() => Promise.resolve(answer("replaced")));
    Reflect.set(original, "generate", replacement);
    expect(catalog.getManifest(original.manifest.id, "1")?.requiredCapabilities).toEqual([
      "network:https",
    ]);
    expect(Object.isFrozen(catalog.getManifest(original.manifest.id, "1")?.features)).toBe(true);
    expect(
      await catalog.requireAdapter(original.manifest.id, "1").generate(request, context()),
    ).toEqual(answer("pinned"));
    expect(replacement).not.toHaveBeenCalled();
  });

  it("keeps versioned identities distinct and disposers identity-safe", () => {
    const catalog = new ToolCatalog();
    const first = tool();
    const dispose = catalog.register(first);
    catalog.register({ ...first, manifest: { ...first.manifest, version: "2" } });
    expect(() => catalog.register(first)).toThrow("already registered");
    dispose();
    catalog.register(first);
    dispose();
    expect(catalog.size).toBe(2);
    expect(catalog.getResolution(first.manifest.id, "1")).toBeUndefined();
  });

  it("rejects mismatched streaming contracts, invalid flags, and ambiguous identity", () => {
    const catalog = new ModelCatalog();
    const fixture = model();
    const withoutStream = { manifest: fixture.manifest, generate: fixture.generate };
    expect(() => catalog.register(withoutStream)).toThrow("streaming declaration");
    expect(() =>
      catalog.register({
        ...fixture,
        manifest: {
          ...fixture.manifest,
          features: { ...fixture.manifest.features, contextWindowTokens: 0 },
        },
      }),
    ).toThrow("context window");
    expect(() =>
      catalog.register({ ...fixture, manifest: { ...fixture.manifest, id: "bad\0id" } }),
    ).toThrow("NUL");
    expect(catalog.size).toBe(0);
  });

  it("applies the existing effect/recovery invariant to tools rather than a new policy", () => {
    const catalog = new ToolCatalog();
    const fixture = tool();
    expect(() =>
      catalog.register({
        ...fixture,
        manifest: {
          ...fixture.manifest,
          behavior: {
            ...fixture.manifest.behavior,
            primitiveFamily: "effect",
            effect: "external-write",
            idempotency: "unknown",
            recovery: "rerun",
          },
        },
      }),
    ).toThrow("NODE_BEHAVIOR_RECOVERY_UNSAFE");
    expect(catalog.size).toBe(0);
  });

  it("does not turn adapter registration into scheduler invocation authority", async () => {
    const host = new PluginHost();
    const fixture = tool();
    const invoke = vi.fn(fixture.invoke);
    await host.activate(
      plugin(
        (ctx) => {
          ctx.tools.register({
            ...fixture,
            invoke,
            manifest: {
              ...fixture.manifest,
              behavior: { ...fixture.manifest.behavior, requiredCapabilities: ["fs:read"] },
            },
          });
        },
        ["fs:read"],
      ),
    );
    const ir = createMockExecutionIr([
      createMockExecutionOp("call", [], {
        behavior: { requiredCapabilities: ["fs:read"] },
      }),
    ]);
    const concurrency = new SchedulerConcurrency(1);
    const run = new PlainDagRun(ir, concurrency.createRun(ir), async () => {
      await host.tools.requireAdapter(fixture.manifest.id, "1").invoke({}, context());
    });
    await expect(run.execute()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(invoke).not.toHaveBeenCalled();
    await host.dispose();
  });
});

describe("scripted offline adapters", () => {
  it("shares a finite isolated model script across generate and stream", async () => {
    const first = answer("hello");
    const second: ModelResult = { ...answer("world"), usage: { inputTokens: 2, outputTokens: 1 } };
    const responses = [first, second];
    const adapter = createScriptedModelAdapter(responses);
    responses[0] = answer("mutated");
    expect(await adapter.generate(request, context())).toEqual(first);
    const events: ModelStreamEvent[] = [];
    for await (const event of adapter.stream!(request, context())) events.push(event);
    expect(events).toEqual([
      { type: "text-delta", text: "world" },
      { type: "usage", usage: second.usage },
      { type: "completed", result: second },
    ]);
    expect(adapter.callsConsumed).toBe(2);
    await expect(adapter.generate(request, context())).rejects.toThrow("exhausted");
    expect(adapter.callsConsumed).toBe(2);
  });

  it("does not consume a pre-aborted call or emit completion after mid-stream cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("stop test");
    controller.abort(reason);
    const adapter = createScriptedModelAdapter([answer("one")]);
    await expect(adapter.generate(request, context(controller.signal))).rejects.toBe(reason);
    expect(adapter.callsConsumed).toBe(0);
    const live = new AbortController();
    const iterator = adapter.stream!(request, context(live.signal))[Symbol.asyncIterator]();
    expect(adapter.callsConsumed).toBe(0);
    expect((await iterator.next()).value).toEqual({ type: "text-delta", text: "one" });
    live.abort(reason);
    await expect(iterator.next()).rejects.toBe(reason);
    expect(adapter.callsConsumed).toBe(1);
  });

  it("streams structured tool calls without executing a tool or mutating the final result", async () => {
    const response: ModelResult = {
      message: {
        role: "assistant",
        parts: [{ kind: "tool-call", callId: "call-1", name: "mock", arguments: { input: 1 } }],
      },
      finishReason: "tool-calls",
    };
    const adapter = createScriptedModelAdapter([response]);
    const iterator = adapter.stream!(request, context())[Symbol.asyncIterator]();
    const event = (await iterator.next()).value as ModelStreamEvent;
    if (event.type !== "tool-call") throw new Error("expected tool call");
    (event.call.arguments as { input: number }).input = 99;
    expect((await iterator.next()).value).toEqual({ type: "completed", result: response });
  });

  it("orders concurrent tool reservations and rejects abort/exhaustion without hidden retries", async () => {
    const responses = [{ value: { index: 1 } }, { value: { index: 2 } }];
    const adapter = createScriptedToolAdapter(responses);
    responses[0]!.value.index = 999;
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.invoke({}, context(controller.signal))).rejects.toThrow();
    expect(adapter.callsConsumed).toBe(0);
    expect(
      await Promise.all([adapter.invoke({}, context()), adapter.invoke({}, context())]),
    ).toEqual([{ value: { index: 1 } }, { value: { index: 2 } }]);
    await expect(adapter.invoke({}, context())).rejects.toThrow("exhausted");
    expect(adapter.callsConsumed).toBe(2);
  });
});
