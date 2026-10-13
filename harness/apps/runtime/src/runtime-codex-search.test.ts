import { describe, expect, it, vi } from "vitest";
import { CodexSearchBridge } from "./runtime-codex-search.js";
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const completion = (extra: unknown[] = []) => ({
  type: "response.completed",
  response: {
    status: "completed",
    output: [
      { type: "web_search_call", status: "completed" },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "answer",
            annotations: [
              { type: "url_citation", url: "https://example.com/source", title: "Source" },
            ],
          },
        ],
      },
      ...extra,
    ],
  },
});
function setup(events: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      new Response(events.map(event).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      }),
    ),
  );
  const accessToken = vi.fn(() => Promise.resolve("volatile-test-token"));
  return {
    fetch,
    accessToken,
    bridge: new CodexSearchBridge({ model: "gpt-6.1-sol", accessToken, fetch }),
  };
}
describe("Codex web-search-only direct inference bridge (mock provider)", () => {
  it("exposes only web search and uses supported public plan endpoint and explicit history", async () => {
    const f = setup([{ type: "response.output_text.delta", delta: "answer" }, completion()]);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.bridge.search("query")).toEqual({
      text: "answer",
      citations: [{ url: "https://example.com/source", title: "Source" }],
    });
    const [url, options] = f.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(options!.body as string) as Record<string, unknown>;
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    for (const key of [
      "previous_response_id",
      "max_output_tokens",
      "temperature",
      "background",
      "conversation",
    ])
      expect(body).not.toHaveProperty(key);
  });
  it.each(["function_call", "custom_tool_call", "local_shell_call", "computer_call", "mcp_call"])(
    "refuses %s without executing or falling back",
    async (type) => {
      const f = setup([
        { type: "response.output_item.added", item: { type, arguments: "untrusted" } },
        completion(),
      ]);
      await expect(f.bridge.search("query")).rejects.toThrow("CODEX_SEARCH_TOOL_REFUSED");
      expect(f.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses local calls hidden in completed output", async () => {
    const f = setup([completion([{ type: "function_call" }])]);
    await expect(f.bridge.search("query")).rejects.toThrow("CODEX_SEARCH_TOOL_REFUSED");
  });
  it("requires completed inference and actual web-search evidence", async () => {
    const f = setup([{ type: "response.output_text.delta", delta: "incomplete" }]);
    await expect(f.bridge.search("query")).rejects.toThrow("CODEX_SEARCH_STREAM_TRUNCATED");
    const g = setup([
      { type: "response.completed", response: { status: "completed", output: [] } },
    ]);
    await expect(g.bridge.search("query")).rejects.toThrow("CODEX_SEARCH_NOT_PERFORMED");
  });
  it("bounds input and output", async () => {
    const f = setup([{ type: "response.output_text.delta", delta: "x".repeat(65537) }]);
    await expect(f.bridge.search("x".repeat(4097))).rejects.toThrow("CODEX_SEARCH_QUERY_INVALID");
    expect(f.fetch).not.toHaveBeenCalled();
    await expect(f.bridge.search("query")).rejects.toThrow("CODEX_SEARCH_RESPONSE_LIMIT");
  });
  it("cancels an in-progress provider stream", async () => {
    const controller = new AbortController();
    let began: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      began = resolve;
    });
    const transport = vi.fn<typeof globalThis.fetch>(() => {
      began?.();
      return Promise.resolve(
        new Response(new ReadableStream<Uint8Array>(), {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    });
    const bridge = new CodexSearchBridge({
      model: "gpt-6.1-sol",
      accessToken: () => Promise.resolve("token"),
      fetch: transport,
    });
    const pending = bridge.search("query", controller.signal);
    await ready;
    controller.abort();
    await expect(pending).rejects.toThrow("CODEX_SEARCH_CANCELLED");
  });
  it("reports denied provider access without fallback or private body", async () => {
    const f = setup([]);
    f.fetch.mockResolvedValueOnce(new Response("private-provider-body", { status: 403 }));
    await expect(f.bridge.search("query")).rejects.toThrow("CODEX_SEARCH_PROVIDER_ERROR");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});

it("search cancellation does not wait for a shared token refresh", async () => {
  const abort = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>();
  const bridge = new CodexSearchBridge({
    model: "gpt-test",
    accessToken: () => new Promise(() => undefined),
    fetch,
  });
  const pending = bridge.search("query", abort.signal);
  abort.abort();
  await expect(pending).rejects.toThrow("CODEX_SEARCH_CANCELLED");
  expect(fetch).not.toHaveBeenCalled();
});
