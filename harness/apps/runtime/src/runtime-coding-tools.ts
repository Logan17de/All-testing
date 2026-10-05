import type {
  ToolAdapter,
  JsonObject,
  AdapterInvocationContext,
  ToolResult,
  JsonValue,
} from "@zet-harness/plugin-api";
import { createWorkspacePathResolver } from "@zet-harness/tools";

import { executeWorkspaceReadTool } from "./runtime-workspace-read-tools.js";

export interface RuntimeCodingToolOptions {
  /** Fixed absolute workspace root. Create fresh adapters when switching projects. */
  readonly root: string;
}

/**
 * Provider-neutral, read-only coding tools. The shared descriptor-relative
 * workspace executor does not call Codex or any provider. Linux is required;
 * other platforms fail closed because path preflight alone is not a sandbox.
 * Writes and processes are deliberately absent until the host can suspend and
 * resume a durable approval bound to the exact tool call.
 */
export function createRuntimeCodingTools(
  options: RuntimeCodingToolOptions,
): readonly ToolAdapter[] {
  const resolver = createWorkspacePathResolver({ root: options.root });
  return Object.freeze(
    (["read", "list"] as const).map((operation): ToolAdapter =>
      Object.freeze({
        manifest: Object.freeze({
          id: `harness.fs.${operation}`,
          version: "1",
          title: operation === "read" ? "Read workspace file" : "List workspace directory",
          description:
            operation === "read"
              ? "Read one UTF-8 workspace file up to 64 KiB. Credential names, symlinks and hardlinks are refused. Requires Linux."
              : "List up to 200 workspace entries, excluding credential names and symlinks. Requires Linux.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            ...(operation === "read" ? { required: ["path"] } : {}),
            properties: { path: { type: "string", description: "Workspace-relative path." } },
          },
          outputSchema: { type: "object" },
          behavior: {
            primitiveFamily: "effect",
            determinism: "nondeterministic",
            effect: "external-read",
            idempotency: "idempotent",
            recovery: "rerun",
            executionMode: "in-process",
            requiredCapabilities: ["fs:read"],
          } as const,
        }),
        async invoke(input: JsonObject, context: AdapterInvocationContext): Promise<ToolResult> {
          context.signal.throwIfAborted();
          // The package resolver enforces portable lexical containment. The
          // descriptor executor then independently anchors every open directory.
          try {
            if (typeof input.path === "string") resolver.resolveLexical(input.path);
          } catch {
            throw new Error("Workspace tool rejected the request.");
          }
          const result = await executeWorkspaceReadTool(
            resolver.root,
            operation === "read" ? "harness.fs.read" : "harness.fs.list",
            input,
          );
          context.signal.throwIfAborted();
          if (!result.success) throw new Error("Workspace tool rejected the request.");
          const text = result.contentItems[0]?.text ?? "";
          return {
            value: operation === "read" ? { content: text } : (JSON.parse(text) as JsonValue),
          };
        },
      }),
    ),
  );
}
