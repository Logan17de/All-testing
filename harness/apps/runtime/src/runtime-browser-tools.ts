import type { ToolAdapter, JsonObject, JsonValue } from "@zet-harness/plugin-api";
import type { RuntimeBrowserService } from "./runtime-browser-service.js";

/** Capture the armed generation once: a new task never inherits an old run's authority. */
export function createRuntimeBrowserTools(
  service: RuntimeBrowserService,
  expectedGeneration?: number,
): readonly ToolAdapter[] {
  const state = service.snapshot();
  if (!state.armed || (expectedGeneration !== undefined && expectedGeneration !== state.generation))
    return [];
  const generation = state.generation;
  return (["navigate", "read", "click", "type", "key", "capture"] as const).map(
    (kind): ToolAdapter => {
      const fields =
        kind === "navigate"
          ? ["url"]
          : kind === "type"
            ? ["selector", "text"]
            : ["read", "click"].includes(kind)
              ? ["selector"]
              : kind === "key"
                ? ["key"]
                : [];
      return {
        manifest: {
          id: `harness.browser.${kind}`,
          version: "1",
          title: `Scoped browser ${kind}`,
          description:
            "Use only the explicitly armed browser task. Click, text and keys require exact human consent. Captures remain local metadata; sharing unavailable.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: fields,
            properties: Object.fromEntries(fields.map((field) => [field, { type: "string" }])),
          },
          outputSchema: { type: "object" },
          behavior: {
            primitiveFamily: "effect",
            determinism: "nondeterministic",
            effect: ["click", "type", "key"].includes(kind) ? "external-write" : "external-read",
            idempotency: "unknown",
            recovery: "manual",
            executionMode: "in-process",
            requiredCapabilities: ["browser:task"],
          },
        },
        async invoke(input: JsonObject, context) {
          context.signal.throwIfAborted();
          if (
            Object.keys(input).some((key) => !fields.includes(key)) ||
            fields.some((field) => typeof input[field] !== "string")
          )
            throw new Error("Invalid browser tool input");
          const abort = () => {
            void service.close().catch(() => undefined);
          };
          context.signal.addEventListener("abort", abort, { once: true });
          try {
            const value = await service.action("execute", {
              generation,
              input: { ...input, kind },
            });
            context.signal.throwIfAborted();
            return { value: { result: value as JsonValue } };
          } finally {
            context.signal.removeEventListener("abort", abort);
          }
        },
      };
    },
  );
}
