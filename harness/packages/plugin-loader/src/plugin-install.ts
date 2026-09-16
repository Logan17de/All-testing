import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { discoverPluginPackages } from "./plugin-loader.js";

/**
 * Where a plugin package is coming from.
 *
 * Both kinds end in the same place: a directory under the plugins folder holding a
 * `zet-plugin.json` the loader can read. Nothing is imported or enabled by
 * installing, so a package that arrives here can still do nothing at all.
 */
export type PluginInstallSource =
  | { readonly kind: "npm"; readonly spec: string }
  | { readonly kind: "git"; readonly url: string; readonly ref?: string };

export type PluginInstallErrorCode =
  | "INSTALL_SOURCE_INVALID"
  | "INSTALL_NOT_ALLOWED"
  | "INSTALL_TOOL_MISSING"
  | "INSTALL_COMMAND_FAILED"
  | "INSTALL_NOT_A_PLUGIN"
  | "INSTALL_ALREADY_PRESENT";

export class PluginInstallError extends Error {
  readonly code: PluginInstallErrorCode;
  /** What the tool said, when a tool said anything. */
  readonly detail: string | undefined;

  constructor(code: PluginInstallErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "PluginInstallError";
    this.code = code;
    this.detail = detail;
  }
}

export interface PluginProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** How installation runs a tool. Injected in tests, so no test reaches the network. */
export type PluginProcessRunner = (
  tool: "npm" | "git",
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
) => Promise<PluginProcessResult>;

export interface PluginInstallOptions {
  /** Absolute directory holding one subdirectory per plugin package. */
  readonly pluginsDirectory: string;
  readonly source: PluginInstallSource;
  /**
   * Which sources this host allows. Installing runs a package manager, which is a
   * real capability, so neither is on unless the host says so.
   */
  readonly allow?: { readonly npm?: boolean; readonly git?: boolean };
  readonly run?: PluginProcessRunner;
  readonly timeoutMs?: number;
  /** Replace a package of the same name that is already installed. */
  readonly replace?: boolean;
  readonly harnessVersion?: string;
}

