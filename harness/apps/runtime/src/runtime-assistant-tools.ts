import type {
  JsonValue,
  ToolAdapter,
  JsonObject,
  AdapterInvocationContext,
} from "@zet-harness/plugin-api";
import type { AssistantBinding, AssistantGrant } from "./runtime-assistant-access.js";
import { AssistantAccessDenied } from "./runtime-assistant-access.js";
import type { RuntimeAssistantService } from "./runtime-assistant-service.js";
export function createRuntimeAssistantTools(
  service: RuntimeAssistantService,
  authority: AssistantBinding,
): readonly ToolAdapter[] {
  const binding = Object.freeze({ ...authority });
  const chatTools = Object.freeze(
    (["list", "read", "status", "create", "delegate", "control"] as const).map(
      (action): ToolAdapter => ({
        manifest: {
          id: `harness.assistant.${action}`,
          version: "1",
          title: `Assistant ${action}`,
          description:
            "Operate only within explicit user-connected chat grants and the current durable access epoch. Cannot connect or grant access.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties:
              action === "list"
                ? {}
                : action === "create"
                  ? {
                      grants: {
                        type: "array",
                        maxItems: 200,
                        items: {
                          type: "object",
                          additionalProperties: false,
                          required: ["chatId", "permissions"],
                          properties: {
                            chatId: { type: "string" },
                            permissions: {
                              type: "array",
                              items: { type: "string", enum: ["read", "control"] },
                            },
                          },
                        },
                      },
                    }
                  : {
                      chatId: { type: "string" },
                      ...(["delegate", "control"].includes(action)
                        ? { input: { type: "object" } }
                        : {}),
                    },
            required:
              action === "list"
                ? []
                : action === "create"
                  ? ["grants"]
                  : ["chatId", ...(["delegate", "control"].includes(action) ? ["input"] : [])],
          },
          outputSchema: { type: "object" },
          behavior: {
            primitiveFamily: "effect",
            determinism: "nondeterministic",
            effect: ["list", "read", "status"].includes(action)
              ? "external-read"
              : "external-write",
            idempotency: "unknown",
            recovery: "manual",
            executionMode: "in-process",
            requiredCapabilities: [
              `assistant:${["list", "read", "status"].includes(action) ? "read" : "control"}`,
            ],
          },
        },
        async invoke(input, context) {
          context.signal.throwIfAborted();
          service.snapshot(binding);
          const value = structuredClone(input);
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new AssistantAccessDenied();
          const args = value as Record<string, unknown>;
          const expected =
            action === "list"
              ? []
              : action === "create"
                ? ["grants"]
                : ["chatId", ...(["delegate", "control"].includes(action) ? ["input"] : [])];
          if (
            Object.keys(args).length !== expected.length ||
            expected.some((key) => !Object.hasOwn(args, key))
          )
            throw new AssistantAccessDenied();
          let result: unknown;
          if (action === "list") result = service.snapshot(binding);
          else if (action === "create") {
            if (!Array.isArray(args.grants)) throw new AssistantAccessDenied();
            result = await service.createChild(
              binding,
              args.grants as AssistantGrant[],
              context.signal,
            );
          } else {
            if (typeof args.chatId !== "string") throw new AssistantAccessDenied();
            if (action === "read" || action === "status")
              result = await service[action](binding, args.chatId, context.signal);
            else {
              if (!args.input || typeof args.input !== "object" || Array.isArray(args.input))
                throw new AssistantAccessDenied();
              result = await service[action](
                binding,
                args.chatId,
                args.input as Record<string, unknown>,
                context.signal,
              );
            }
          }
          context.signal.throwIfAborted();
          service.snapshot(binding);
          return { value: { result: result as JsonValue }, effects: [] };
        },
      }),
    ),
  );
  const scopedTools = (["tools_request", "tools_requests", "tools_decide"] as const).map(
    (action): ToolAdapter => {
      const expected =
        action === "tools_request"
          ? ["scopes"]
          : action === "tools_requests"
            ? []
            : ["requestId", "decision"];
      return {
        manifest: {
          id: `harness.assistant.${action}`,
          version: "1",
          title: `Assistant ${action}`,
          description:
            "Request or decide a direct child's finite future-turn tool restrictions. Parent grants require an explicit user-delegated ceiling and this invocation's frozen authority. Never grants host capabilities or bypasses per-call approval. A grant revokes current graph turns; restart with a fresh authorized turn.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: expected,
            properties:
              action === "tools_request"
                ? {
                    scopes: {
                      type: "object",
                      additionalProperties: false,
                      required: ["model", "tools"],
                      properties: {
                        model: { type: "array", maxItems: 200, items: { type: "string" } },
                        tools: { type: "array", maxItems: 200, items: { type: "string" } },
                      },
                    },
                  }
                : action === "tools_requests"
                  ? {}
                  : {
                      requestId: { type: "string" },
                      decision: { type: "string", enum: ["grant", "deny"] },
                    },
          },
          outputSchema: { type: "object" },
          behavior: {
            primitiveFamily: "effect",
            determinism: "nondeterministic",
            effect: action === "tools_requests" ? "external-read" : "external-write",
            idempotency: "unknown",
            recovery: "manual",
            executionMode: "in-process",
            requiredCapabilities: [
              action === "tools_requests" ? "assistant:read" : "assistant:control",
            ],
          },
        },
        async invoke(input: JsonObject, context: AdapterInvocationContext) {
          context.signal.throwIfAborted();
          service.snapshot(binding);
          const args = structuredClone(input);
          if (
            Object.keys(args).length !== expected.length ||
            expected.some((key) => !Object.hasOwn(args, key))
          )
            throw new AssistantAccessDenied();
          let result: unknown;
          if (action === "tools_request")
            result = service.requestTools(binding, args.scopes, context.signal);
          else if (action === "tools_requests") result = service.pendingToolRequests(binding);
          else {
            if (
              typeof args.requestId !== "string" ||
              (args.decision !== "grant" && args.decision !== "deny")
            )
              throw new AssistantAccessDenied();
            result = service.decideTools(binding, args.requestId, args.decision, context);
          }
          await Promise.resolve();
          context.signal.throwIfAborted();
          if (action !== "tools_decide" || args.decision !== "grant") service.snapshot(binding);
          return { value: { result: result as JsonValue }, effects: [] };
        },
      };
    },
  );
  return Object.freeze([...chatTools, ...scopedTools]);
}
