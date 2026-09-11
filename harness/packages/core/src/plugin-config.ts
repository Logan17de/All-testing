import type { CapabilityId, JsonValue } from "@zet-harness/plugin-api";

import { CapabilityPermissionPolicy } from "./capability-permission-policy.js";

/**
 * Host configuration for one installed plugin.
 *
 * `grantedCapabilities` is the host's decision and is the only thing that
 * confers authority. A package's `requestedCapabilities` never appears here:
 * installing and authorizing are separate acts, and copying a request into a
 * grant would collapse that distinction.
 */
export interface PluginConfigEntry {
  readonly id: string;
  /** Defaults to false. A newly installed plugin is off until enabled. */
  readonly enabled?: boolean;
  readonly grantedCapabilities?: readonly CapabilityId[];
  readonly deniedCapabilities?: readonly CapabilityId[];
  /** Opaque plugin configuration data. Never interpreted as permission. */
  readonly config?: JsonValue;
}

export interface PluginConfigDocument {
  readonly plugins?: readonly PluginConfigEntry[];
}

export type PluginConfigDefectCode =
  | "not-an-object"
  | "invalid-plugins"
  | "invalid-entry"
  | "missing-id"
  | "duplicate-id"
  | "invalid-capability";

export interface PluginConfigDefect {
  readonly code: PluginConfigDefectCode;
  readonly field: string;
  readonly message: string;
}

export interface ResolvedPluginConfig {
  readonly id: string;
  readonly enabled: boolean;
  readonly grantedCapabilities: readonly CapabilityId[];
  readonly deniedCapabilities: readonly CapabilityId[];
  readonly config: JsonValue | undefined;
}

export interface PluginConfigValidation {
  readonly valid: boolean;
  readonly entries: readonly ResolvedPluginConfig[];
  readonly defects: readonly PluginConfigDefect[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCapabilityList(
  value: unknown,
  field: string,
  defects: PluginConfigDefect[],
): readonly CapabilityId[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) {
    defects.push({ code: "invalid-capability", field, message: `'${field}' must be an array.` });
    return Object.freeze([]);
  }
  const result: CapabilityId[] = [];
  for (const capability of value as readonly unknown[]) {
    if (typeof capability !== "string" || capability.length === 0) {
      defects.push({
        code: "invalid-capability",
        field,
        message: "Capabilities must be non-empty strings.",
      });
      continue;
    }
    if (!result.includes(capability)) result.push(capability);
  }
  return Object.freeze(result);
}

/**
 * Validate a plugin configuration document.
 *
 * A plugin absent from the configuration is not enabled. Default-off matters:
 * dropping a folder into a plugins directory must not be enough to make it run.
 */
export function validatePluginConfig(document: unknown): PluginConfigValidation {
  const defects: PluginConfigDefect[] = [];

  if (document === undefined || document === null) {
    return Object.freeze({ valid: true, entries: Object.freeze([]), defects: Object.freeze([]) });
  }
  if (!isRecord(document)) {
    return Object.freeze({
      valid: false,
      entries: Object.freeze([]),
      defects: Object.freeze([
        { code: "not-an-object" as const, field: ".", message: "Config must be a JSON object." },
      ]),
    });
  }

  const rawPlugins = document["plugins"];
  if (rawPlugins === undefined || rawPlugins === null) {
    return Object.freeze({ valid: true, entries: Object.freeze([]), defects: Object.freeze([]) });
  }
  if (!Array.isArray(rawPlugins)) {
    return Object.freeze({
      valid: false,
      entries: Object.freeze([]),
      defects: Object.freeze([
        {
          code: "invalid-plugins" as const,
          field: "plugins",
          message: "'plugins' must be an array.",
        },
      ]),
    });
  }

  const entries: ResolvedPluginConfig[] = [];
  const seen = new Set<string>();

  for (const raw of rawPlugins as readonly unknown[]) {
    if (!isRecord(raw)) {
      defects.push({
        code: "invalid-entry",
        field: "plugins[]",
        message: "Each plugin entry must be an object.",
      });
      continue;
    }
    const id = raw["id"];
    if (typeof id !== "string" || id.length === 0) {
      defects.push({ code: "missing-id", field: "plugins[].id", message: "'id' is required." });
      continue;
    }
    if (seen.has(id)) {
      defects.push({
        code: "duplicate-id",
        field: "plugins[].id",
        message: `Plugin '${id}' is configured more than once.`,
      });
      continue;
    }
    seen.add(id);

    entries.push(
      Object.freeze({
        id,
        enabled: raw["enabled"] === true,
        grantedCapabilities: readCapabilityList(
          raw["grantedCapabilities"],
          "plugins[].grantedCapabilities",
          defects,
        ),
        deniedCapabilities: readCapabilityList(
          raw["deniedCapabilities"],
          "plugins[].deniedCapabilities",
          defects,
        ),
        config: (raw["config"] ?? undefined) as JsonValue | undefined,
      }),
    );
  }

  return Object.freeze({
    valid: defects.length === 0,
    entries: Object.freeze(entries),
    defects: Object.freeze(defects),
  });
}

/**
 * Build the capability policy for one plugin from host configuration.
 *
 * The resulting policy reflects only what the host granted. A plugin cannot
 * widen it, and nothing in the plugin package contributes to it.
 */
export function pluginCapabilityPolicy(entry: ResolvedPluginConfig): CapabilityPermissionPolicy {
  return new CapabilityPermissionPolicy({
    granted: entry.grantedCapabilities,
    denied: entry.deniedCapabilities,
  });
}

/** Look up one plugin's configuration; absent means installed-but-not-enabled. */
export function findPluginConfig(
  entries: readonly ResolvedPluginConfig[],
  id: string,
): ResolvedPluginConfig | undefined {
  return entries.find((entry) => entry.id === id);
}
