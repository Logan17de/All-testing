import type {
  AdapterInvocationContext,
  ModelAdapter,
  ModelRequest,
  ModelResult,
  ModelStreamEvent,
} from "@zet-harness/plugin-api";

export interface ScriptedModelAdapter extends ModelAdapter {
  readonly callsConsumed: number;
}

/**
 * Offline finite script. generate and stream share one cursor; there are no hidden
 * retries, time delays, network calls, or fabricated usage. A stream reserves its
 * response on first iteration. Pre-aborted calls do not consume a response;
 * cancellation after a response is reserved does not rewind the script.
 */
export function createScriptedModelAdapter(
  responses: readonly ModelResult[],
  options: { readonly id?: string; readonly version?: string } = {},
): ScriptedModelAdapter {
  const script = structuredClone(responses);
  let cursor = 0;
  const take = (context: AdapterInvocationContext): ModelResult => {
    context.signal.throwIfAborted();
    const result = script[cursor];
    if (result === undefined) throw new Error("Scripted model responses exhausted.");
    cursor += 1;
    return structuredClone(result);
  };
  return Object.freeze({
    manifest: Object.freeze({
      id: options.id ?? "harness.mock-model",
      version: options.version ?? "1",
      title: "Scripted offline model",
      requiredCapabilities: Object.freeze([]),
      features: Object.freeze({
        streaming: true,
        tools: true,
        vision: false,
        structuredOutput: true,
      }),
    }),
    get callsConsumed(): number {
      return cursor;
    },
    generate(_request: ModelRequest, context: AdapterInvocationContext): Promise<ModelResult> {
      // Promise boundary converts an exhausted/aborted synchronous reservation into rejection.
      return Promise.resolve().then(() => take(context));
    },
    async *stream(
      _request: ModelRequest,
      context: AdapterInvocationContext,
    ): AsyncIterable<ModelStreamEvent> {
      await Promise.resolve();
      const result = take(context);
      for (const part of result.message.parts) {
        context.signal.throwIfAborted();
        if (part.kind === "text") yield { type: "text-delta", text: part.text };
        if (part.kind === "tool-call") yield { type: "tool-call", call: structuredClone(part) };
      }
      context.signal.throwIfAborted();
      if (result.usage !== undefined) yield { type: "usage", usage: structuredClone(result.usage) };
      context.signal.throwIfAborted();
      yield { type: "completed", result };
    },
  });
}
