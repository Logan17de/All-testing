import { describe, expect, it, vi } from "vitest";
import type {
  AdapterInvocationContext,
  ModelAdapter,
  ModelRequest,
  ModelStreamEvent,
} from "@zet-harness/plugin-api";
import { SecretValue } from "@zet-harness/plugin-api/secret-contract";

import {
  createOpenAICompatibleModelAdapter,
  createOpenAICompatiblePlugin,
} from "./openai-compatible-model.js";
import { ModelTransportError } from "./model-http.js";

type Options = Parameters<typeof createOpenAICompatibleModelAdapter>[0];

function context(signal = new AbortController().signal) {
  return {
    runId: "run-1",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "effect-1",
    signal,
    retryBudget: {
      maxAttempts: 3,
      repeatAuthorized: true,
      usedAttempts: 1,
      remainingAttempts: 2,
      reportInternalRetries: vi.fn(() => 2),
    },
  } satisfies AdapterInvocationContext;
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") throw new Error("Expected a serialized JSON request.");
  return init.body;
}

const request: ModelRequest = {
  messages: [{ role: "user", parts: [{ kind: "text", text: "Hello" }] }],
};
const completion = {
  id: "response-1",
  choices: [
    { index: 0, message: { role: "assistant", content: "Hello back" }, finish_reason: "stop" },
  ],
  usage: {
    prompt_tokens: 5,
    completion_tokens: 2,
    total_tokens: 7,
    prompt_tokens_details: { cached_tokens: 3 },
  },
};

function make(fetch: typeof globalThis.fetch, extra: Partial<Options> = {}) {
  return createOpenAICompatibleModelAdapter({
    id: "test",
    model: "fixed-model",
    baseUrl: "https://example.test/v1",
    fetch,
    ...extra,
  });
}

function jsonFetch(value: unknown = completion, init?: ResponseInit) {
  return vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json(value, init)));
}

