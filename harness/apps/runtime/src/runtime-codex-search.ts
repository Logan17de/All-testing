import { abortable } from "@zet-harness/models";
/** Codex model search bridge: public Responses inference only; no local Codex process or tools. */
export class CodexSearchError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CodexSearchError";
  }
}
export interface CodexSearchResult {
  text: string;
  citations: readonly { url: string; title: string }[];
}
const fail = (): never => {
  throw new CodexSearchError("CODEX_SEARCH_RESPONSE_INVALID");
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
const ALLOWED_ITEMS = new Set(["message", "reasoning", "web_search_call"]);
function assertItem(value: unknown): void {
  const item = record(value);
  if (typeof item.type !== "string" || !ALLOWED_ITEMS.has(item.type))
    throw new CodexSearchError("CODEX_SEARCH_TOOL_REFUSED");
  if (item.tool_calls !== undefined || item.function_call !== undefined)
    throw new CodexSearchError("CODEX_SEARCH_TOOL_REFUSED");
  if (item.type === "message") {
    if (item.role !== "assistant" || !Array.isArray(item.content)) return fail();
    for (const part of item.content)
      if (record(part).type !== "output_text")
        throw new CodexSearchError("CODEX_SEARCH_TOOL_REFUSED");
  }
}
export class CodexSearchBridge {
  readonly #credential: () => Promise<string>;
  readonly #model: string;
  readonly #fetch: typeof globalThis.fetch;
  constructor(options: {
    accessToken: () => Promise<string>;
    model: string;
    fetch?: typeof globalThis.fetch;
  }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(options.model))
      throw new CodexSearchError("CODEX_SEARCH_MODEL_CONFIGURATION_REQUIRED");
    this.#credential = options.accessToken;
    this.#model = options.model;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }
  async search(query: string, signal?: AbortSignal): Promise<CodexSearchResult> {
    if (typeof query !== "string" || query.trim().length === 0 || Buffer.byteLength(query) > 4096)
      throw new CodexSearchError("CODEX_SEARCH_QUERY_INVALID");
    const controllerSignal = AbortSignal.any([
      AbortSignal.timeout(60_000),
      ...(signal ? [signal] : []),
    ]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = () => {
      void reader?.cancel().catch(() => undefined);
    };
    controllerSignal.addEventListener("abort", cancelReader, { once: true });
    try {
      controllerSignal.throwIfAborted();
      const accessToken = await abortable(this.#credential(), controllerSignal);
      controllerSignal.throwIfAborted();
      if (!accessToken || /\s/u.test(accessToken))
        throw new CodexSearchError("CODEX_SEARCH_LOGIN_REQUIRED");
      const response = await this.#fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        redirect: "error",
        signal: controllerSignal,
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.#model,
          instructions:
            "Search the web for the user's query. Return a concise factual answer with source citations. You have only web search. Never request local tools, filesystem, shell, functions, or computer actions.",
          input: [{ role: "user", content: query }],
          tools: [{ type: "web_search" }],
          store: false,
          stream: true,
        }),
      });
      if (!response.ok) throw new CodexSearchError("CODEX_SEARCH_PROVIDER_ERROR");
      if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream"))
        return fail();
      reader = response.body.getReader();
      let bytes = 0;
      let pending = "";
      let completed = false;
      let text = "";
      const citations: { url: string; title: string }[] = [];
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const consume = (block: string) => {
        const data = block
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") return;
        const event = record(JSON.parse(data) as unknown);
        if (completed) return fail();
        if (typeof event.type !== "string") return fail();
        if (
          event.type.includes("function_call") ||
          event.type.includes("custom_tool") ||
          event.type.includes("tool_call") ||
          event.type.includes("arguments")
        )
          throw new CodexSearchError("CODEX_SEARCH_TOOL_REFUSED");
        if (
          event.type === "response.output_item.added" ||
          event.type === "response.output_item.done"
        )
          assertItem(event.item);
        if (event.type === "response.output_text.delta") {
          if (typeof event.delta !== "string") return fail();
          text += event.delta;
          if (Buffer.byteLength(text) > 65536)
            throw new CodexSearchError("CODEX_SEARCH_RESPONSE_LIMIT");
        }
        if (
          event.type === "error" ||
          event.type === "response.failed" ||
          event.type === "response.incomplete"
        )
          throw new CodexSearchError("CODEX_SEARCH_PROVIDER_ERROR");
        if (event.type === "response.completed") {
          const result = record(event.response);
          if (result.status !== "completed" || !Array.isArray(result.output)) return fail();
          if (
            !result.output.some(
              (value) =>
                record(value).type === "web_search_call" && record(value).status === "completed",
            )
          )
            throw new CodexSearchError("CODEX_SEARCH_NOT_PERFORMED");
          for (const output of result.output) {
            assertItem(output);
            const item = record(output);
            if (item.type !== "message") continue;
            for (const value of item.content as unknown[]) {
              const part = record(value);
              if (part.annotations === undefined) continue;
              if (!Array.isArray(part.annotations)) return fail();
              for (const value of part.annotations) {
                const annotation = record(value);
                if (annotation.type !== "url_citation") continue;
                if (typeof annotation.url !== "string" || typeof annotation.title !== "string")
                  return fail();
                const url = new URL(annotation.url);
                if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
                  return fail();
                if (citations.length < 50)
                  citations.push({ url: url.href, title: annotation.title.slice(0, 500) });
              }
            }
          }
          completed = true;
        }
      };
      while (true) {
        controllerSignal.throwIfAborted();
        const next = await abortable(reader.read(), controllerSignal);
        controllerSignal.throwIfAborted();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 2_097_152) throw new CodexSearchError("CODEX_SEARCH_RESPONSE_LIMIT");
        pending += decoder.decode(next.value, { stream: true });
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/u.exec(pending)) !== null) {
          consume(pending.slice(0, match.index));
          pending = pending.slice(match.index + match[0].length);
        }
      }
      pending += decoder.decode();
      if (pending.trim()) consume(pending);
      if (!completed) throw new CodexSearchError("CODEX_SEARCH_STREAM_TRUNCATED");
      return { text, citations };
    } catch (error) {
      if (error instanceof CodexSearchError) throw error;
      if (controllerSignal.aborted)
        throw new CodexSearchError(
          signal?.aborted ? "CODEX_SEARCH_CANCELLED" : "CODEX_SEARCH_TIMEOUT",
        );
      throw new CodexSearchError("CODEX_SEARCH_UNAVAILABLE");
    } finally {
      controllerSignal.removeEventListener("abort", cancelReader);
      if (reader) {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }
}
