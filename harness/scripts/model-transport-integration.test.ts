import { createServer } from "node:http";
import { once } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { CapabilityPermissionPolicy, PluginHost } from "@zet-harness/core";
import { createOpenAICompatiblePlugin } from "@zet-harness/models";
import type { AdapterInvocationContext, ModelRequest } from "@zet-harness/plugin-api";
import { PlainDagRun, SchedulerConcurrency } from "@zet-harness/scheduler";
import { createMockExecutionIr, createMockExecutionOp } from "@zet-harness/scheduler/testing";

const request: ModelRequest = {
  messages: [{ role: "user", parts: [{ kind: "text", text: "Hello" }] }],
};
const completion = {
  choices: [
    { index: 0, message: { role: "assistant", content: "Hello back" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

function context(): AdapterInvocationContext {
  return {
    runId: "run-1",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "effect-1",
    signal: new AbortController().signal,
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => {
        throw new Error("No internal retries allowed.");
      },
    },
  };
}

describe("first-party model transport integration", () => {
  it("registers through the real host, preserves provenance, and unloads without network use", async () => {
    const host = new PluginHost();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const plugin = createOpenAICompatiblePlugin({
      id: "transport",
      baseUrl: "https://example.test/v1",
      model: "configured-model",
      fetch,
    });
    try {
      await host.activate(plugin);
      const resolution = host.models.getResolution("transport", "1");
      expect(resolution?.plugin).toEqual({ id: plugin.manifest.id, version: "1" });
      expect(resolution?.manifest.requiredCapabilities).toEqual(["network:https"]);
      expect(Object.isFrozen(resolution?.manifest)).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      await host.unload(plugin.manifest.id);
      expect(host.models.has("transport", "1")).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  it("blocks network use before invocation and shares the existing outer retry budget", async () => {
    const host = new PluginHost();
    const calls: number[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(
      calls.length === 1
        ? new Response("unexposed-details", { status: 503 })
        : Response.json(completion),
    ));
    const plugin = createOpenAICompatiblePlugin({
      id: "retry-transport",
      baseUrl: "https://example.test/v1",
      model: "configured-model",
      fetch,
    });
    try {
      await host.activate(plugin);
      const adapter = host.models.requireAdapter("retry-transport", "1");
      const plan = createMockExecutionIr([
        createMockExecutionOp("model-node", [], {
          behavior: {
            primitiveFamily: "effect",
            determinism: "nondeterministic",
            effect: "external-read",
            idempotency: "idempotent",
            recovery: "rerun",
            requiredCapabilities: adapter.manifest.requiredCapabilities,
            retry: { maxAttempts: 2, backoffMs: 0 },
          },
        }),
      ]);
      const scheduler = new SchedulerConcurrency(1);
      const execute = async (
        invocation: Parameters<ConstructorParameters<typeof PlainDagRun>[2]>[0],
      ) => {
        calls.push(invocation.attempt);
        await adapter.generate(request, {
          ...context(),
          opIndex: invocation.op,
          attempt: invocation.attempt,
          signal: invocation.signal,
          retryBudget: invocation.retryBudget,
        });
      };
      await expect(
        new PlainDagRun(plan, scheduler.createRun(plan), execute).execute(),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(fetch).not.toHaveBeenCalled();
      const run = new PlainDagRun(plan, scheduler.createRun(plan), execute, {
        capabilityAuthority: new CapabilityPermissionPolicy({ granted: ["network:https"] }),
      });
      await run.execute();
      expect(calls).toEqual([1, 2]);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(run.snapshot().attemptBudgetUsed).toEqual([2]);
    } finally {
      await host.dispose();
    }
  });

  it("uses actual loopback HTTP through a host-registered OpenAI-compatible adapter", async () => {
    const received: string[] = [];
    const server = createServer((incoming, response) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        body += chunk;
      });
      incoming.on("end", () => {
        received.push(incoming.url ?? "", body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(completion));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const host = new PluginHost();
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Expected test listener.");
      await host.activate(
        createOpenAICompatiblePlugin({
          id: "local",
          model: "local-model",
          baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
          tokenLimitField: "max_tokens",
        }),
      );
      const adapter = host.models.requireAdapter("local", "1");
      await expect(adapter.generate(request, context())).resolves.toMatchObject({
        finishReason: "stop",
      });
      expect(received[0]).toBe("/v1/chat/completions");
      expect(JSON.parse(received[1]!)).toMatchObject({ model: "local-model", stream: false, n: 1 });
    } finally {
      await host.dispose();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });
});
