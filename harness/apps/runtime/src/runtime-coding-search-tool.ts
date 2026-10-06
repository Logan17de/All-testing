import type {
  ToolAdapter,
  JsonObject,
  AdapterInvocationContext,
  ToolResult,
} from "@zet-harness/plugin-api";
import type { CodexSearchResult } from "./runtime-codex-search.js";

/** A search-only subagent boundary. It has no executor, local tools or fallback provider. */
export function createRuntimeCodingSearchTool(options: {
  search(query: string, signal: AbortSignal): Promise<CodexSearchResult>;
}): ToolAdapter {
  return {
    manifest: {
      id: "harness.research.search",
      version: "1",
      title: "Codex web research",
      description:
        "Ask the configured Codex search model for bounded web findings and source URLs. Sends only the query; the host does not attach files or session history. Has no filesystem, shell or local tool authority.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string", maxLength: 4096 } },
      },
      outputSchema: { type: "object" },
      behavior: {
        primitiveFamily: "effect",
        determinism: "nondeterministic",
        effect: "external-read",
        idempotency: "idempotent",
        recovery: "manual",
        executionMode: "in-process",
        requiredCapabilities: ["network:codex-search"],
      },
    },
    async invoke(input: JsonObject, context: AdapterInvocationContext): Promise<ToolResult> {
      context.signal.throwIfAborted();
      if (
        Object.keys(input).length !== 1 ||
        typeof input.query !== "string" ||
        !input.query.trim() ||
        Buffer.byteLength(input.query) > 4096
      )
        throw new Error("Invalid search query.");
      const result = await options.search(input.query, context.signal);
      context.signal.throwIfAborted();
      if (
        typeof result.text !== "string" ||
        Buffer.byteLength(result.text) > 65536 ||
        !Array.isArray(result.citations) ||
        result.citations.length > 100
      )
        throw new Error("Search output exceeds supported bounds.");
      const citations = result.citations.map((citation: { url: string; title: string }) => {
        const url = new URL(citation.url);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          citation.url.length > 2048 ||
          citation.title.length > 1024
        )
          throw new Error("Invalid search citation.");
        return { url: url.href, title: citation.title };
      });
      return { value: { findings: result.text, sources: citations } };
    },
  };
}
