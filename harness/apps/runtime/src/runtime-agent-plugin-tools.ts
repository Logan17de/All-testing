import type { PluginHost } from "@zet-harness/core";
import type {
  AdapterInvocationContext,
  JsonObject,
  JsonValue,
  ToolAdapter,
} from "@zet-harness/plugin-api";
import { registeredAgentToolOwner } from "./runtime-agent-tool-policy.js";

export interface InstalledAgentPluginToolOptions {
  host: PluginHost;
  allows(pluginId: string, capability: string): boolean;
  approve(
    request: { tool: string; args: JsonObject },
    context: AdapterInvocationContext,
  ): Promise<boolean>;
}
/** Copy JSON data without invoking getters/toJSON; depth, node count and serialized bytes are bounded. */
function immutableInput(input: JsonObject): JsonObject {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set<object>();
  function clone(value: unknown, depth: number): JsonValue {
    if (++nodes > 20_000 || depth > 32) throw new Error("Installed plugin input exceeds limits.");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if ((bytes += Buffer.byteLength(value)) > 131_072)
        throw new Error("Installed plugin input exceeds limits.");
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || !value || seen.has(value))
      throw new Error("Installed plugin input must be JSON data.");
    seen.add(value);
    try {
      if (Object.getOwnPropertySymbols(value).length > 0)
        throw new Error("Installed plugin input must be JSON data.");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Array.isArray(value)) {
        if (
          value.length > 20_000 ||
          Object.keys(descriptors).some((key) => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))
        )
          throw new Error("Installed plugin input must be JSON data.");
        const result: JsonValue[] = [];
        for (let index = 0; index < value.length; index++) {
          const item = descriptors[String(index)];
          if (!item || !("value" in item))
            throw new Error("Installed plugin input must be JSON data.");
          result.push(clone(item.value, depth + 1));
        }
        return Object.freeze(result);
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null))
        throw new Error("Installed plugin input must be JSON data.");
      const entries = Object.entries(descriptors).map(([key, descriptor]): [string, JsonValue] => {
        if ((bytes += Buffer.byteLength(key)) > 131_072)
          throw new Error("Installed plugin input exceeds limits.");
        if (!descriptor.enumerable || !("value" in descriptor))
          throw new Error("Installed plugin input must be JSON data.");
        return [key, clone(descriptor.value, depth + 1)];
      });
      return Object.freeze(Object.fromEntries(entries));
    } finally {
      seen.delete(value);
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Installed plugin input must be an object.");
  const copied = clone(input, 0) as JsonObject;
  if (Buffer.byteLength(JSON.stringify(copied)) > 131_072)
    throw new Error("Installed plugin input exceeds limits.");
  return copied;
}

/** Native tools are collected separately. This collector never grants plugin capabilities. */
export function collectInstalledAgentPluginTools(
  options: InstalledAgentPluginToolOptions,
): readonly { adapter: ToolAdapter; owner: string }[] {
  const { host } = options;
  return Object.freeze(
    host.tools.listManifests().flatMap((manifest) => {
      const captured = host.tools.getAdapter(manifest.id, manifest.version);
      if (!captured) return [];
      const owner = registeredAgentToolOwner(host.tools, captured);
      const resolution = host.tools.getResolution(manifest.id, manifest.version);
      if (!owner || !resolution || !host.has(resolution.plugin.id)) return [];
      const pluginId = resolution.plugin.id;
      const ownerVersion = resolution.plugin.version;
      const authorized = (): boolean =>
        host.has(pluginId) &&
        host
          .listManifests()
          .some((plugin) => plugin.id === pluginId && plugin.version === ownerVersion) &&
        host.tools.getAdapter(manifest.id, manifest.version) === captured &&
        registeredAgentToolOwner(host.tools, captured) === owner &&
        host.tools.getResolution(manifest.id, manifest.version)?.plugin.version === ownerVersion &&
        manifest.behavior.requiredCapabilities.every((capability) =>
          options.allows(pluginId, capability),
        );
      if (!authorized()) return [];
      const needsApproval = !["none", "external-read"].includes(manifest.behavior.effect);
      const wrapped: ToolAdapter = Object.freeze({
        manifest,
        async invoke(input: JsonObject, context: AdapterInvocationContext) {
          context.signal.throwIfAborted();
          if (!authorized()) throw new Error("Installed plugin tool authority expired.");
          const snapshot = immutableInput(input);
          if (needsApproval) {
            let accepted = false;
            try {
              accepted = await options.approve(
                Object.freeze({ tool: manifest.id, args: snapshot }),
                context,
              );
            } catch {
              context.signal.throwIfAborted();
              throw new Error("Installed plugin tool approval refused.");
            }
            context.signal.throwIfAborted();
            if (!accepted) throw new Error("Installed plugin tool approval refused.");
          }
          if (!authorized()) throw new Error("Installed plugin tool authority expired.");
          context.signal.throwIfAborted();
          try {
            const result = await captured.invoke(snapshot, context);
            context.signal.throwIfAborted();
            return result;
          } catch {
            context.signal.throwIfAborted();
            throw new Error("Installed plugin tool execution failed.");
          }
        },
      });
      return [Object.freeze({ adapter: wrapped, owner })];
    }),
  );
}
