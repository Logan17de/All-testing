import type { HarnessPlugin, JsonValue, ToolAdapter, PluginContext } from "@zet-harness/plugin-api";
import type { RuntimePluginMaker } from "./runtime-plugin-maker.js";
export function createRuntimePluginMakerTools(maker: RuntimePluginMaker): readonly ToolAdapter[] {
  return Object.freeze(
    (["scaffold", "edit", "inspect", "validate", "test"] as const).map((action): ToolAdapter => ({
      manifest: {
        id: `harness.plugin-maker.${action}`,
        version: "1",
        title: `Native plugin maker ${action}`,
        description:
          "Propose quarantined native SDK artifacts or perform offline manifest checks. Does not write, import, install, execute, enable or grant access. Human review and confined filesystem approval are separate.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties:
            action === "scaffold"
              ? {
                  id: { type: "string", maxLength: 120 },
                  name: { type: "string", maxLength: 120 },
                  description: { type: "string", maxLength: 2000 },
                  license: { type: "string", enum: ["UNLICENSED", "MIT", "Apache-2.0"] },
                }
              : action === "edit"
                ? {
                    hash: { type: "string" },
                    path: { type: "string" },
                    content: { type: "string", maxLength: 65536 },
                  }
                : { hash: { type: "string" } },
          required:
            action === "scaffold"
              ? ["id", "name"]
              : action === "edit"
                ? ["hash", "path", "content"]
                : ["hash"],
        },
        outputSchema: { type: "object" },
        behavior: {
          primitiveFamily: "effect",
          determinism: "nondeterministic",
          effect: "external-read",
          idempotency: "idempotent",
          recovery: "rerun",
          executionMode: "in-process",
          requiredCapabilities: ["plugin:author"],
        },
      },
      invoke(input, context) {
        context.signal.throwIfAborted();
        const snapshot = structuredClone(input);
        if (
          !snapshot ||
          typeof snapshot !== "object" ||
          Array.isArray(snapshot) ||
          Buffer.byteLength(JSON.stringify(snapshot)) > 131072
        )
          throw new Error("Plugin maker input refused.");
        const args = snapshot as Record<string, unknown>;
        let result: unknown;
        if (action === "scaffold") {
          if (Object.keys(args).some((k) => !["id", "name", "description", "license"].includes(k)))
            throw new Error("Plugin maker input refused.");
          result = maker.scaffold(
            args as { id: string; name: string; description?: string; license?: string },
          );
        } else {
          const keys = action === "edit" ? ["hash", "path", "content"] : ["hash"];
          if (
            Object.keys(args).length !== keys.length ||
            keys.some((k) => typeof args[k] !== "string")
          )
            throw new Error("Plugin maker input refused.");
          result =
            action === "edit"
              ? maker.edit(args.hash as string, args.path as string, args.content as string)
              : maker[action](args.hash as string);
        }
        context.signal.throwIfAborted();
        return Promise.resolve({ value: { result: result as JsonValue }, effects: [] });
      },
    })),
  );
}
/** Native harness plugin; this is not a ChatGPT connector and receives no filesystem or network grant. */
export function createNativePluginMakerPlugin(maker: RuntimePluginMaker): HarnessPlugin {
  return Object.freeze({
    manifest: Object.freeze({
      id: "zet.plugin-maker",
      name: "Native plugin maker",
      version: "1.0.0",
      apiVersion: 1,
      capabilities: [{ id: "plugin:author" }],
    }),
    activate(context: PluginContext) {
      for (const tool of createRuntimePluginMakerTools(maker)) context.tools.register(tool);
    },
  });
}

export const createPluginMakerPlugin = createNativePluginMakerPlugin;