export interface InstalledPluginPackage {
  /** The directory the package now occupies, under the plugins folder. */
  readonly packageName: string;
  readonly directory: string;
  /** Where it came from, as `npm:name@version` or `git:url#ref`. */
  readonly source: string;
  readonly pluginId: string;
  readonly version: string;
  /** Always false: installing a plugin never enables it or grants it anything. */
  readonly enabled: false;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** A package name npm would accept, and nothing that could be read as a flag. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const NPM_VERSION = /^[A-Za-z0-9.^~><=+|*-]{1,64}$/u;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

function invalid(message: string): PluginInstallError {
  return new PluginInstallError("INSTALL_SOURCE_INVALID", message);
}

/** Split `name@version`, keeping a scope's own `@` where it belongs. */
export function parseNpmSpec(spec: string): { readonly name: string; readonly version?: string } {
  const trimmed = spec.trim();
  if (trimmed.length === 0 || trimmed.length > 214) {
    throw invalid("An npm package name is between 1 and 214 characters.");
  }
  if (trimmed.startsWith("-")) throw invalid("A package name cannot start with '-'.");
  const separator = trimmed.lastIndexOf("@");
  const hasVersion = separator > 0;
  const name = hasVersion ? trimmed.slice(0, separator) : trimmed;
  const version = hasVersion ? trimmed.slice(separator + 1) : undefined;
  if (!NPM_NAME.test(name)) throw invalid(`'${name}' is not an npm package name.`);
  if (version !== undefined && !NPM_VERSION.test(version)) {
    throw invalid(`'${version}' is not a version or range.`);
  }
  return version === undefined ? { name } : { name, version };
}

/** The https URL of a repository, with nothing that could be read as a flag. */
export function parseGitSource(
  url: string,
  ref?: string,
): { readonly url: URL; readonly ref?: string } {
  const trimmed = url.trim();
  if (trimmed.startsWith("-")) throw invalid("A repository URL cannot start with '-'.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw invalid("A repository URL must be a URL.");
  }
  if (parsed.protocol !== "https:") {
    throw invalid("Only https repository URLs are installed, so no ssh key or agent is involved.");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw invalid("A repository URL must not carry credentials.");
  }
  if (ref !== undefined && !GIT_REF.test(ref)) {
    throw invalid(`'${ref}' is not a branch, tag or commit.`);
  }
  return ref === undefined ? { url: parsed } : { url: parsed, ref };
}

/** npm's own JavaScript entry, so `npm.cmd` never needs a shell on Windows. */
function npmCliPath(): string | undefined {
  const nodeDirectory = dirname(process.execPath);
  const candidates = [
    join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDirectory, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** Run a tool with an argument list and no shell, so nothing in a spec is interpreted. */
export const defaultPluginProcessRunner: PluginProcessRunner = async (tool, args, options) => {
  const npmCli = tool === "npm" ? npmCliPath() : undefined;
  if (tool === "npm" && npmCli === undefined) {
    throw new PluginInstallError(
      "INSTALL_TOOL_MISSING",
      "npm could not be found next to this Node installation.",
    );
  }
  const command = tool === "npm" ? process.execPath : "git";
  const commandArgs = tool === "npm" ? [npmCli as string, ...args] : [...args];

  return await new Promise<PluginProcessResult>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(
        new PluginInstallError(
          "INSTALL_TOOL_MISSING",
          `${tool} could not be started.`,
          error.message,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
};

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** `@scope/name` becomes `scope-name`, so one package is one directory. */
function directoryNameFor(packageName: string): string {
  return packageName.replace(/^@/u, "").replace(/\//gu, "-");
}

/**
 * Install a plugin package from npm or a Git repository.
 *
 * Installing never imports the package, never runs its lifecycle scripts, and never
 * enables it: the package lands in the plugins directory, is checked by the same
 * discovery the loader uses, and waits there until a person enables it and grants it
 * what it asks for. A package that turns out not to be a plugin is removed again
 * rather than left behind.
 */
export async function installPluginPackage(
  options: PluginInstallOptions,
): Promise<InstalledPluginPackage> {
  const { pluginsDirectory, source } = options;
  if (!isAbsolute(pluginsDirectory)) {
    throw new TypeError("pluginsDirectory must be an absolute path.");
  }
  const run = options.run ?? defaultPluginProcessRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowed = source.kind === "npm" ? options.allow?.npm : options.allow?.git;
  if (allowed !== true) {
    throw new PluginInstallError(
      "INSTALL_NOT_ALLOWED",
      `This harness does not install plugins from ${source.kind}.`,
    );
  }

  const staging = await mkdtemp(join(pluginsDirectory, ".install-"));
  try {
    const staged =
      source.kind === "npm"
        ? await stageFromNpm(source.spec, staging, run, timeoutMs)
        : await stageFromGit(source, staging, run, timeoutMs);

    const manifest = await readJson(join(staged.directory, "zet-plugin.json"));
    if (manifest === undefined) {
      throw new PluginInstallError(
        "INSTALL_NOT_A_PLUGIN",
        "That package has no zet-plugin.json, so it is not a harness plugin.",
      );
    }

    const target = join(pluginsDirectory, staged.packageName);
    if (existsSync(target)) {
      if (options.replace !== true) {
        throw new PluginInstallError(
          "INSTALL_ALREADY_PRESENT",
          `'${staged.packageName}' is already installed. Remove it first, or ask to replace it.`,
        );
      }
      await rm(target, { recursive: true, force: true });
    }
    await rename(staged.directory, target);

    // The same reading the loader does at startup, before anything is imported.
    const discovered = await discoverPluginPackages({
      pluginsDirectory,
      ...(options.harnessVersion === undefined ? {} : { harnessVersion: options.harnessVersion }),
    });
    const found = discovered.packages.find((entry) => entry.directory === target);
    if (found === undefined) {
      const failure = discovered.failures.find((entry) => entry.packageName === staged.packageName);
      await rm(target, { recursive: true, force: true });
      throw new PluginInstallError(
        "INSTALL_NOT_A_PLUGIN",
        failure?.message ?? "That package could not be read as a plugin.",
        failure?.code,
      );
    }

    return Object.freeze({
      packageName: staged.packageName,
      directory: target,
      source: staged.source,
      pluginId: found.manifest.id,
      version: found.manifest.version,
      enabled: false,
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

interface StagedPackage {
  readonly directory: string;
  readonly packageName: string;
  readonly source: string;
}

async function stageFromNpm(
  spec: string,
  staging: string,
  run: PluginProcessRunner,
  timeoutMs: number,
): Promise<StagedPackage> {
  const { name, version } = parseNpmSpec(spec);
  const requested = version === undefined ? name : `${name}@${version}`;
  // --ignore-scripts: a package's install hooks must never run on the way in.
  const result = await run(
    "npm",
    [
      "install",
      requested,
      "--prefix",
      staging,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    { cwd: staging, timeoutMs },
  );
  if (result.code !== 0) {
    throw new PluginInstallError(
      "INSTALL_COMMAND_FAILED",
      `npm could not install '${requested}'.`,
      result.stderr.trim() || result.stdout.trim(),
    );
  }
  const directory = join(staging, "node_modules", ...name.split("/"));
  if (!existsSync(directory)) {
    throw new PluginInstallError(
      "INSTALL_COMMAND_FAILED",
      `npm reported success but '${name}' is not there.`,
    );
  }
  const installed = await readJson(join(directory, "package.json"));
  const exact = typeof installed?.["version"] === "string" ? installed["version"] : "";
  return {
    directory,
    packageName: directoryNameFor(name),
    source: `npm:${name}${exact.length === 0 ? "" : `@${exact}`}`,
  };
}

async function stageFromGit(
  source: { readonly url: string; readonly ref?: string },
  staging: string,
  run: PluginProcessRunner,
  timeoutMs: number,
): Promise<StagedPackage> {
  const { url, ref } = parseGitSource(source.url, source.ref);
  const directory = join(staging, "clone");
  const result = await run(
    "git",
    [
      "clone",
      "--depth",
      "1",
      "--single-branch",
      ...(ref === undefined ? [] : ["--branch", ref]),
      url.href,
      directory,
    ],
    { cwd: staging, timeoutMs },
  );
  if (result.code !== 0) {
    throw new PluginInstallError(
      "INSTALL_COMMAND_FAILED",
      `git could not clone '${url.href}'.`,
      result.stderr.trim() || result.stdout.trim(),
    );
  }
  // The repository's own history is not part of the installed plugin.
  await rm(join(directory, ".git"), { recursive: true, force: true });

  const packageJson = await readJson(join(directory, "package.json"));
  const dependencies = packageJson?.["dependencies"];
  if (typeof dependencies === "object" && dependencies !== null) {
    const install = await run(
      "npm",
      [
        "install",
        "--prefix",
        directory,
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      { cwd: directory, timeoutMs },
    );
    if (install.code !== 0) {
      throw new PluginInstallError(
        "INSTALL_COMMAND_FAILED",
        "The repository's dependencies could not be installed.",
        install.stderr.trim() || install.stdout.trim(),
      );
    }
  }

  const name = typeof packageJson?.["name"] === "string" ? packageJson["name"] : "";
  const fallback = url.pathname.split("/").filter(Boolean).at(-1) ?? "plugin";
  const packageName = directoryNameFor(
    NPM_NAME.test(name) ? name : fallback.replace(/\.git$/u, ""),
  );
  return {
    directory,
    packageName,
    source: `git:${url.href}${ref === undefined ? "" : `#${ref}`}`,
  };
}
