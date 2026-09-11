import { PLUGIN_API_VERSION, type CapabilityId, type Version } from "@zet-harness/plugin-api";

/**
 * The on-disk manifest that describes an installable plugin package.
 *
 * This is distinct from `PluginManifest`, which is the runtime object a loaded
 * plugin exposes. A package manifest is inert data read *before* any plugin
 * code is imported, so a host can decide whether to load a package at all
 * without executing it.
 */
export const PLUGIN_PACKAGE_MANIFEST_VERSION = 1 as const;

/** Conventional filename at the root of a plugin package directory. */
export const PLUGIN_PACKAGE_MANIFEST_FILENAME = "zet-plugin.json" as const;

export type PluginManifestDefectCode =
  | "not-an-object"
  | "unsupported-manifest-version"
  | "unsupported-api-version"
  | "missing-field"
  | "invalid-field"
  | "invalid-id"
  | "invalid-version"
  | "invalid-entry"
  | "duplicate-capability"
  | "duplicate-node"
  | "invalid-integrity"
  | "harness-too-old";

export interface PluginManifestDefect {
  readonly code: PluginManifestDefectCode;
  readonly field: string;
  readonly message: string;
}

export interface DeclaredPluginNode {
  readonly type: string;
  readonly version: Version;
  readonly title: string;
}

export interface PluginPackageIntegrity {
  readonly algorithm: "sha256";
  /** Package-relative POSIX path to lowercase hex digest. */
  readonly files: Readonly<Record<string, string>>;
}

export interface PluginPackageManifest {
  readonly manifestVersion: typeof PLUGIN_PACKAGE_MANIFEST_VERSION;
  readonly id: string;
  readonly name: string;
  readonly version: Version;
  readonly apiVersion: number;
  /** SPDX-style identifier. Required: an installable package must state its terms. */
  readonly license: string;
  readonly description?: string;
  readonly homepage?: string;
  /** Package-relative module path imported to obtain the plugin. */
  readonly entry: string;
  /** Minimum harness version, as `major.minor.patch`. */
  readonly minHarnessVersion?: string;
  /**
   * Capabilities the package asks for.
   *
   * A request is never a grant. The host's permission policy decides
   * separately, and a package that asks for everything receives nothing extra.
   */
  readonly requestedCapabilities: readonly CapabilityId[];
  /**
   * Node types this package claims to register.
   *
   * The loader verifies the claim after activation: a package that registers a
   * node it did not declare is refused, which is what makes the manifest worth
   * reading before installing.
   */
  readonly nodes: readonly DeclaredPluginNode[];
  readonly integrity?: PluginPackageIntegrity;
}

export interface PluginManifestValidation {
  readonly valid: boolean;
  readonly manifest: PluginPackageManifest | undefined;
  readonly defects: readonly PluginManifestDefect[];
}

/** Plugin ids are reverse-DNS-ish: lowercase, dot-separated, no path characters. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/u;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const NODE_TYPE_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_FIELD_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareSemver(left: string, right: string): number {
  const parse = (value: string): readonly number[] =>
    value
      .split(/[-+]/u)[0]
      ?.split(".")
      .map((part) => Number.parseInt(part, 10)) ?? [];
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = a[index] ?? 0;
    const rightPart = b[index] ?? 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/**
 * Validate a parsed manifest document.
 *
 * Every defect is collected rather than thrown one at a time, so a plugin
 * author fixing a manifest sees the whole list instead of discovering problems
 * one run at a time. This function performs no I/O and imports nothing from the
 * package it describes.
 */
