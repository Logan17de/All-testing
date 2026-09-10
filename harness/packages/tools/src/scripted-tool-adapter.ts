import type {
  AdapterInvocationContext,
  JsonObject,
  ToolAdapter,
  ToolResult,
} from "@zet-harness/plugin-api";

export interface ScriptedToolAdapter extends ToolAdapter {
  readonly callsConsumed: number;
}

/** Finite, isolated offline tool responses. This never performs a native side effect. */
export function createScriptedToolAdapter(
  responses: readonly ToolResult[],
  options: { readonly id?: string; readonly version?: string } = {},
): ScriptedToolAdapter {
  const script = structuredClone(responses);
  let cursor = 0;
  return Object.freeze({
    manifest: Object.freeze({
      id: options.id ?? "harness.mock-tool",
      version: options.version ?? "1",
      title: "Scripted offline tool",
      inputSchema: true,
      outputSchema: true,
      behavior: Object.freeze({
        primitiveFamily: "pure" as const,
        // The result depends on the script cursor, not only on the input value.
        determinism: "nondeterministic" as const,
        effect: "none" as const,
        idempotency: "not-applicable" as const,
        recovery: "rerun" as const,
        executionMode: "in-process" as const,
        requiredCapabilities: Object.freeze([]),
      }),
    }),
    get callsConsumed(): number {
      return cursor;
    },
    invoke(_input: JsonObject, context: AdapterInvocationContext): Promise<ToolResult> {
      return Promise.resolve().then(() => {
        context.signal.throwIfAborted();
        const result = script[cursor];
        if (result === undefined) throw new Error("Scripted tool responses exhausted.");
        cursor += 1;
        return structuredClone(result);
      });
    },
  });
}