function sse(value: string, width = 7): Response {
  const bytes = new TextEncoder().encode(value);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += width) {
          controller.enqueue(bytes.slice(index, index + width));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;

async function collect(adapter: ModelAdapter, value = request): Promise<ModelStreamEvent[]> {
  if (adapter.stream === undefined) throw new Error("Expected streaming fixture");
  const events: ModelStreamEvent[] = [];
  for await (const item of adapter.stream(value, context())) events.push(item);
  return events;
}

describe("OpenAI-compatible model transport", () => {
  it("encodes one fixed request, resolves scoped credentials, and captures reported usage", async () => {
    const fetch = jsonFetch(completion, { headers: { "x-request-id": "request-1" } });
    const get = vi.fn(() => Promise.resolve(new SecretValue("private-api-key")));
    const ctx = {
      ...context(),
      secrets: { ports: ["apiKey"], has: () => true, get, getAll: () => Promise.resolve([]) },
    };
    const result = await make(fetch, { credentialPort: "apiKey" }).generate(
      { ...request, maxOutputTokens: 42 },
      ctx,
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith("apiKey");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: { authorization: "Bearer private-api-key" },
    });
    expect(JSON.parse(requestBody(init))).toEqual({
      model: "fixed-model",
      n: 1,
      stream: false,
      store: false,
      max_completion_tokens: 42,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result).toMatchObject({
      finishReason: "stop",
      providerRequestId: "request-1",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, cachedInputTokens: 3 },
    });
    expect(result.usage?.cost).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("private-api-key");
    expect(ctx.retryBudget.reportInternalRetries).not.toHaveBeenCalled();
  });

  it.each([
    "http://remote.example/v1",
    "https://user:pass@example.test/v1",
    "https://example.test/v1?key=secret",
    "file:///tmp/model",
    "https://example.test/v1#key",
  ])("rejects unsafe base URL %s", (baseUrl) => {
    expect(() => make(vi.fn(), { baseUrl })).toThrow("MODEL_CONFIGURATION_INVALID");
  });

  it.each(["model", "messages", "stream", "n", "base_url", "headers", "capabilityAuthority"])(
    "rejects an option attempting to override %s",
    async (key) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        make(fetch).generate({ ...request, options: { openai: { [key]: "forged" } } }, context()),
      ).rejects.toMatchObject({ code: "MODEL_REQUEST_UNSUPPORTED" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("supports explicit legacy token limits without unchecked provider options", async () => {
    const fetch = jsonFetch();
    await make(fetch, { tokenLimitField: "max_tokens" }).generate(
      { ...request, maxOutputTokens: 5, options: { openai: { temperature: 0, reasoning_effort: "low" } } },
      context(),
    );
    expect(JSON.parse(requestBody(fetch.mock.calls[0]?.[1]))).toMatchObject({
      max_tokens: 5, temperature: 0, reasoning_effort: "low",
    });
    await expect(
      make(fetch).generate({ ...request, model: "unverified-model" }, context()),
    ).rejects.toMatchObject({ code: "MODEL_REQUEST_UNSUPPORTED" });
  });

  it("pins factory options and snapshots input before asynchronous credential resolution", async () => {
    const fetch = jsonFetch();
    const options = {
      id: "test", model: "original", baseUrl: "https://example.test/v1", fetch, credentialPort: "apiKey",
    };
    const adapter = createOpenAICompatibleModelAdapter(options);
    options.baseUrl = "https://other.test/v1";
    options.fetch = vi.fn();
    const mutable = {
      messages: [{ role: "user" as const, parts: [{ kind: "text" as const, text: "original" }] }],
    };
    const pending = adapter.generate(mutable, {
      ...context(),
      secrets: {
        ports: ["apiKey"],
        has: () => true,
        get: () => Promise.resolve(new SecretValue("key")),
        getAll: () => Promise.resolve([]),
      },
    });
    mutable.messages[0]!.parts[0]!.text = "changed";
    await pending;
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("https://example.test/v1/chat/completions");
    expect(requestBody(fetch.mock.calls[0]?.[1])).toContain("original");
    expect(requestBody(fetch.mock.calls[0]?.[1])).not.toContain("changed");
  });

  it("maps schema output, assistant calls and tool results without invoking tools", async () => {
    const fetch = jsonFetch({
      choices: [{
        message: {
          role: "assistant", content: null,
          tool_calls: [{
            type: "function", id: "call-2",
            function: { name: "lookup", arguments: '{"query":"x"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    });
    const adapter = make(fetch, { features: { tools: true, structuredOutput: true } });
    const value: ModelRequest = {
      messages: [
        ...request.messages,
        { role: "assistant", parts: [{ kind: "tool-call", callId: "call-1", name: "lookup", arguments: { query: "old" } }] },
        { role: "tool", parts: [{ kind: "tool-result", callId: "call-1", value: { found: true } }] },
      ],
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      outputSchema: { type: "object", additionalProperties: false },
    };
    const result = await adapter.generate(value, context());
    expect(result.message.parts).toEqual([
      { kind: "tool-call", callId: "call-2", name: "lookup", arguments: { query: "x" } },
    ]);
    expect(result.finishReason).toBe("tool-calls");
    const body = JSON.parse(requestBody(fetch.mock.calls[0]?.[1])) as Record<string, unknown>;
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "harness_output", strict: true, schema: value.outputSchema },
    });
    expect(body.messages).toContainEqual({
      role: "tool", tool_call_id: "call-1", content: '{"found":true}',
    });
  });

  it("resolves image bytes through the host instead of forwarding artifact references", async () => {
    const fetch = jsonFetch();
    const resolveImage = vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3])));
    const adapter = make(fetch, { features: { vision: true }, resolveImage });
    await adapter.generate({
      messages: [{ role: "user", parts: [{ kind: "image", artifactRef: "blob:opaque-id", mediaType: "image/png" }] }],
    }, context());
    const body = requestBody(fetch.mock.calls[0]?.[1]);
    expect(body).toContain("data:image/png;base64,AQID");
    expect(body).not.toContain("blob:opaque-id");
    expect(resolveImage).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 429, 500])("normalizes HTTP %s without exposing its body or retrying", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response("private-provider-details", { status })),
    );
    const ctx = context();
    const error: unknown = await make(fetch).generate(request, ctx).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "MODEL_HTTP_ERROR", status, retryable: status === 429 || status >= 500,
    });
    expect(JSON.stringify(error)).not.toContain("private-provider-details");
    expect(fetch).toHaveBeenCalledOnce();
    expect(ctx.retryBudget.reportInternalRetries).not.toHaveBeenCalled();
  });

  it("preserves pre-abort identity and times out an uncooperative transport", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel-test");
    controller.abort(reason);
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(make(fetch).generate(request, context(controller.signal))).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      make(() => new Promise<Response>(() => undefined), { timeoutMs: 5 }).generate(request, context()),
    ).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
  });

  it("rejects oversized replies, invalid JSON, unoffered tool names and invalid token counts", async () => {
    await expect(
      make(jsonFetch(), { maxResponseBytes: 10 }).generate(request, context()),
    ).rejects.toMatchObject({ code: "MODEL_RESPONSE_LIMIT" });
    const unknownTool = {
      choices: [{
        message: { role: "assistant", tool_calls: [{ type: "function", id: "x", function: { name: "unoffered", arguments: "{}" } }] },
        finish_reason: "tool_calls",
      }],
    };
    for (const value of ["{", JSON.stringify({ ...completion, usage: { total_tokens: -1 } }), JSON.stringify(unknownTool)]) {
      const fetch = () => Promise.resolve(new Response(value, { headers: { "content-type": "application/json" } }));
      await expect(make(fetch).generate(request, context())).rejects.toMatchObject({
        code: "MODEL_RESPONSE_INVALID",
      });
    }
  });

  it("does not expose network/credential exceptions or trust forged error prototypes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error("private-network-details")));
    const error: unknown = await make(fetch).generate(request, context()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "MODEL_NETWORK_ERROR" });
    expect(JSON.stringify(error)).not.toContain("private-network-details");
    await expect(
      make(fetch, { credentialPort: "apiKey" }).generate(request, context()),
    ).rejects.toMatchObject({ code: "MODEL_CREDENTIAL_UNAVAILABLE" });
    const forged = Object.create(ModelTransportError.prototype) as ModelTransportError;
    Object.defineProperty(forged, "message", { value: "private-forged-details" });
    const imageAdapter = make(fetch, {
      features: { vision: true }, resolveImage: () => Promise.reject(forged),
    });
    const imageRequest: ModelRequest = {
      messages: [{ role: "user", parts: [{ kind: "image", artifactRef: "x", mediaType: "image/png" }] }],
    };
    const imageError: unknown = await imageAdapter.generate(imageRequest, context()).catch((value: unknown) => value);
    expect(imageError).toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
    expect(String(imageError)).not.toContain("private-forged-details");
  });

  it.each([1, 2, 7, 4096])("assembles UTF-8/CRLF fragments at chunk width %s", async (width) => {
    const wire = ": comment\r\n\r\n" +
      event({ id: "stream-1", choices: [{ index: 0, delta: { role: "assistant", content: "こんにちは" }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      event({ choices: [], usage: completion.usage }) + "data: [DONE]\r\n\r\n";
    const events = await collect(make(() => Promise.resolve(sse(wire, width))));
    expect(events.map((item) => item.type)).toEqual(["text-delta", "usage", "completed"]);
    expect(events[2]).toMatchObject({
      result: { message: { parts: [{ kind: "text", text: "こんにちは" }] }, usage: { totalTokens: 7 } },
    });
  });

  it("collects parallel tool arguments by index and emits only complete calls", async () => {
    const wire = event({
      choices: [{ index: 0, delta: { tool_calls: [
        { index: 1, id: "b", type: "function", function: { name: "lookup", arguments: '{"q":' } },
        { index: 0, id: "a", function: { name: "lookup", arguments: "{}" } },
      ] }, finish_reason: null }],
    }) + event({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"日本"}' } }] }, finish_reason: "tool_calls" }],
    }) + "data: [DONE]\n\n";
    const events = await collect(
      make(() => Promise.resolve(sse(wire)), { features: { tools: true } }),
      { ...request, tools: [{ name: "lookup", inputSchema: { type: "object" } }] },
    );
    expect(events.map((item) => item.type)).toEqual(["tool-call", "tool-call", "completed"]);
    expect(events[0]).toMatchObject({ call: { callId: "a", arguments: {} } });
    expect(events[1]).toMatchObject({ call: { callId: "b", arguments: { q: "日本" } } });
  });

  it("does not complete or retry a truncated stream", async () => {
    const wire = event({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "stop" }] });
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(sse(wire)));
    const events: ModelStreamEvent[] = [];
    const adapter = make(fetch);
    await expect((async () => {
      for await (const item of adapter.stream!(request, context())) events.push(item);
    })()).rejects.toMatchObject({ code: "MODEL_STREAM_TRUNCATED" });
    expect(events.map((item) => item.type)).toEqual(["text-delta"]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels the response when its consumer stops early", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(event({
          choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
        })));
      },
      cancel,
    }), { headers: { "content-type": "text/event-stream" } });
    for await (const item of make(() => Promise.resolve(response)).stream!(request, context())) {
      expect(item.type).toBe("text-delta");
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("declares demand without implying tool/vision support or authority", () => {
    const plugin = createOpenAICompatiblePlugin({
      id: "local", baseUrl: "http://localhost:11434/v1", model: "local-model", features: { streaming: false },
    });
    expect(plugin.manifest.capabilities).toEqual([{ id: "network:http" }]);
    const adapter = make(vi.fn(), { features: { streaming: false } });
    expect(adapter.stream).toBeUndefined();
    expect(adapter.manifest.features).toEqual({
      streaming: false, tools: false, vision: false, structuredOutput: false,
    });
  });
});
