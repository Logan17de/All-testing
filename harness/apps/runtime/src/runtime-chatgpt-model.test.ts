import { describe, expect, it, vi } from "vitest";
import type { AdapterInvocationContext, ModelRequest } from "@zet-harness/plugin-api";
import { createChatGPTPlanModelAdapter, listChatGPTPlanModels } from "./runtime-chatgpt-model.js";
const context = (signal = new AbortController().signal): AdapterInvocationContext => ({
  runId: "run",
  opIndex: 0,
  iteration: 0,
  attempt: 1,
  logicalEffectId: "effect",
  signal,
  retryBudget: {
    maxAttempts: 1,
    repeatAuthorized: false,
    usedAttempts: 1,
    remainingAttempts: 0,
    reportInternalRetries: () => 1,
  },
});
const request: ModelRequest = {
  messages: [
    { role: "system", parts: [{ kind: "text", text: "instructions" }] },
    { role: "user", parts: [{ kind: "text", text: "query" }] },
  ],
  maxOutputTokens: 100,
};
const completed = (
  output: unknown[],
  usage: unknown = { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
) => ({
  type: "response.completed",
  response: { id: "resp-test", status: "completed", output, usage },
});
const message = {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "answer" }],
};
function setup(events: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      new Response(events.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      }),
    ),
  );
  const accessToken = vi.fn(() => Promise.resolve("volatile-secret"));
  return {
    fetch,
    accessToken,
    adapter: createChatGPTPlanModelAdapter({
      id: "chatgpt.fixture",
      model: "gpt-test",
      accessToken,
      fetch,
    }),
  };
}
describe("native ChatGPT Responses inference adapter (mock provider)", () => {
  it("streams text and completed measured results without unsupported plan parameters", async () => {
    const f = setup([
      { type: "response.output_text.delta", delta: "answer" },
      completed([message]),
    ]);
    const events = [];
    for await (const value of f.adapter.stream!(request, context())) events.push(value);
    expect(events.map((value) => value.type)).toEqual(["text-delta", "usage", "completed"]);
    const result = events.at(-1)!;
    expect(result.type === "completed" && result.result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
    });
    const body = JSON.parse(f.fetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.input).toEqual([
      { role: "developer", content: "instructions" },
      { role: "user", content: "query" },
    ]);
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(f.fetch.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses");
  });
  it("namespaces only offered tools and returns decoded calls for native execution after completion", async () => {
    const f = setup([]);
    f.fetch.mockImplementationOnce((_url, init) => {
      const body = JSON.parse(init!.body as string) as {
        tools: { type: string; name: string; tools: { name: string }[] }[];
      };
      expect(body.tools[0]!.type).toBe("namespace");
      expect(body.tools[0]!.name).toBe("harness");
      const name = body.tools[0]!.tools[0]!.name;
      return Promise.resolve(
        new Response(
          `data: ${JSON.stringify(completed([{ type: "function_call", namespace: "harness", name, call_id: "call_1", arguments: '{"path":"README.md"}' }]))}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    });
    const result = await f.adapter.generate(
      { ...request, tools: [{ name: "harness.fs.read", inputSchema: { type: "object" } }] },
      context(),
    );
    expect(result.finishReason).toBe("tool-calls");
    expect(result.message.parts).toEqual([
      {
        kind: "tool-call",
        callId: "call_1",
        name: "harness.fs.read",
        arguments: { path: "README.md" },
      },
    ]);
  });
  it.each(["local_shell_call", "mcp_call", "computer_call", "web_search_call"])(
    "rejects unsolicited hosted %s",
    async (type) => {
      const f = setup([completed([{ type }])]);
      await expect(f.adapter.generate(request, context())).rejects.toThrow(
        "MODEL_RESPONSE_INVALID",
      );
    },
  );
  it("rejects unoffered function names and wrong namespaces", async () => {
    const f = setup([
      completed([
        {
          type: "function_call",
          namespace: "harness",
          name: "unoffered",
          call_id: "call_1",
          arguments: "{}",
        },
      ]),
    ]);
    await expect(f.adapter.generate(request, context())).rejects.toThrow("MODEL_RESPONSE_INVALID");
  });
  it.each([{ output_tokens: 101 }, { input_tokens: 1 }, { output_tokens: -1 }])(
    "gates output budget without executing tools when usage invalid/exceeded %j",
    async (usage) => {
      const f = setup([completed([message], usage)]);
      await expect(f.adapter.generate(request, context())).rejects.toThrow(
        /MODEL_RESPONSE_(?:LIMIT|INVALID)/u,
      );
    },
  );
  it("requires terminal completion and never retries denied access", async () => {
    const f = setup([{ type: "response.output_text.delta", delta: "partial" }]);
    await expect(f.adapter.generate(request, context())).rejects.toThrow("MODEL_STREAM_TRUNCATED");
    f.fetch.mockResolvedValueOnce(new Response("private", { status: 403 }));
    await expect(f.adapter.generate(request, context())).rejects.toThrow("MODEL_HTTP_ERROR");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects unsupported vision/options before credential access", async () => {
    const f = setup([]);
    await expect(
      f.adapter.generate({ ...request, options: { openai: { temperature: 1 } } }, context()),
    ).rejects.toThrow("MODEL_REQUEST_UNSUPPORTED");
    expect(f.accessToken).not.toHaveBeenCalled();
  });
  it("cancels pending shared credential lookup without waiting for it", async () => {
    const f = setup([]);
    f.accessToken.mockReturnValueOnce(new Promise(() => undefined));
    const abort = new AbortController();
    const pending = f.adapter.generate(request, context(abort.signal));
    abort.abort(new Error("user-cancel"));
    await expect(pending).rejects.toThrow("user-cancel");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("lists only authenticated visible models in server order", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        Response.json({
          models: [
            { slug: "gpt-b", display_name: "B", visibility: "list" },
            { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
            { slug: "gpt-a", display_name: "A", visibility: "list" },
          ],
        }),
      ),
    );
    expect(
      await listChatGPTPlanModels({ accessToken: () => Promise.resolve("secret"), fetch }),
    ).toEqual([
      { slug: "gpt-b", displayName: "B" },
      { slug: "gpt-a", displayName: "A" },
    ]);
    expect(fetch.mock.calls[0]![0]).toBe("https://api.openai.com/v1/models");
  });
});