export function validatePluginPackageManifest(
  document: unknown,
  options: { readonly harnessVersion?: string } = {},
): PluginManifestValidation {
  const defects: PluginManifestDefect[] = [];
  const fail = (code: PluginManifestDefectCode, field: string, message: string): void => {
    defects.push({ code, field, message });
  };

  if (!isRecord(document)) {
    return Object.freeze({
      valid: false,
      manifest: undefined,
      defects: Object.freeze([
        { code: "not-an-object" as const, field: ".", message: "Manifest must be a JSON object." },
      ]),
    });
  }

  const readString = (field: string, required: boolean): string | undefined => {
    const value = document[field];
    if (value === undefined || value === null) {
      if (required) fail("missing-field", field, `'${field}' is required.`);
      return undefined;
    }
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_FIELD_LENGTH) {
      fail("invalid-field", field, `'${field}' must be a non-empty string.`);
      return undefined;
    }
    return value;
  };

  if (document["manifestVersion"] !== PLUGIN_PACKAGE_MANIFEST_VERSION) {
    fail(
      "unsupported-manifest-version",
      "manifestVersion",
      `Only manifest version ${String(PLUGIN_PACKAGE_MANIFEST_VERSION)} is supported.`,
    );
  }

  const apiVersion = document["apiVersion"];
  if (apiVersion !== PLUGIN_API_VERSION) {
    fail(
      "unsupported-api-version",
      "apiVersion",
      `Plugin API version ${String(apiVersion)} is not supported by this harness.`,
    );
  }

  const id = readString("id", true);
  if (id !== undefined && !ID_PATTERN.test(id)) {
    fail(
      "invalid-id",
      "id",
      "Plugin id must be lowercase dot-separated segments without path characters.",
    );
  }

  const name = readString("name", true);
  const license = readString("license", true);
  readString("description", false);
  readString("homepage", false);

  const version = readString("version", true);
  if (version !== undefined && !SEMVER_PATTERN.test(version)) {
    fail("invalid-version", "version", "Plugin version must be major.minor.patch.");
  }

  const entry = readString("entry", true);
  if (entry !== undefined) {
    // The entry is joined onto the package directory, so it must not be able
    // to address anything outside it.
    const unsafe =
      entry.includes("..") ||
      entry.startsWith("/") ||
      entry.startsWith("\\") ||
      /^[A-Za-z]:/u.test(entry) ||
      entry.includes("\0");
    if (unsafe) {
      fail("invalid-entry", "entry", "Entry must be a relative path inside the package.");
    }
  }

  const minHarnessVersion = readString("minHarnessVersion", false);
  if (minHarnessVersion !== undefined) {
    if (!SEMVER_PATTERN.test(minHarnessVersion)) {
      fail("invalid-version", "minHarnessVersion", "minHarnessVersion must be major.minor.patch.");
    } else if (
      options.harnessVersion !== undefined &&
      compareSemver(options.harnessVersion, minHarnessVersion) < 0
    ) {
      fail(
        "harness-too-old",
        "minHarnessVersion",
        `Package requires harness ${minHarnessVersion}; this host is ${options.harnessVersion}.`,
      );
    }
  }

  const requestedCapabilities: CapabilityId[] = [];
  const rawCapabilities = document["requestedCapabilities"];
  if (rawCapabilities === undefined || rawCapabilities === null) {
    fail("missing-field", "requestedCapabilities", "'requestedCapabilities' is required.");
  } else if (!Array.isArray(rawCapabilities)) {
    fail("invalid-field", "requestedCapabilities", "'requestedCapabilities' must be an array.");
  } else {
    const seen = new Set<string>();
    for (const capability of rawCapabilities as readonly unknown[]) {
      if (typeof capability !== "string" || capability.length === 0) {
        fail("invalid-field", "requestedCapabilities", "Capabilities must be non-empty strings.");
        continue;
      }
      if (seen.has(capability)) {
        fail("duplicate-capability", "requestedCapabilities", `Duplicate '${capability}'.`);
        continue;
      }
      seen.add(capability);
      requestedCapabilities.push(capability);
    }
  }

  const nodes: DeclaredPluginNode[] = [];
  const rawNodes = document["nodes"];
  if (rawNodes === undefined || rawNodes === null) {
    fail("missing-field", "nodes", "'nodes' is required; use an empty array when none.");
  } else if (!Array.isArray(rawNodes)) {
    fail("invalid-field", "nodes", "'nodes' must be an array.");
  } else {
    const seen = new Set<string>();
    for (const entryValue of rawNodes as readonly unknown[]) {
      if (!isRecord(entryValue)) {
        fail("invalid-field", "nodes", "Each declared node must be an object.");
        continue;
      }
      const type = entryValue["type"];
      const nodeVersion = entryValue["version"];
      const title = entryValue["title"];
      if (typeof type !== "string" || !NODE_TYPE_PATTERN.test(type)) {
        fail("invalid-field", "nodes[].type", "Node type must be namespaced, like 'vendor.thing'.");
        continue;
      }
      if (typeof nodeVersion !== "string" || nodeVersion.length === 0) {
        fail("invalid-field", "nodes[].version", "Node version must be a non-empty string.");
        continue;
      }
      if (typeof title !== "string" || title.length === 0) {
        fail("invalid-field", "nodes[].title", "Node title must be a non-empty string.");
        continue;
      }
      const key = `${type}\0${nodeVersion}`;
      if (seen.has(key)) {
        fail("duplicate-node", "nodes", `Duplicate node '${type}' version '${nodeVersion}'.`);
        continue;
      }
      seen.add(key);
      nodes.push(Object.freeze({ type, version: nodeVersion, title }));
    }
  }

  let integrity: PluginPackageIntegrity | undefined;
  const rawIntegrity = document["integrity"];
  if (rawIntegrity !== undefined && rawIntegrity !== null) {
    if (!isRecord(rawIntegrity)) {
      fail("invalid-integrity", "integrity", "'integrity' must be an object.");
    } else if (rawIntegrity["algorithm"] !== "sha256") {
      fail("invalid-integrity", "integrity.algorithm", "Only sha256 is supported.");
    } else if (!isRecord(rawIntegrity["files"])) {
      fail("invalid-integrity", "integrity.files", "'integrity.files' must be an object.");
    } else {
      const files: Record<string, string> = {};
      for (const [path, digest] of Object.entries(rawIntegrity["files"])) {
        if (typeof digest !== "string" || !SHA256_PATTERN.test(digest)) {
          fail("invalid-integrity", "integrity.files", `Digest for '${path}' is not a sha256 hex.`);
          continue;
        }
        if (path.includes("..") || path.startsWith("/") || path.includes("\\")) {
          fail("invalid-integrity", "integrity.files", `Path '${path}' must stay in the package.`);
          continue;
        }
        files[path] = digest;
      }
      integrity = Object.freeze({ algorithm: "sha256" as const, files: Object.freeze(files) });
    }
  }

  if (defects.length > 0 || id === undefined || name === undefined) {
    return Object.freeze({ valid: false, manifest: undefined, defects: Object.freeze(defects) });
  }

  const description = document["description"];
  const homepage = document["homepage"];

  return Object.freeze({
    valid: true,
    defects: Object.freeze([]),
    manifest: Object.freeze({
      manifestVersion: PLUGIN_PACKAGE_MANIFEST_VERSION,
      id,
      name,
      version: version ?? "0.0.0",
      apiVersion: PLUGIN_API_VERSION,
      license: license ?? "UNLICENSED",
      ...(typeof description === "string" ? { description } : {}),
      ...(typeof homepage === "string" ? { homepage } : {}),
      entry: entry ?? "./index.js",
      ...(minHarnessVersion === undefined ? {} : { minHarnessVersion }),
      requestedCapabilities: Object.freeze(requestedCapabilities),
      nodes: Object.freeze(nodes),
      ...(integrity === undefined ? {} : { integrity }),
    }),
  });
}

export interface PluginInstallRecord {
  readonly manifest: PluginPackageManifest;
  /** Capabilities the host actually granted. Never derived from the request. */
  readonly grantedCapabilities: readonly CapabilityId[];
  /** Capabilities the package asked for and did not receive. */
  readonly withheldCapabilities: readonly CapabilityId[];
  readonly enabled: boolean;
}

/**
 * Reconcile a package's requests against what a host granted.
 *
 * Installing a package and granting it authority are separate decisions, so
 * this never turns a request into a grant. It reports the difference so a host
 * UI can show a plugin exactly what it asked for and did not get, and so a
 * plugin failing for lack of permission is explainable rather than mysterious.
 */
export function reconcilePluginGrants(
  manifest: PluginPackageManifest,
  grantedCapabilities: readonly CapabilityId[],
  enabled: boolean,
): PluginInstallRecord {
  const granted = new Set(grantedCapabilities);
  const effective = manifest.requestedCapabilities.filter((capability) => granted.has(capability));
  const withheld = manifest.requestedCapabilities.filter((capability) => !granted.has(capability));

  return Object.freeze({
    manifest,
    grantedCapabilities: Object.freeze(effective),
    withheldCapabilities: Object.freeze(withheld),
    enabled,
  });
}
