/**
 * Where a harness reads its settings.
 *
 * Three sources, in this order: an environment variable wins over the config file,
 * which wins over the built-in default. That order is the useful one — a config file
 * is what someone set up once, and an environment variable is what they are doing
 * right now, for this run, on this machine.
 *
 * The file is optional. A harness with no config file at all is a working harness.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export const HARNESS_CONFIG_FILENAME = "harness.config.json" as const;
export const DEFAULT_RUNTIME_PORT = 3211;
export const DEFAULT_DATABASE_PATH = "data/zet-harness.sqlite";
export const DEFAULT_PLUGINS_PATH = "plugins";

/** What a config file may say. Everything is optional. */
export interface HarnessConfigFile {
  readonly runtime?: {
    readonly port?: number;
    readonly databasePath?: string;
    readonly pluginsDirectory?: string;
  };
  readonly plugins?: {
    /** Whether a plugin may be installed at runtime from npm or a Git repository. */
    readonly install?: { readonly npm?: boolean; readonly git?: boolean };
  };
}

/** The settings a runtime actually starts with, and where each one came from. */
export interface ResolvedRuntimeSettings {
  readonly port: number;
  readonly databasePath: string;
  readonly pluginsDirectory: string;
  readonly install: { readonly npm: boolean; readonly git: boolean };
  /** For each setting, whether it came from the environment, the file, or a default. */
  readonly sources: Readonly<Record<string, "environment" | "file" | "default">>;
}

export interface HarnessConfigRead {
  readonly config: HarnessConfigFile;
  /** Whether a file was there at all. */
  readonly present: boolean;
  /** Anything in the file that was ignored, said plainly. */
  readonly defects: readonly string[];
}

function port(value: unknown, defects: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    defects.push("runtime.port must be a whole number between 1 and 65535; it was ignored.");
    return undefined;
  }
  return value;
}

function path(value: unknown, field: string, defects: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    defects.push(`${field} must be a path; it was ignored.`);
    return undefined;
  }
  return value.trim();
}

function flag(value: unknown, field: string, defects: string[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    defects.push(`${field} must be true or false; it was ignored.`);
    return undefined;
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read a config document that was already parsed, keeping only what it understands. */
export function validateHarnessConfig(document: unknown): {
  readonly config: HarnessConfigFile;
  readonly defects: readonly string[];
} {
  const defects: string[] = [];
  const root = record(document);
  if (document !== undefined && root === undefined) {
    return {
      config: {},
      defects: Object.freeze([`${HARNESS_CONFIG_FILENAME} must hold a JSON object.`]),
    };
  }
  const runtime = record(root?.["runtime"]);
  const plugins = record(root?.["plugins"]);
  const install = record(plugins?.["install"]);

  const runtimePort = port(runtime?.["port"], defects);
  const databasePath = path(runtime?.["databasePath"], "runtime.databasePath", defects);
  const pluginsDirectory = path(runtime?.["pluginsDirectory"], "runtime.pluginsDirectory", defects);
  const npm = flag(install?.["npm"], "plugins.install.npm", defects);
  const git = flag(install?.["git"], "plugins.install.git", defects);

  const config: HarnessConfigFile = {
    ...(runtimePort === undefined && databasePath === undefined && pluginsDirectory === undefined
      ? {}
      : {
          runtime: {
            ...(runtimePort === undefined ? {} : { port: runtimePort }),
            ...(databasePath === undefined ? {} : { databasePath }),
            ...(pluginsDirectory === undefined ? {} : { pluginsDirectory }),
          },
        }),
    ...(npm === undefined && git === undefined
      ? {}
      : {
          plugins: {
            install: {
              ...(npm === undefined ? {} : { npm }),
              ...(git === undefined ? {} : { git }),
            },
          },
        }),
  };
  return { config, defects: Object.freeze(defects) };
}

/** Read the config file, if there is one. A missing file is not a problem. */
export async function readHarnessConfig(filePath: string): Promise<HarnessConfigRead> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return Object.freeze({ config: {}, present: false, defects: Object.freeze([]) });
  }
  let document: unknown;
  try {
    document = JSON.parse(raw) as unknown;
  } catch {
    return Object.freeze({
      config: {},
      present: true,
      defects: Object.freeze([`${HARNESS_CONFIG_FILENAME} is not valid JSON; it was ignored.`]),
    });
  }
  const { config, defects } = validateHarnessConfig(document);
  return Object.freeze({ config, present: true, defects });
}

/**
 * A port from the environment. `0` asks the system for any free port, which is how
 * the startup smoke runs beside a harness that is already listening on the default.
 */
function portFrom(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : undefined;
}

function booleanFrom(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

/** Settle the three sources into the settings a runtime starts with. */
export function resolveRuntimeSettings(
  config: HarnessConfigFile,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  root: string = process.cwd(),
): ResolvedRuntimeSettings {
  const absolute = (value: string): string => (isAbsolute(value) ? value : resolve(root, value));
  const sources: Record<string, "environment" | "file" | "default"> = {};
  const pick = <T>(
    name: string,
    fromEnvironment: T | undefined,
    fromFile: T | undefined,
    fallback: T,
  ): T => {
    if (fromEnvironment !== undefined) {
      sources[name] = "environment";
      return fromEnvironment;
    }
    if (fromFile !== undefined) {
      sources[name] = "file";
      return fromFile;
    }
    sources[name] = "default";
    return fallback;
  };

  const port = pick(
    "port",
    portFrom(environment["ZET_RUNTIME_PORT"]),
    config.runtime?.port,
    DEFAULT_RUNTIME_PORT,
  );
  const databasePath = pick(
    "databasePath",
    environment["ZET_RUNTIME_DB_PATH"],
    config.runtime?.databasePath,
    DEFAULT_DATABASE_PATH,
  );
  const pluginsDirectory = pick(
    "pluginsDirectory",
    environment["ZET_RUNTIME_PLUGINS_DIR"],
    config.runtime?.pluginsDirectory,
    DEFAULT_PLUGINS_PATH,
  );
  const npm = pick(
    "install.npm",
    booleanFrom(environment["ZET_RUNTIME_ALLOW_NPM_INSTALL"]),
    config.plugins?.install?.npm,
    false,
  );
  const git = pick(
    "install.git",
    booleanFrom(environment["ZET_RUNTIME_ALLOW_GIT_INSTALL"]),
    config.plugins?.install?.git,
    false,
  );

  return Object.freeze({
    port,
    databasePath: absolute(databasePath),
    pluginsDirectory: absolute(pluginsDirectory),
    install: Object.freeze({ npm, git }),
    sources: Object.freeze(sources),
  });
}
