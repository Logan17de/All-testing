import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AdapterInvocationContext } from "@zet-harness/plugin-api";

import {
  createOpenAICompatibleModelAdapter,
  llamaCppEndpointProfile,
  ollamaEndpointProfile,
} from "@zet-harness/models";

function invocationContext(): AdapterInvocationContext {
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
      reportInternalRetries: () => 0,
    },
  };
}

/**
 * Loopback fixture implementing the Chat Completions response contract.
 *
 * This is a protocol fixture, not an installed Ollama or llama.cpp build and
 * not a language model. It proves the configuration a profile produces is
 * accepted and parsed; it cannot prove a real local model works.
 */
let server: Server;
let baseUrl: string;
let lastBody: Record<string, unknown> = {};

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const payload = JSON.stringify({
        id: "chatcmpl-fixture",
        object: "chat.completion",
        created: 1,
        model: typeof lastBody["model"] === "string" ? lastBody["model"] : "fixture",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "pong" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(payload);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("no address");
  baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
});

afterAll(async () => {
  server.close();
  await once(server, "close");
});

describe("loopback conformance", () => {
  it("completes a request through the Ollama profile shape", async () => {
    const adapter = createOpenAICompatibleModelAdapter(
      ollamaEndpointProfile({ id: "local-ollama", model: "llama3.1:8b", baseUrl }),
    );
    const result = await adapter.generate(
      { messages: [{ role: "user", parts: [{ kind: "text", text: "ping" }] }] },
      invocationContext(),
    );
    expect(result.message.parts[0]).toEqual({ kind: "text", text: "pong" });
    expect(result.finishReason).toBe("stop");
  });

  it("sends the pinned model name the profile was configured with", async () => {
    const adapter = createOpenAICompatibleModelAdapter(
      llamaCppEndpointProfile({ id: "local-llama", model: "my-local-model", baseUrl }),
    );
    await adapter.generate(
      { messages: [{ role: "user", parts: [{ kind: "text", text: "ping" }] }] },
      invocationContext(),
    );
    expect(lastBody["model"]).toBe("my-local-model");
  });

  it("serializes the token limit under the profile's field name", async () => {
    const adapter = createOpenAICompatibleModelAdapter(
      ollamaEndpointProfile({ id: "local-ollama", model: "m", baseUrl }),
    );
    await adapter.generate(
      {
        messages: [{ role: "user", parts: [{ kind: "text", text: "ping" }] }],
        maxOutputTokens: 64,
      },
      invocationContext(),
    );
    expect(lastBody["max_tokens"]).toBe(64);
    expect(lastBody["max_completion_tokens"]).toBeUndefined();
  });

  it("reports usage the endpoint returned", async () => {
    const adapter = createOpenAICompatibleModelAdapter(
      ollamaEndpointProfile({ id: "local-ollama", model: "m", baseUrl }),
    );
    const result = await adapter.generate(
      { messages: [{ role: "user", parts: [{ kind: "text", text: "ping" }] }] },
      invocationContext(),
    );
    expect(result.usage).toMatchObject({ inputTokens: 4, outputTokens: 1, totalTokens: 5 });
  });

  it("declares no monetary cost for a local endpoint", async () => {
    const adapter = createOpenAICompatibleModelAdapter(
      llamaCppEndpointProfile({ id: "local-llama", model: "m", baseUrl }),
    );
    const result = await adapter.generate(
      { messages: [{ role: "user", parts: [{ kind: "text", text: "ping" }] }] },
      invocationContext(),
    );
    // A local model has no price, and none must be invented.
    expect(result.usage?.cost).toBeUndefined();
  });
});
