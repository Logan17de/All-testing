import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  PluginHost,
  findPluginConfig,
  pluginCapabilityPolicy,
  validatePluginConfig,
  type CapabilityPermissionPolicy,
  type ResolvedPluginConfig,
} from "@zet-harness/core";
import {
  describeInstallation,
  discoverPluginPackages,
  enforceDeclaredNodes,
  loadPluginPackage,
  type PluginInstallationView,
  type PluginLoadFailure,
} from "@zet-harness/plugin-loader";

export const DEFAULT_PLUGINS_DIRECTORY = resolve("plugins");
export const DEFAULT_PLUGIN_CONFIG_FILENAME = "plugins.json";

export interface RuntimePluginOptions {
  /** Directory holding one subdirectory per installed plugin package. */
  readonly directory?: string;
  /** Config file path. Defaults to `plugins.json` inside the plugins directory. */
  readonly configPath?: string;
  /** Refuse packages that ship no integrity digests. Defaults to false. */
  readonly requireIntegrity?: boolean;
  /** Reported to packages that declare `minHarnessVersion`. */
  readonly harnessVersion?: string;
}

export interface RuntimePluginReport {
  readonly directory: string;
  /** Every installed package, enabled or not, with its grant situation. */
  readonly installed: readonly PluginInstallationView[];
  /** Ids of plugins successfully activated. */
  readonly activated: readonly string[];
  /** Packages that could not be read, verified, loaded or activated. */
  readonly failures: readonly PluginLoadFailure[];
  /** Problems in the configuration document itself. */
  readonly configDefects: readonly string[];
}

interface LoadedPluginState {
  readonly host: PluginHost;
  readonly report: RuntimePluginReport;
  readonly policies: ReadonlyMap<string, CapabilityPermissionPolicy>;
}

async function readConfigDocument(path: string): Promise<{
  readonly document: unknown;
  readonly defects: readonly string[];
}> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // No configuration file means nothing is enabled, which is the correct
    // default for a directory someone may have just dropped a folder into.
    return { document: undefined, defects: Object.freeze([]) };
  }

  try {
    return { document: JSON.parse(raw) as unknown, defects: Object.freeze([]) };
  } catch {
    return {
      document: undefined,
      defects: Object.freeze([`${DEFAULT_PLUGIN_CONFIG_FILENAME} is not valid JSON.`]),
    };
  }
}

/**
 * Load and activate the plugins a host has enabled.
 *
 * Discovery covers every installed package so a UI can show what is available,
 * but only packages the configuration explicitly enables are loaded, and each
 * one activates under a capability policy built solely from what the host
 * granted. A package's own requests never contribute to that policy.
 *
 * A failing plugin never prevents the daemon from starting. A third-party
 * package is not trusted to be correct, and one bad plugin taking down the
 * whole runtime would make installing anything unreasonably risky.
 */
export async function loadRuntimePlugins(
  options: RuntimePluginOptions = {},
  host: PluginHost = new PluginHost(),
): Promise<LoadedPluginState> {
  const directory = options.directory ?? DEFAULT_PLUGINS_DIRECTORY;
  if (!isAbsolute(directory)) {
    throw new TypeError("Plugins directory must be an absolute path.");
  }
  const configPath = options.configPath ?? join(directory, DEFAULT_PLUGIN_CONFIG_FILENAME);

  const { document, defects } = await readConfigDocument(configPath);
  const configValidation = validatePluginConfig(document);
  const configDefects = [
    ...defects,
    ...configValidation.defects.map((defect) => `${defect.field}: ${defect.message}`),
  ];

  const discovery = await discoverPluginPackages({
    pluginsDirectory: directory,
    ...(options.harnessVersion === undefined ? {} : { harnessVersion: options.harnessVersion }),
  });

  const installed: PluginInstallationView[] = [];
  const activated: string[] = [];
  const failures: PluginLoadFailure[] = [...discovery.failures];
  const policies = new Map<string, CapabilityPermissionPolicy>();

  for (const discovered of discovery.packages) {
    const entry: ResolvedPluginConfig | undefined = findPluginConfig(
      configValidation.entries,
      discovered.manifest.id,
    );
    installed.push(describeInstallation(discovered, entry));

    if (entry?.enabled !== true) continue;

    const loaded = await loadPluginPackage(discovered, {
      ...(options.requireIntegrity === undefined
        ? {}
        : { requireIntegrity: options.requireIntegrity }),
    });
    if ("code" in loaded) {
      failures.push(loaded);
      continue;
    }

    try {
      // The policy comes from host configuration alone. The plugin's declared
      // capabilities are demand and contribute nothing to what it receives.
      policies.set(discovered.manifest.id, pluginCapabilityPolicy(entry));
      await host.activate(
        enforceDeclaredNodes(loaded),
        entry.config === undefined ? undefined : entry.config,
      );
      activated.push(discovered.manifest.id);
    } catch (error: unknown) {
      policies.delete(discovered.manifest.id);
      failures.push(
        Object.freeze({
          code: "import-failed" as const,
          packageName: discovered.packageName,
          message: error instanceof Error ? error.message : "Plugin activation failed.",
        }),
      );
    }
  }

  return {
    host,
    policies,
    report: Object.freeze({
      directory,
      installed: Object.freeze(installed),
      activated: Object.freeze(activated),
      failures: Object.freeze(failures),
      configDefects: Object.freeze(configDefects),
    }),
  };
}

/** Empty report for a daemon configured without plugin support. */
export function emptyPluginReport(directory: string): RuntimePluginReport {
  return Object.freeze({
    directory,
    installed: Object.freeze([]),
    activated: Object.freeze([]),
    failures: Object.freeze([]),
    configDefects: Object.freeze([]),
  });
}
