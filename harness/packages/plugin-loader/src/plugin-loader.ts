import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { HarnessPlugin, NodeDefinition, PluginContext } from "@zet-harness/plugin-api";
import type { PluginPackageManifest, ResolvedPluginConfig } from "@zet-harness/core";
import {
  PLUGIN_PACKAGE_MANIFEST_FILENAME,
  reconcilePluginGrants,
  validatePluginPackageManifest,
} from "@zet-harness/core";

export type PluginLoadFailureCode =
  | "not-a-directory"
  | "manifest-missing"
  | "manifest-unreadable"
  | "manifest-invalid"
  | "integrity-mismatch"
  | "integrity-file-missing"
  | "entry-outside-package"
  | "entry-missing"
  | "import-failed"
  | "no-plugin-export"
  | "identity-mismatch"
  | "undeclared-node";

export interface PluginLoadFailure {
  readonly code: PluginLoadFailureCode;
  readonly message: string;
  /** Package directory name, never the absolute host path. */
  readonly packageName: string;
}

export interface DiscoveredPluginPackage {
  readonly packageName: string;
  readonly directory: string;
  readonly manifest: PluginPackageManifest;
}

export interface PluginDiscoveryResult {
  readonly packages: readonly DiscoveredPluginPackage[];
  readonly failures: readonly PluginLoadFailure[];
}

export interface PluginDiscoveryOptions {
  /** Absolute directory containing one subdirectory per plugin package. */
  readonly pluginsDirectory: string;
  readonly harnessVersion?: string;
  /** Maximum bytes read for a manifest or an integrity-checked file. */
  readonly maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 4_194_304; // 4 MiB

function failure(
  code: PluginLoadFailureCode,
  packageName: string,
  message: string,
): PluginLoadFailure {
  return Object.freeze({ code, packageName, message });
}

/**
 * Resolve a package-relative path, refusing anything that leaves the package.
 *
 * A manifest is authored by whoever wrote the plugin, so its paths are
 * untrusted input even though the file sits on the host's own disk.
 */
function resolveInsidePackage(directory: string, relativePath: string): string | undefined {
  if (relativePath.includes("\0")) return undefined;
  const candidate = resolve(directory, relativePath);
  const root = resolve(directory);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const inside =
    process.platform === "linux"
      ? candidate === root || candidate.startsWith(prefix)
      : candidate.toLowerCase() === root.toLowerCase() ||
        candidate.toLowerCase().startsWith(prefix.toLowerCase());
  return inside ? candidate : undefined;
}

/**
 * Read and validate every plugin package in a directory.
 *
 * Discovery reads manifests only. **No plugin code is imported here**, so a
 * host can list what is installed, show what each package asks for, and let a
 * person decide, all without executing anything a package shipped.
 */
export async function discoverPluginPackages(
  options: PluginDiscoveryOptions,
): Promise<PluginDiscoveryResult> {
  const { pluginsDirectory } = options;
  if (!isAbsolute(pluginsDirectory)) {
    throw new TypeError("pluginsDirectory must be an absolute path.");
  }
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const packages: DiscoveredPluginPackage[] = [];
  const failures: PluginLoadFailure[] = [];

  let dirents;
  try {
    dirents = await readdir(pluginsDirectory, { withFileTypes: true });
  } catch {
    // A missing plugins directory is an empty installation, not an error.
    return Object.freeze({ packages: Object.freeze([]), failures: Object.freeze([]) });
  }

  // Sorted so discovery order is reproducible across hosts.
  const names = dirents
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort();

  for (const packageName of names) {
    const directory = join(pluginsDirectory, packageName);
    const manifestPath = join(directory, PLUGIN_PACKAGE_MANIFEST_FILENAME);

    let raw: string;
    try {
      const info = await stat(manifestPath);
      if (!info.isFile()) {
        failures.push(failure("manifest-missing", packageName, "Manifest is not a file."));
        continue;
      }
      if (info.size > maxFileBytes) {
        failures.push(failure("manifest-unreadable", packageName, "Manifest is too large."));
        continue;
      }
      raw = await readFile(manifestPath, "utf8");
    } catch {
      failures.push(
        failure(
          "manifest-missing",
          packageName,
          `No ${PLUGIN_PACKAGE_MANIFEST_FILENAME} in this package.`,
        ),
      );
      continue;
    }

    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      failures.push(failure("manifest-unreadable", packageName, "Manifest is not valid JSON."));
      continue;
    }

    const validation = validatePluginPackageManifest(
      document,
      options.harnessVersion === undefined ? {} : { harnessVersion: options.harnessVersion },
    );
    if (!validation.valid || validation.manifest === undefined) {
      const summary = validation.defects
        .map((defect) => `${defect.field}: ${defect.message}`)
        .join("; ");
      failures.push(failure("manifest-invalid", packageName, summary));
      continue;
    }

    packages.push(Object.freeze({ packageName, directory, manifest: validation.manifest }));
  }

