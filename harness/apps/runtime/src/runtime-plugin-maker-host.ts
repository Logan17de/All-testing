import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { validatePluginConfig, validatePluginPackageManifest } from "@zet-harness/core";
import type { MakerArtifact, MakerFile } from "./runtime-plugin-maker.js";
import type { RuntimePluginOptions } from "./runtime-plugins.js";
import { runSandboxedProjectCommand } from "./runtime-process-sandbox.js";
import {
  createWorkspacePrivateGuard,
  isBlockedWorkspacePathSegment,
} from "./runtime-workspace-read-tools.js";

export interface PluginMakerHostApproval {
  readonly action: "materialize" | "test" | "enable";
  readonly hash: string;
  readonly directory: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly requestedCapabilities: readonly string[];
  readonly confirmTrustedCodeExecution?: true;
}
export type PluginMakerOperationAuthority =
  AbortSignal | { readonly signal: AbortSignal; readonly check: () => void };
function operationSignal(value: PluginMakerOperationAuthority): AbortSignal {
  return "signal" in value ? value.signal : value;
}
export interface PluginMakerHostOptions {
  readonly workspaceRoot: () => string;
  readonly scopeGeneration: () => string | number;
  readonly privatePaths: () => readonly string[];
  readonly pluginOptions: () => RuntimePluginOptions;
  readonly approve: (request: PluginMakerHostApproval, signal: AbortSignal) => Promise<boolean>;
  /** Test injection only; production defaults to the required OS sandbox. */
  readonly sandbox?: typeof runSandboxedProjectCommand;
}
const refused = () => new Error("Plugin maker host request refused.");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function denyPrivateOverlap(target: string, privatePaths: readonly string[]) {
  const candidate = resolve(target);
  if (
    privatePaths.some((value) => {
      const path = resolve(value);
      return (
        candidate === path ||
        candidate.startsWith(`${path}${sep}`) ||
        path.startsWith(`${candidate}${sep}`)
      );
    })
  )
    throw refused();
}
function components(value: string): string[] {
  if (!value || value.length > 4096 || isAbsolute(value) || /[\\:\x00]/u.test(value))
    throw refused();
  const result = value.split("/");
  if (
    result.length > 16 ||
    result.some(
      (part) =>
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/u.test(part) ||
        part === "." ||
        part === ".." ||
        isBlockedWorkspacePathSegment(part),
    )
  )
    throw refused();
  return result;
}
function snapshot(source: MakerArtifact): MakerArtifact {
  let value: MakerArtifact;
  try {
    value = JSON.parse(JSON.stringify(source)) as MakerArtifact;
  } catch {
    throw refused();
  }
  if (
    value.quarantined !== true ||
    value.enabled !== false ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 20
  )
    throw refused();
  let bytes = 0;
  const names = new Set<string>();
  const files: readonly MakerFile[] = value.files as readonly MakerFile[];
  for (const file of files) {
    components(file.path);
    if (
      names.has(file.path.toLowerCase()) ||
      typeof file.content !== "string" ||
      file.content.includes("\0") ||
      Buffer.byteLength(file.content) > 65536 ||
      (bytes += Buffer.byteLength(file.content)) > 262144 ||
      digest(file.content) !== file.sha256
    )
      throw refused();
    names.add(file.path.toLowerCase());
    Object.freeze(file);
  }
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (digest(JSON.stringify(sorted.map((file) => [file.path, file.sha256]))) !== value.hash)
    throw refused();
  const manifestFile = sorted.find((file) => file.path === "zet-plugin.json");
  if (!manifestFile) throw refused();
  const validation = validatePluginPackageManifest(JSON.parse(manifestFile.content));
  if (
    !validation.valid ||
    !validation.manifest ||
    !names.has(validation.manifest.entry.replace(/^\.\//u, ""))
  )
    throw refused();
  if (
    JSON.stringify(validation.manifest.requestedCapabilities ?? []) !==
    JSON.stringify(value.requestedCapabilities)
  )
    throw refused();
  return Object.freeze({
    ...value,
    files: Object.freeze(sorted),
    requestedCapabilities: Object.freeze([...value.requestedCapabilities]),
  });
}
async function read(handle: FileHandle, max: number): Promise<Buffer> {
  const before = await handle.stat();
  if (!before.isFile() || before.nlink !== 1 || before.size > max) throw refused();
  const result = Buffer.alloc(before.size + 1);
  let offset = 0;
  while (offset < result.length) {
    const count = (await handle.read(result, offset, result.length - offset, offset)).bytesRead;
    if (!count) break;
    offset += count;
  }
  const after = await handle.stat();
  if (
    offset !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.nlink !== 1
  )
    throw refused();
  return result.subarray(0, offset);
}
class Directory {
  readonly handles: FileHandle[] = [];
  constructor(readonly root: string) {}
  async open() {
    if (
      process.platform !== "linux" ||
      !isAbsolute(this.root) ||
      resolve(this.root) !== this.root ||
      (await realpath(this.root)) !== this.root
    )
      throw refused();
    let current = "/";
    for (const part of this.root.split("/").filter(Boolean)) {
      current = join(current, part);
      this.handles.push(
        await open(
          this.handles.length ? join(this.path, part) : current,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
      );
    }
    if (!this.handles.length) throw refused();
    return this;
  }
  get path() {
    return `/proc/self/fd/${this.handles.at(-1)!.fd}`;
  }
  async descend(
    parts: readonly string[],
    create = false,
    existing = false,
    check: () => void = () => {},
  ) {
    for (const part of parts) {
      check();
      if (create) {
        try {
          await mkdir(join(this.path, part), { mode: 0o700 });
        } catch (error) {
          if (!existing || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        check();
      }
      this.handles.push(
        await open(
          join(this.path, part),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
      );
    }
    return this;
  }
  async close() {
    await Promise.all(this.handles.map((handle) => handle.close()));
  }
}
async function exact(directory: Directory, artifact: MakerArtifact) {
  const expected = new Map(artifact.files.map((file) => [file.path, file.sha256]));
  const expectedDirectories = new Set(
    artifact.files.flatMap((file) =>
      file.path
        .split("/")
        .slice(0, -1)
        .map((_, index) =>
          file.path
            .split("/")
            .slice(0, index + 1)
            .join("/"),
        ),
    ),
  );
  let count = 0;
  async function scan(path: string, prefix = "") {
    for (const name of await readdir(path)) {
      if (++count > 100) throw refused();
      const key = `${prefix}${name}`;
      const info = await lstat(join(path, name));
      if (info.isSymbolicLink()) throw refused();
      if (info.isDirectory()) {
        if (!expectedDirectories.has(key)) throw refused();
        const handle = await open(
          join(path, name),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await scan(`/proc/self/fd/${handle.fd}`, `${key}/`);
        } finally {
          await handle.close();
        }
      } else {
        if (!expected.has(key)) throw refused();
        const handle = await open(
          join(path, name),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          if (digest(await read(handle, 65536)) !== expected.get(key)) throw refused();
        } finally {
          await handle.close();
        }
        expected.delete(key);
      }
    }
  }
  await scan(directory.path);
  if (expected.size) throw refused();
}
async function copy(
  directory: Directory,
  artifact: MakerArtifact,
  signal: AbortSignal,
  check: () => void,
) {
  const created = new Set<string>();
  for (const file of artifact.files) {
    check();
    signal.throwIfAborted();
    const parts = components(file.path);
    let parent = directory.path;
    const held: FileHandle[] = [];
    try {
      for (let index = 0; index < parts.length - 1; index++) {
        const key = parts.slice(0, index + 1).join("/");
        if (!created.has(key)) {
          check();
          signal.throwIfAborted();
          await mkdir(join(parent, parts[index]!), { mode: 0o700 });
          created.add(key);
        }
        const handle = await open(
          join(parent, parts[index]!),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        held.push(handle);
        parent = `/proc/self/fd/${handle.fd}`;
      }
      check();
      signal.throwIfAborted();
      const handle = await open(
        join(parent, parts.at(-1)!),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        check();
        signal.throwIfAborted();
        await handle.writeFile(file.content);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } finally {
      await Promise.all(held.map((handle) => handle.close()));
    }
  }
  check();
  await exact(directory, artifact);
  check();
}
export function createRuntimePluginMakerHost(
  options: PluginMakerHostOptions,
  humanAuthority: object,
) {
  const tested = new Set<string>();
  let busy = false;
  async function action<T>(
    authority: object,
    source: MakerArtifact,
    selected: string,
    control: PluginMakerOperationAuthority,
    operation: (artifact: MakerArtifact, root: string, check: () => void) => Promise<T>,
  ): Promise<T> {
    const signal = operationSignal(control);
    if (authority !== humanAuthority || busy || process.platform !== "linux") throw refused();
    signal.throwIfAborted();
    const artifact = snapshot(source);
    components(selected);
    const root = options.workspaceRoot(),
      generation = options.scopeGeneration(),
      privatePaths = Object.freeze([...options.privatePaths()]);
    const check = () => {
      signal.throwIfAborted();
      if ("check" in control) control.check();
      if (
        root !== options.workspaceRoot() ||
        generation !== options.scopeGeneration() ||
        JSON.stringify(privatePaths) !== JSON.stringify(options.privatePaths())
      )
        throw refused();
    };
    const guard = createWorkspacePrivateGuard(privatePaths);
    busy = true;
    try {
      denyPrivateOverlap(join(root, selected), privatePaths);
      await guard.assertAllowed(join(root, selected));
      for (const file of artifact.files) await guard.assertAllowed(join(root, selected, file.path));
      check();
      return await operation(artifact, root, check);
    } catch {
      signal.throwIfAborted();
      throw refused();
    } finally {
      busy = false;
    }
  }
  async function approve(
    kind: PluginMakerHostApproval["action"],
    artifact: MakerArtifact,
    directory: string,
    signal: AbortSignal,
    check: () => void,
    execute = false,
  ) {
    const request = Object.freeze({
      action: kind,
      hash: artifact.hash,
      directory,
      files: Object.freeze(
        artifact.files.map((file) => Object.freeze({ path: file.path, sha256: file.sha256 })),
      ),
      requestedCapabilities: artifact.requestedCapabilities,
      ...(execute ? { confirmTrustedCodeExecution: true as const } : {}),
    });
    if (!(await options.approve(request, signal))) throw refused();
    check();
  }
  const key = (artifact: MakerArtifact, root: string, selected: string) =>
    JSON.stringify([options.scopeGeneration(), root, selected, artifact.hash]);
  return Object.freeze({
    materialize(
      authority: object,
      artifact: MakerArtifact,
      directory: string,
      control: PluginMakerOperationAuthority,
    ) {
      const signal = operationSignal(control);
      return action(authority, artifact, directory, control, async (value, root, check) => {
        await approve("materialize", value, directory, signal, check);
        const parts = components(directory),
          handle = new Directory(root);
        try {
          await handle.open();
          await handle.descend(parts.slice(0, -1), true, true, check);
          check();
          await handle.descend(parts.slice(-1), true);
          await copy(handle, value, signal, check);
          return { hash: value.hash, directory, enabled: false as const };
        } finally {
          await handle.close();
        }
      });
    },
    test(
      authority: object,
      artifact: MakerArtifact,
      directory: string,
      control: PluginMakerOperationAuthority,
    ) {
      const signal = operationSignal(control);
      return action(authority, artifact, directory, control, async (value, root, check) => {
        const handle = new Directory(root);
        try {
          await handle.open();
          await handle.descend(components(directory));
          await exact(handle, value);
          check();
          const packageFile = value.files.find((file) => file.path === "package.json");
          const config = packageFile
            ? (JSON.parse(packageFile.content) as Record<string, unknown>)
            : undefined;
          if (
            !config ||
            JSON.stringify(config.scripts) !== JSON.stringify({ test: "node --test test.mjs" }) ||
            ["dependencies", "devDependencies", "optionalDependencies"].some(
              (name) => config[name] !== undefined,
            )
          )
            throw refused();
          await approve("test", value, directory, signal, check, true);
          await exact(handle, value);
          check();
          const temporary = await mkdtemp(join(tmpdir(), "zet-maker-test-"));
          const privateCopy = new Directory(temporary);
          let result;
          try {
            await privateCopy.open();
            await copy(privateCopy, value, signal, check);
            check();
            result = await (options.sandbox ?? runSandboxedProjectCommand)(
              {
                cwd: temporary,
                command: "project-test",
                signal,
              },
              { privatePaths: Object.freeze([...options.privatePaths()]) },
            );
            check();
            await exact(privateCopy, value);
          } finally {
            await privateCopy.close();
            await rm(temporary, { recursive: true, force: true });
          }
          check();
          await exact(handle, value);
          check();
          if (
            result.outcome !== "exited" ||
            result.exitCode !== 0 ||
            result.stdoutTruncated ||
            result.stderrTruncated
          )
            throw refused();
          if (tested.size >= 100) throw refused();
          tested.add(key(value, root, directory));
          return {
            hash: value.hash,
            executed: true as const,
            passed: true as const,
            mode: "required-os-sandbox" as const,
          };
        } finally {
          await handle.close();
        }
      });
    },
    enable(
      authority: object,
      artifact: MakerArtifact,
      directory: string,
      consent: { confirmTrustedCodeExecution: true },
      control: PluginMakerOperationAuthority,
    ) {
      const signal = operationSignal(control);
      return action(authority, artifact, directory, control, async (value, root, check) => {
        if (
          consent.confirmTrustedCodeExecution !== true ||
          !tested.has(key(value, root, directory))
        )
          throw refused();
        const pluginOptions = Object.freeze({ ...options.pluginOptions() });
        if (!pluginOptions.directory) throw refused();
        const declaredManifest = validatePluginPackageManifest(
          JSON.parse(value.files.find((file) => file.path === "zet-plugin.json")!.content),
        ).manifest!;
        if (pluginOptions.requireIntegrity === true && !declaredManifest.integrity) throw refused();
        if (
          declaredManifest.integrity &&
          Object.entries(declaredManifest.integrity.files).some(
            ([path, hash]) =>
              !value.files.some((file) => file.path === path && file.sha256 === hash),
          )
        )
          throw refused();
        const installRoot = resolve(pluginOptions.directory),
          configPath = resolve(pluginOptions.configPath ?? join(installRoot, "plugins.json"));
        if (
          dirname(configPath) !== installRoot ||
          relative(root, installRoot) === "" ||
          !(
            relative(root, installRoot) === ".." ||
            relative(root, installRoot).startsWith(`..${sep}`)
          ) ||
          !(
            relative(installRoot, root) === ".." ||
            relative(installRoot, root).startsWith(`..${sep}`)
          )
        )
          throw refused();
        const guard = createWorkspacePrivateGuard(options.privatePaths());
        denyPrivateOverlap(installRoot, options.privatePaths());
        await guard.assertAllowed(installRoot);
        await guard.assertAllowed(configPath);
        const sourceHandle = new Directory(root),
          installHandle = new Directory(installRoot),
          target = new Directory(installRoot);
        let lock: FileHandle | undefined;
        try {
          await sourceHandle.open();
          await sourceHandle.descend(components(directory));
          await exact(sourceHandle, value);
          check();
          await approve("enable", value, directory, signal, check, true);
          if (JSON.stringify(pluginOptions) !== JSON.stringify(options.pluginOptions()))
            throw refused();
          await exact(sourceHandle, value);
          check();
          await installHandle.open();
          const configName = basename(configPath);
          components(configName);
          check();
          lock = await open(
            join(installHandle.path, `${configName}.lock`),
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          );
          let original: Buffer | undefined;
          try {
            const handle = await open(
              join(installHandle.path, configName),
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              original = await read(handle, 262144);
            } finally {
              await handle.close();
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          const document = original
            ? (JSON.parse(original.toString("utf8")) as { plugins?: unknown[] })
            : {};
          if (!validatePluginConfig(document).valid) throw refused();
          const manifest = validatePluginPackageManifest(
            JSON.parse(value.files.find((file) => file.path === "zet-plugin.json")!.content),
          ).manifest!;
          const entries = document.plugins ?? [];
          if (entries.some((entry) => (entry as { id?: string }).id === manifest.id))
            throw refused();
          const child = await open(
            `${installHandle.path}/.`,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          target.handles.push(child);
          check();
          await target.descend([manifest.id], true);
          await copy(target, value, signal, check);
          async function save(enabled: boolean) {
            check();
            if (JSON.stringify(pluginOptions) !== JSON.stringify(options.pluginOptions()))
              throw refused();
            await exact(target, value);
            check();
            const temporary = `${configName}.${randomUUID()}.tmp`;
            const handle = await open(
              join(installHandle.path, temporary),
              constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
              0o600,
            );
            try {
              check();
              await handle.writeFile(
                JSON.stringify(
                  {
                    ...document,
                    plugins: [...entries, { id: manifest.id, enabled, grantedCapabilities: [] }],
                  },
                  null,
                  2,
                ) + "\n",
              );
              await handle.sync();
            } finally {
              await handle.close();
            }
            try {
              let current: Buffer | undefined;
              try {
                const existing = await open(
                  join(installHandle.path, configName),
                  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
                );
                try {
                  current = await read(existing, 262144);
                } finally {
                  await existing.close();
                }
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              }
              if (original?.toString("hex") !== current?.toString("hex")) throw refused();
              check();
              if (JSON.stringify(pluginOptions) !== JSON.stringify(options.pluginOptions()))
                throw refused();
              await rename(
                join(installHandle.path, temporary),
                join(installHandle.path, configName),
              );
              const updated = await open(
                join(installHandle.path, configName),
                constants.O_RDONLY | constants.O_NOFOLLOW,
              );
              try {
                original = await read(updated, 262144);
              } finally {
                await updated.close();
              }
            } finally {
              await unlink(join(installHandle.path, temporary)).catch(() => undefined);
            }
          }
          await save(false);
          check();
          await exact(sourceHandle, value);
          await save(true);
          tested.delete(key(value, root, directory));
          return {
            hash: value.hash,
            id: manifest.id,
            enabled: true as const,
            grantedCapabilities: [],
            restartRequired: true as const,
          };
        } finally {
          if (lock) {
            await lock.close();
            await unlink(join(installHandle.path, `${basename(configPath)}.lock`)).catch(
              () => undefined,
            );
          }
          await target.close();
          await sourceHandle.close();
          await installHandle.close();
        }
      });
    },
  });
}
