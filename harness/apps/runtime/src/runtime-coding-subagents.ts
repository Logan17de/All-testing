import type {
  AdapterInvocationContext,
  JsonObject,
  ModelMessage,
  ModelRequest,
  ModelResult,
  ToolAdapter,
} from "@zet-harness/plugin-api";

import { inheritedReadTools } from "./runtime-agent-tool-policy.js";

export interface RuntimeCodingSubagentOptions {
  /** Trusted host supplies the parent's selected, authorized inference adapter. */
  readonly generate: (
    request: ModelRequest,
    context: AdapterInvocationContext,
  ) => Promise<ModelResult>;
  readonly readTools: readonly ToolAdapter[];
}

/** Separate-context, depth-one children. No independent process or privileged authority. */
export function createRuntimeCodingSubagentTool(
  options: RuntimeCodingSubagentOptions,
): ToolAdapter {
  const calls = new Map<string, number>();

  return {
    manifest: {
      id: "harness.agent.delegate",
      version: "1",
      title: "Delegate bounded read-only task",
      description:
        "Ask a child model to analyze an explicit task in separate context with workspace read/list tools only. At most four children per run, two model steps per child, three read calls, and thirty seconds. No recursive delegation, writes or commands.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["task"],
        properties: { task: { type: "string", minLength: 1, maxLength: 8000 } },
      },
      outputSchema: { type: "object" },
      behavior: {
        primitiveFamily: "effect",
        determinism: "nondeterministic",
        effect: "external-read",
        idempotency: "unknown",
        recovery: "manual",
        executionMode: "in-process",
        requiredCapabilities: ["agent:delegate", "fs:read"],
      },
    },
    async invoke(input: JsonObject, context: AdapterInvocationContext) {
      context.signal.throwIfAborted();
      if (
        Object.keys(input).some((key) => key !== "task") ||
        typeof input.task !== "string" ||
        !input.task.trim() ||
        Buffer.byteLength(input.task) > 8000
      )
        throw new Error("Invalid child task.");
      const tools = inheritedReadTools(options.readTools, context.toolScope);
      const names = tools.map((tool) => ({ tool, name: tool.manifest.id.replaceAll(".", "_") }));
      const count = calls.get(context.runId) ?? 0;
      if (count >= 4) throw new Error("Child agent budget exhausted.");
      // Never evict a remembered run and accidentally reset its authority budget.
      if (!calls.has(context.runId) && calls.size >= 1000)
        throw new Error("Child agent run budget capacity exhausted.");
      calls.set(context.runId, count + 1);
      const controller = new AbortController();
      const abort = (): void => controller.abort(context.signal.reason);
      context.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error("Child agent deadline exceeded.")),
        30_000,
      );
      timer.unref?.();
      const childContext = {
        ...context,
        signal: controller.signal,
        toolScope: Object.freeze(tools.map((tool) => tool.manifest.id)),
        logicalEffectId: `${context.logicalEffectId}:child:${count}`,
      };
      const messages: ModelMessage[] = [
        {
          role: "system",
          parts: [
            {
              kind: "text",
              text: "You are a bounded read-only child agent. Analyze the explicit task using workspace read/list tools. Never request writes, commands, credentials or recursive delegation. Return a concise report of actual findings.",
            },
          ],
        },
        { role: "user", parts: [{ kind: "text", text: input.task }] },
      ];
      const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
        controller.signal.throwIfAborted();
        let onAbort: () => void = () => undefined;
        const cancelled = new Promise<never>((_, reject) => {
          onAbort = () =>
            reject(
              controller.signal.reason instanceof Error
                ? controller.signal.reason
                : new Error("Child agent cancelled."),
            );
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          const result = await Promise.race([work(), cancelled]);
          controller.signal.throwIfAborted();
          return result;
        } finally {
          controller.signal.removeEventListener("abort", onAbort);
        }
      };
      let toolCalls = 0;
      try {
        for (let step = 0; step < 2; step++) {
          const result = await bounded(() =>
            options.generate(
              {
                messages: [...messages],
                maxOutputTokens: 1024,
                tools: names.map(({ name, tool }) => ({
                  name,
                  inputSchema: tool.manifest.inputSchema,
                  ...(tool.manifest.description === undefined
                    ? {}
                    : { description: tool.manifest.description }),
                })),
              },
              childContext,
            ),
          );
          if (Buffer.byteLength(JSON.stringify(result.message)) > 16_384)
            throw new Error("Child model output exceeds budget.");
          const requests = result.message.parts.filter((part) => part.kind === "tool-call");
          if (requests.length === 0) {
            const summary = result.message.parts
              .filter((part) => part.kind === "text")
              .map((part) => part.text)
              .join("\n");
            return { value: { summary, modelSteps: step + 1, toolCalls, limited: false } };
          }
          if (step === 1 || toolCalls + requests.length > 3)
            return {
              value: {
                summary: "Child agent reached its bounded execution limit.",
                modelSteps: step + 1,
                toolCalls,
                limited: true,
              },
            };
          messages.push(result.message);
          for (const request of requests) {
            toolCalls++;
            const found = names.find(({ name }) => name === request.name);
            if (!found) throw new Error("Child requested an unavailable tool.");
            const outcome = await bounded(() => found.tool.invoke(request.arguments, childContext));
            if (Buffer.byteLength(JSON.stringify(outcome.value)) > 65_536)
              throw new Error("Child tool output exceeds budget.");
            messages.push({
              role: "tool",
              parts: [{ kind: "tool-result", callId: request.callId, value: outcome.value }],
            });
          }
        }
        throw new Error("Child agent exhausted its model budget.");
      } finally {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", abort);
        controller.abort(new Error("Child agent completed."));
      }
    },
  };
}