  return Object.freeze({ packages: Object.freeze(packages), failures: Object.freeze(failures) });
}

export interface IntegrityVerification {
  readonly verified: boolean;
  /** True when the package declared no integrity block at all. */
  readonly unsigned: boolean;
  readonly failures: readonly PluginLoadFailure[];
}

/**
 * Verify a package's declared file digests.
 *
 * A package with no integrity block is reported as `unsigned` rather than
 * treated as verified, so a host can refuse unsigned packages by policy
 * instead of the loader silently deciding on its behalf.
 */
export async function verifyPackageIntegrity(
  discovered: DiscoveredPluginPackage,
  maxFileBytes: number = DEFAULT_MAX_FILE_BYTES,
): Promise<IntegrityVerification> {
  const integrity = discovered.manifest.integrity;
  if (integrity === undefined) {
    return Object.freeze({ verified: false, unsigned: true, failures: Object.freeze([]) });
  }

  const failures: PluginLoadFailure[] = [];

  for (const [relativePath, expected] of Object.entries(integrity.files)) {
    const absolute = resolveInsidePackage(discovered.directory, relativePath);
    if (absolute === undefined) {
      failures.push(
        failure(
          "integrity-mismatch",
          discovered.packageName,
          `Integrity path '${relativePath}' escapes the package.`,
        ),
      );
      continue;
    }

    let bytes: Buffer;
    try {
      const info = await stat(absolute);
      if (!info.isFile() || info.size > maxFileBytes) {
        failures.push(
          failure(
            "integrity-file-missing",
            discovered.packageName,
            `'${relativePath}' is not a readable file.`,
          ),
        );
        continue;
      }
      bytes = await readFile(absolute);
    } catch {
      failures.push(
        failure(
          "integrity-file-missing",
          discovered.packageName,
          `'${relativePath}' is listed in integrity but missing.`,
        ),
      );
      continue;
    }

    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      failures.push(
        failure(
          "integrity-mismatch",
          discovered.packageName,
          `'${relativePath}' does not match its recorded digest.`,
        ),
      );
    }
  }

  return Object.freeze({
    verified: failures.length === 0,
    unsigned: false,
    failures: Object.freeze(failures),
  });
}

export interface LoadedPluginPackage {
  readonly packageName: string;
  readonly manifest: PluginPackageManifest;
  readonly plugin: HarnessPlugin;
  readonly unsigned: boolean;
}

export interface LoadPluginOptions {
  /** Refuse a package that declares no integrity block. Defaults to false. */
  readonly requireIntegrity?: boolean;
  readonly maxFileBytes?: number;
  /** Injection point for tests; defaults to dynamic `import()`. */
  readonly importModule?: (url: string) => Promise<unknown>;
}

function readDefaultExport(module: unknown): unknown {
  if (typeof module !== "object" || module === null) return undefined;
  const record = module as Record<string, unknown>;
  return record["default"] ?? record["plugin"];
}

function looksLikePlugin(value: unknown): value is HarnessPlugin {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["activate"] === "function" &&
    typeof candidate["manifest"] === "object" &&
    candidate["manifest"] !== null
  );
}

/**
 * Load one discovered package into a plugin object.
 *
 * Integrity is verified before the entry module is imported, because verifying
 * after execution would verify nothing. The loaded plugin's own manifest must
 * agree with the package manifest on id and version: without that check a
 * package could advertise one identity for review and register another.
 *
 * Loading still grants nothing. The returned plugin must be activated through
 * the normal `PluginHost`, under whatever capability policy the host decided.
 */
