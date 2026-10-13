import type { JsonObject, ToolAdapter } from "@zet-harness/plugin-api";
import { modelToolName } from "./runtime-action-tools.js";
export interface AgentToolIdentity {
  readonly id: string;
  readonly version: string;
  readonly owner: string;
}
export interface AgentToolPolicy {
  /** Canonical registry IDs, never provider aliases. Undefined preserves host-authorized defaults. */
  readonly allowlist?: readonly string[];
  readonly legacyNames?: readonly string[];
  readonly recordedCatalog?: readonly AgentToolIdentity[];
  readonly owner?: (tool: ToolAdapter) => string | undefined;
}
export function agentToolAllowlist(config: JsonObject): readonly string[] | undefined {
  const value = config.toolAllowlist;
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 200 ||
    !value.every(
      (id: unknown) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(id),
    ) ||
    new Set(value).size !== value.length
  )
    throw new Error("Invalid canonical tool allowlist.");
  return value as readonly string[];
}
export function agentToolCatalog(
  tools: readonly ToolAdapter[],
  owner?: AgentToolPolicy["owner"],
): readonly AgentToolIdentity[] {
  return tools.flatMap((tool) => {
    const provenance = owner ? owner(tool) : "trusted-host";
    return provenance
      ? [{ id: tool.manifest.id, version: tool.manifest.version, owner: provenance }]
      : [];
  });
}
/** Remove ambiguous aliases and intersect restrictions; this never grants capabilities. */
export function restrictAgentTools(
  tools: readonly ToolAdapter[],
  policy: AgentToolPolicy = {},
): readonly ToolAdapter[] {
  const ids = new Map<string, ToolAdapter[]>();
  const names = new Map<string, Set<string>>();
  for (const tool of tools) {
    const list = ids.get(tool.manifest.id) ?? [];
    if (!list.includes(tool)) list.push(tool);
    ids.set(tool.manifest.id, list);
    const name = modelToolName(tool.manifest.id);
    const aliases = names.get(name) ?? new Set<string>();
    aliases.add(tool.manifest.id);
    names.set(name, aliases);
  }
  return [...ids.values()].flatMap((candidates) => {
    if (candidates.length !== 1) return [];
    const tool = candidates[0]!;
    const id = tool.manifest.id;
    const name = modelToolName(id);
    if (
      names.get(name)?.size !== 1 ||
      (policy.allowlist !== undefined && !policy.allowlist.includes(id)) ||
      (policy.legacyNames !== undefined && !policy.legacyNames.includes(name))
    )
      return [];
    const identity = agentToolCatalog([tool], policy.owner)[0];
    if (
      !identity ||
      (policy.recordedCatalog !== undefined &&
        !policy.recordedCatalog.some(
          (record) =>
            record.id === identity.id &&
            record.version === identity.version &&
            record.owner === identity.owner,
        ))
    )
      return [];
    return [tool];
  });
}
/** Registry ownership is trusted only when the resolved adapter is exactly the catalog instance. */
export function registeredAgentToolOwner(
  registry: {
    getAdapter(id: string, version: string): ToolAdapter | undefined;
    getResolution(
      id: string,
      version: string,
    ): { plugin: { id: string; version: string } } | undefined;
  },
  tool: ToolAdapter,
): string | undefined {
  if (registry.getAdapter(tool.manifest.id, tool.manifest.version) !== tool) return undefined;
  const pin = registry.getResolution(tool.manifest.id, tool.manifest.version)?.plugin;
  return pin ? JSON.stringify([pin.id, pin.version]) : undefined;
}
export function readRecordedAgentToolCatalog(value: unknown): readonly AgentToolIdentity[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const catalog = (value as Record<string, unknown>).toolCatalog;
  if (!Array.isArray(catalog) || catalog.length > 1000) return [];
  return catalog.filter(
    (record: unknown): record is AgentToolIdentity =>
      !!record &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      ["id", "version", "owner"].every(
        (key) => typeof (record as Record<string, unknown>)[key] === "string",
      ),
  );
}

/** Child reads inherit the invocation's actual effective parent scope; missing scope denies all. */
export function inheritedReadTools(
  tools: readonly ToolAdapter[],
  scope?: readonly string[],
): readonly ToolAdapter[] {
  return restrictAgentTools(
    tools.filter(
      (tool) =>
        ["harness.fs.read", "harness.fs.list"].includes(tool.manifest.id) &&
        tool.manifest.behavior.effect === "external-read" &&
        tool.manifest.behavior.requiredCapabilities.every((capability) => capability === "fs:read"),
    ),
    { allowlist: scope ?? [] },
  );
}
