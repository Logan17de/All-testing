import { describe, expect, it, vi } from "vitest";

import type { AdapterInvocationContext, ModelRequest, ModelStreamEvent } from "@zet-harness/plugin-api";

import { abortable, parseJson, readModelJson } from "./model-http.js";
import { assertModelJson } from "./model-json.js";
import { createOpenAICompatibleModelAdapter } from "./openai-compatible-model.js";

function context(): AdapterInvocationContext {
  return {
    runId: "r", opIndex: 0, iteration: 0, attempt: 1, logicalEffectId: "e",
    signal: new AbortController().signal,
    retryBudget: {
      maxAttempts: 1, usedAttempts: 1, remainingAttempts: 0, repeatAuthorized: false,
      reportInternalRetries: () => 1,
    },
  };
}

const request: ModelRequest = {
  messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
};

function adapter(fetch: typeof globalThis.fetch) {
  return createOpenAICompatibleModelAdapter({
    id: "bounded", baseUrl: "https://example.test/v1", model: "pinned-model", fetch,
    features: { tools: true },
  });
}

describe("model data and completion hardening", () => {
  it.each([undefined, NaN, Infinity, -Infinity, 1n, new Map(), new Date()])(
    "rejects non-JSON data %#",
    (value) => {
      expect(() => assertModelJson(value)).toThrow(TypeError);
    },
  );

  it("bounds depth and size, rejects cycles, and permits repeated data references", () => {
    let nested: unknown = null;
    for (let index = 0; index < 70; index += 1) nested = { nested };
    expect(() => assertModelJson(nested)).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertModelJson(cyclic)).toThrow(TypeError);
    expect(() => assertModelJson({ text: "abcdef" }, 5)).toThrow(TypeError);
    const shared = { valid: true };
    expect(() => assertModelJson([shared, shared])).not.toThrow();
  });

  it("rejects sparse arrays and accessor properties without invoking getters", () => {
    const getter = vi.fn(() => "not data");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    expect(() => assertModelJson(accessor)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
    expect(() => assertModelJson(new Array(2))).toThrow(TypeError);
    const disguised = new Array(2) as unknown[];
    disguised[0] = null;
    Object.defineProperty(disguised, "999999999999", { value: null, enumerable: true });
    expect(() => assertModelJson(disguised)).toThrow(TypeError);
  });

  it("rejects overflowing provider numbers instead of persisting them as JSON null", () => {
    expect(() => parseJson('{"result":1e999}')).toThrow("MODEL_RESPONSE_INVALID");
    expect(parseJson('{"result":1.5}')).toEqual({ result: 1.5 });
  });

  it("rejects request getters before network access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const getter = vi.fn(() => request.messages);
    const malformed = {} as ModelRequest;
    Object.defineProperty(malformed, "messages", { enumerable: true, get: getter });
    await expect(adapter(fetch).generate(malformed, context())).rejects.toMatchObject({
      code: "MODEL_REQUEST_UNSUPPORTED",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves even a non-Error caller abort reason without leaking listeners", async () => {
    const controller = new AbortController();
    const pending = abortable(new Promise<void>(() => undefined), controller.signal);
    controller.abort(17);
    await expect(pending).rejects.toBe(17);
  });

  it("cancels response bodies rejected for an unsupported content type", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "content-type": "text/plain" },
    });
    await expect(
      readModelJson(response, 1024, new AbortController().signal),
    ).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["length", "content_filter", "stop"])(
    "does not expose a tool call from a response that finished as %s",
    async (reason) => {
      const delta = {
        choices: [{
          index: 0,
          delta: { tool_calls: [{
            index: 0, id: "call-1", type: "function",
            function: { name: "lookup", arguments: "{}" },
          }] },
          finish_reason: reason,
        }],
      };
      const wire = `data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`;
      const model = adapter(() => Promise.resolve(new Response(wire, {
        headers: { "content-type": "text/event-stream" },
      })));
      const events: ModelStreamEvent[] = [];
      await expect((async () => {
        for await (const event of model.stream!({
          ...request, tools: [{ name: "lookup", inputSchema: { type: "object" } }],
        }, context())) events.push(event);
      })()).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
      expect(events).toEqual([]);
    },
  );
});