export async function loadPluginPackage(
  discovered: DiscoveredPluginPackage,
  options: LoadPluginOptions = {},
): Promise<LoadedPluginPackage | PluginLoadFailure> {
  const integrity = await verifyPackageIntegrity(
    discovered,
    options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
  );

  if (integrity.unsigned && options.requireIntegrity === true) {
    return failure(
      "integrity-mismatch",
      discovered.packageName,
      "Package declares no integrity block and unsigned packages are refused.",
    );
  }
  if (!integrity.unsigned && !integrity.verified) {
    return (
      integrity.failures[0] ??
      failure(
        "integrity-mismatch",
        discovered.packageName,
        "Package integrity verification failed.",
      )
    );
  }

  const entryPath = resolveInsidePackage(discovered.directory, discovered.manifest.entry);
  if (entryPath === undefined) {
    return failure(
      "entry-outside-package",
      discovered.packageName,
      "Entry path resolves outside the package directory.",
    );
  }

  try {
    const info = await stat(entryPath);
    if (!info.isFile()) {
      return failure("entry-missing", discovered.packageName, "Entry is not a file.");
    }
  } catch {
    return failure("entry-missing", discovered.packageName, "Entry file does not exist.");
  }

  let module: unknown;
  try {
    const importModule = options.importModule ?? ((url: string) => import(url) as Promise<unknown>);
    module = await importModule(pathToFileURL(entryPath).href);
  } catch (error: unknown) {
    return failure(
      "import-failed",
      discovered.packageName,
      error instanceof Error ? error.message : "Entry module could not be imported.",
    );
  }

  const exported = readDefaultExport(module);
  if (!looksLikePlugin(exported)) {
    return failure(
      "no-plugin-export",
      discovered.packageName,
      "Entry module does not export a plugin with a manifest and an activate function.",
    );
  }

  const runtimeManifest = exported.manifest;
  if (
    runtimeManifest.id !== discovered.manifest.id ||
    runtimeManifest.version !== discovered.manifest.version
  ) {
    return failure(
      "identity-mismatch",
      discovered.packageName,
      "The loaded plugin's identity does not match its package manifest.",
    );
  }

  return Object.freeze({
    packageName: discovered.packageName,
    manifest: discovered.manifest,
    plugin: exported,
    unsigned: integrity.unsigned,
  });
}

/**
 * Wrap a plugin so it can only register the node types its manifest declared.
 *
 * The package manifest is what a person reviews before enabling a plugin. If
 * the plugin could then register anything, that review would be meaningless,
 * so an undeclared registration fails activation instead of being ignored.
 */
export function enforceDeclaredNodes(loaded: LoadedPluginPackage): HarnessPlugin {
  const declared = new Set(loaded.manifest.nodes.map((node) => `${node.type}\0${node.version}`));

  return Object.freeze({
    manifest: loaded.plugin.manifest,
    activate(context: PluginContext): void | Promise<void> {
      const guarded: PluginContext = Object.freeze({
        ...context,
        nodes: Object.freeze({
          register(definition: NodeDefinition): void {
            const key = `${definition.manifest.type}\0${definition.manifest.version}`;
            if (!declared.has(key)) {
              throw new Error(
                `Plugin '${loaded.manifest.id}' registered node '${definition.manifest.type}' ` +
                  `version '${definition.manifest.version}', which its manifest does not declare.`,
              );
            }
            context.nodes.register(definition);
          },
        }),
      });
      return loaded.plugin.activate(guarded);
    },
  });
}

export interface PluginInstallationView {
  readonly packageName: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly enabled: boolean;
  readonly requestedCapabilities: readonly string[];
  readonly grantedCapabilities: readonly string[];
  readonly withheldCapabilities: readonly string[];
  readonly declaredNodes: readonly string[];
  readonly unsigned: boolean;
}

/**
 * Describe an installed package for a host UI.
 *
 * This is what makes "installed" and "authorized" visibly different: a person
 * sees what a plugin asked for next to what it actually received.
 */
export function describeInstallation(
  discovered: DiscoveredPluginPackage,
  config: ResolvedPluginConfig | undefined,
): PluginInstallationView {
  const record = reconcilePluginGrants(
    discovered.manifest,
    config?.grantedCapabilities ?? [],
    config?.enabled ?? false,
  );

  return Object.freeze({
    packageName: discovered.packageName,
    id: discovered.manifest.id,
    name: discovered.manifest.name,
    version: discovered.manifest.version,
    license: discovered.manifest.license,
    enabled: record.enabled,
    requestedCapabilities: discovered.manifest.requestedCapabilities,
    grantedCapabilities: record.grantedCapabilities,
    withheldCapabilities: record.withheldCapabilities,
    declaredNodes: Object.freeze(discovered.manifest.nodes.map((node) => node.type)),
    unsigned: discovered.manifest.integrity === undefined,
  });
}
