import type { ManagedWorktreeSandboxScope } from "./runtime-coding-worktrees.js";
import { randomUUID } from "node:crypto";
import { classifySafeGitArgs } from "./runtime-git-command.js";
import { tmpdir } from "node:os";
import {
  lstat,
  opendir,
  realpath,
  symlink,
  mkdtemp,
  mkdir,
  open,
  writeFile,
  rm,
} from "node:fs/promises";
import { existsSync, constants } from "node:fs";
import { join, dirname, isAbsolute, relative, sep, basename, resolve } from "node:path";
import {
  runBoundedProcess,
  runBoundedProcessWithDescriptors,
  type ProcessRunRequest,
  type ProcessRunResult,
} from "@zet-harness/tools";
import { isBlockedWorkspacePathSegment } from "./runtime-workspace-read-tools.js";

/** Trusted exact file exclusions, never globs or caller-controlled script flags. */
async function privateStatePaths(
  root: string,
  paths: readonly string[] = [],
  additionalMounts: readonly string[] = [],
): Promise<ReadonlySet<string>> {
  if (paths.length > 16) throw new Error("Private state exclusion limit exceeded.");
  const trustedPaths = [...paths];
  const result = new Set<string>();
  const exposed = [...additionalMounts];
  for (const mount of ["/usr", "/lib", "/lib64", "/bin"])
    if (existsSync(mount)) exposed.push(await realpath(mount));
  const executable = await realpath(process.execPath);
  for (const path of trustedPaths) {
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      path.length > 4096 ||
      path !== resolve(path) ||
      /[\x00-\x1f\x7f]/u.test(path)
    )
      throw new Error("Invalid private state path.");
    const canonical = join(await realpath(dirname(path)), basename(path));
    try {
      const stat = await lstat(canonical);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error("Linked private state refused.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      canonical === executable ||
      exposed.some((mount) => canonical === mount || canonical.startsWith(`${mount}/`))
    )
      throw new Error("Private state intersects trusted runtime mount.");
    const rel = relative(root, canonical);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) continue;
    if (!rel) throw new Error("Private state path cannot be the workspace.");
    result.add(rel.split(sep).join("/"));
  }
  return result;
}
const GIT_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "status",
  "--porcelain=v1",
  "--ignore-submodules=all",
];

/** Fixed read-only processes inside a separate filesystem/network namespace. Never falls back to host execution. */
export async function runSandboxedProcess(
  request: ProcessRunRequest,
  runner: typeof runBoundedProcess = runBoundedProcess,
  platform: string = process.platform,
  managedScope?: ManagedWorktreeSandboxScope,
  privatePaths?: readonly string[],
): Promise<ProcessRunResult> {
  request.signal?.throwIfAborted();
  if (platform === "win32" && runner === runBoundedProcess) {
    if (privatePaths?.length)
      throw new Error("Windows private state masking unsupported by native sandbox.");
    const nodeVersion =
      request.command === process.execPath && JSON.stringify(request.args) === '["--version"]';
    const gitStatus =
      request.command === "git" && JSON.stringify(request.args) === JSON.stringify(GIT_ARGS);
    if (!nodeVersion && !gitStatus)
      throw new Error("Windows command unsupported by native sandbox.");
    const { executeWindowsSandboxedProjectCommand } =
      await import("./runtime-windows-process-sandbox.js");
    const trustedGitRoot = process.env["ZET_WINDOWS_GIT_ROOT"];
    return executeWindowsSandboxedProjectCommand(
      {
        cwd: request.cwd,
        command: nodeVersion ? "node-version" : "git-status",
        ...(request.signal ? { signal: request.signal } : {}),
      },
      trustedGitRoot ? { trustedGitRoot } : {},
    );
  }
  const node =
    request.command === process.execPath && JSON.stringify(request.args) === '["--version"]';
  const managed = managedScope ? await import("./runtime-coding-worktrees.js") : undefined;
  const managedMode = managed?.classifyManagedWorktreeArgs(request.args);
  if (managedScope && (request.command !== "git" || !managedMode || platform !== "linux"))
    throw new Error("Managed worktree sandbox request refused.");
  if (managedScope && managed) {
    if (managedMode === "write") {
      const permittedCreate =
        managedScope.pendingCreation &&
        JSON.stringify(request.args) ===
          JSON.stringify(
            managed.buildManagedWorktreeCommand("create", managedScope.pendingCreation),
          );
      const permittedRemove =
        !managedScope.pendingCreation &&
        managedScope.records.some(
          (record) =>
            record.phase === "owned" &&
            JSON.stringify(request.args) ===
              JSON.stringify(managed.buildManagedWorktreeCommand("remove", { name: record.name })),
        );
      if (!permittedCreate && !permittedRemove)
        throw new Error("Managed worktree action exceeds scoped ownership.");
    }
    const current = await managed.verifyManagedWorktreeOwnership(
      request.cwd,
      managedScope.journalPath,
      managedScope.pendingCreation,
    );
    if (JSON.stringify(current) !== JSON.stringify(managedScope))
      throw new Error("Managed worktree ownership changed.");
  }
  const gitMode =
    managedMode ?? (request.command === "git" ? classifySafeGitArgs(request.args) : undefined);
  const git =
    request.command === "git" &&
    (gitMode !== undefined || JSON.stringify(request.args) === JSON.stringify(GIT_ARGS));
  if (
    platform !== "linux" ||
    (!node && !git) ||
    (runner === runBoundedProcess && !existsSync("/usr/bin/bwrap"))
  )
    throw new Error("Independent process sandbox unavailable or request refused.");
  const root = await realpath(request.cwd);
  const privateFiles = await privateStatePaths(root, privatePaths);
  if (
    gitMode === "write" &&
    [...privateFiles].some(
      (path) => path.startsWith(".git/") || (managedScope && path.startsWith(".zet-worktrees/")),
    )
  )
    throw new Error("Private state intersects writable Git metadata or managed container.");
  const rootHandle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const held: Awaited<ReturnType<typeof open>>[] = [rootHandle];
  const rootSource = `/proc/${process.pid}/fd/${rootHandle.fd}`;
  const workspaceTarget = managedScope ? root : "/workspace";
  let emptyConfigDirectory: string | undefined;
  let emptyConfigHandle: Awaited<ReturnType<typeof open>> | undefined;
  if (managedScope) {
    const stat = await rootHandle.stat({ bigint: true });
    if (
      managedScope.root.path !== root ||
      String(stat.dev) !== managedScope.root.dev ||
      String(stat.ino) !== managedScope.root.ino
    ) {
      await rootHandle.close();
      throw new Error("Managed workspace identity changed.");
    }
  }
  try {
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--ro-bind",
      "/usr",
      "/usr",
    ];
    for (const path of ["/lib", "/lib64", "/bin"])
      if (existsSync(path)) args.push("--ro-bind", path, path);
    args.push(
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--ro-bind-fd",
      "3",
      workspaceTarget,
      "--chdir",
      workspaceTarget,
    );
    if (gitMode === "write") {
      const gitHandle = await open(
        join(rootSource, ".git"),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      held.push(gitHandle);
      if (managedScope) {
        const stat = await gitHandle.stat({ bigint: true });
        if (String(stat.dev) !== managedScope.git.dev || String(stat.ino) !== managedScope.git.ino)
          throw new Error("Managed Git identity changed.");
      }
      args.push("--bind-fd", String(3 + held.indexOf(gitHandle)), `${workspaceTarget}/.git`);
    }
    if (managedScope) {
      const container = await open(
        join(rootSource, ".zet-worktrees"),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      held.push(container);
      const stat = await container.stat({ bigint: true });
      if (
        String(stat.dev) !== managedScope.container.dev ||
        String(stat.ino) !== managedScope.container.ino
      )
        throw new Error("Managed container identity changed.");
      args.push(
        managedMode === "write" ? "--bind-fd" : "--ro-bind-fd",
        String(3 + held.indexOf(container)),
        `${workspaceTarget}/.zet-worktrees`,
      );
    }
    // Hide known credential paths, including descendants. Too large a scan fails closed.
    let entriesSeen = 0;
    async function mask(directory: string, relative: string): Promise<void> {
      for await (const entry of await opendir(directory)) {
        if (++entriesSeen > 2000) throw new Error("Workspace exceeds process sandbox scan limit.");
        const local = join(directory, entry.name);
        const target = `${workspaceTarget}/${relative}${entry.name}`;
        const metadata = await lstat(local);
        if (
          metadata.isSymbolicLink() ||
          (metadata.isFile() && metadata.nlink !== 1) ||
          (!metadata.isFile() && !metadata.isDirectory())
        )
          throw new Error("Linked or special workspace entry refused.");
        if (privateFiles.has(`${relative}${entry.name}`)) {
          if (!metadata.isFile()) throw new Error("Private state changed before masking.");
          args.push("--ro-bind", "/dev/null", target);
          continue;
        }
        if (
          managedScope?.records.some(
            (record) => record.gitFile?.path === join(root, `${relative}${entry.name}`),
          )
        )
          continue;
        if (managedScope && relative === "" && entry.name === ".zet-worktrees") {
          await mask(local, `${relative}${entry.name}/`);
          continue;
        }
        if (entry.name === "node_modules") {
          if (entry.isSymbolicLink() || !entry.isDirectory())
            throw new Error("Linked dependency path cannot be sandboxed.");
          args.push("--tmpfs", target);
          continue;
        }
        if (entry.name === ".git" && relative === "" && entry.isDirectory()) {
          for (const name of ["config", "hooks", "logs"]) {
            const path = join(local, name);
            if (!existsSync(path)) continue;
            const metadata = await lstat(path);
            if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory()))
              throw new Error("Linked Git metadata mask refused.");
            if (name === "config") {
              if (!metadata.isFile()) throw new Error("Invalid Git config entry.");
              if (!emptyConfigHandle) {
                emptyConfigDirectory = await mkdtemp(join(tmpdir(), "zet-git-config-mask-"));
                const file = join(emptyConfigDirectory, "config");
                await writeFile(file, "", { flag: "wx", mode: 0o644 });
                emptyConfigHandle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
                held.push(emptyConfigHandle);
              }
              args.push(
                "--ro-bind-fd",
                String(3 + held.indexOf(emptyConfigHandle)),
                `${target}/config`,
              );
            } else
              args.push(
                ...(metadata.isDirectory()
                  ? ["--tmpfs", `${target}/${name}`]
                  : ["--ro-bind", "/dev/null", `${target}/${name}`]),
              );
          }
          continue;
        }
        if (isBlockedWorkspacePathSegment(entry.name)) {
          if (entry.isSymbolicLink()) throw new Error("Linked sensitive path cannot be sandboxed.");
          args.push(
            ...(entry.isDirectory() ? ["--tmpfs", target] : ["--ro-bind", "/dev/null", target]),
          );
        } else if (entry.isDirectory() && !entry.isSymbolicLink())
          await mask(local, `${relative}${entry.name}/`);
      }
    }
    await mask(rootSource, "");
    // Mask absent sidecar names as well. If bwrap cannot create an exact mountpoint
    // beneath a read-only bind, startup fails closed rather than expose later files.
    for (const path of privateFiles)
      args.push("--ro-bind", "/dev/null", `${workspaceTarget}/${path}`);
    if (node) args.push("--ro-bind", await realpath(process.execPath), "/zet-node");
    for (const [key, value] of Object.entries({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_ALLOW_PROTOCOL: "none",
    }))
      args.push("--setenv", key, value);
    args.push("--", node ? "/zet-node" : "/usr/bin/git", ...request.args);
    if (managedScope && managed) {
      const current = await managed.verifyManagedWorktreeOwnership(
        root,
        managedScope.journalPath,
        managedScope.pendingCreation,
      );
      if (JSON.stringify(current) !== JSON.stringify(managedScope))
        throw new Error("Managed worktree ownership changed before execution.");
    }
    const boundedRequest: ProcessRunRequest = {
      command: "/usr/bin/bwrap",
      args,
      cwd: root,
      env: {},
      limits: { timeoutMs: managedScope ? 30000 : 10000, maxOutputBytes: 65536, killGraceMs: 250 },
      ...(request.signal ? { signal: request.signal } : {}),
    };
    const result =
      runner === runBoundedProcess
        ? await runBoundedProcessWithDescriptors(
            boundedRequest,
            held.map((handle) => handle.fd),
          )
        : await runner(boundedRequest);
    request.signal?.throwIfAborted();
    if (result.outcome !== "exited" || result.exitCode !== 0)
      throw new Error("Independent process sandbox execution failed; no host fallback.");
    return result;
  } finally {
    try {
      await Promise.all(held.map((handle) => handle.close()));
    } finally {
      if (emptyConfigDirectory) await rm(emptyConfigDirectory, { recursive: true, force: true });
    }
  }
}

export const PROJECT_COMMANDS = [
  "project-test",
  "project-build",
  "project-typecheck",
  "project-lint",
] as const;
export type ProjectCommand = (typeof PROJECT_COMMANDS)[number];
/** The npm CLI path is trusted host configuration, never a model-supplied executable. */
export async function runSandboxedProjectCommand(
  request: { cwd: string; command: ProjectCommand; signal?: AbortSignal },
  options: {
    npmCliPath?: string;
    runner?: typeof runBoundedProcess;
    platform?: string;
    privatePaths?: readonly string[];
  } = {},
): Promise<ProcessRunResult> {
  const runner = options.runner ?? runBoundedProcess;
  if (
    (options.platform ?? process.platform) !== "linux" ||
    !PROJECT_COMMANDS.includes(request.command) ||
    (runner === runBoundedProcess && !existsSync("/usr/bin/bwrap"))
  )
    throw new Error("Independent project sandbox unavailable or request refused.");
  request.signal?.throwIfAborted();
  const npmPath = options.npmCliPath ?? process.env["ZET_NPM_CLI"];
  if (!npmPath || !isAbsolute(npmPath) || !npmPath.endsWith("/bin/npm-cli.js"))
    throw new Error("Configure trusted ZET_NPM_CLI for project commands.");
  const npmCli = await realpath(npmPath);
  const npmRoot = dirname(dirname(npmCli));
  const root = await realpath(request.cwd);
  const privateFiles = await privateStatePaths(root, options.privatePaths, [npmRoot]);
  let temporary: string | undefined;
  const rootHandle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let entries = 0;
  let bytes = 0;
  const dependencies: { fd: number; target: string }[] = [];
  const dependencyHandles: Awaited<ReturnType<typeof open>>[] = [];
  const masks: string[][] = [];
  try {
    temporary = await mkdtemp(join(tmpdir(), "zet-project-sandbox-"));
    const snapshot = join(temporary, "project");
    await mkdir(snapshot);
    const started = Date.now();
    async function scanDependencies(directory: string, target: string): Promise<void> {
      request.signal?.throwIfAborted();
      for await (const entry of await opendir(directory)) {
        if (++entries > 100_000 || Date.now() - started > 10_000)
          throw new Error("Project sandbox metadata limit exceeded.");
        if ([".cache", ".vite"].includes(entry.name)) continue;
        const local = join(directory, entry.name);
        const destination = `${target}/${entry.name}`;
        const stat = await lstat(local);
        const workspaceRelative = destination.slice("/workspace/".length);
        if (privateFiles.has(workspaceRelative)) {
          if (!stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink())
            throw new Error("Linked private dependency refused.");
          masks.push(["--ro-bind", "/dev/null", destination]);
          continue;
        }
        if (isBlockedWorkspacePathSegment(entry.name)) {
          if (stat.isSymbolicLink()) throw new Error("Linked credential dependency refused.");
          masks.push(
            stat.isDirectory() ? ["--tmpfs", destination] : ["--ro-bind", "/dev/null", destination],
          );
          continue;
        }
        if (stat.isSymbolicLink()) {
          const canonical = await realpath(local);
          if (!canonical.startsWith(`${root}/`))
            throw new Error("External dependency link refused.");
          if (privateFiles.has(canonical.slice(root.length + 1)))
            throw new Error("Private dependency alias refused.");
        } else if (stat.isDirectory()) {
          const child = await open(
            local,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            await scanDependencies(`/proc/self/fd/${child.fd}`, destination);
          } finally {
            await child.close();
          }
        } else if (!stat.isFile() || stat.nlink !== 1)
          throw new Error("Unsupported dependency entry.");
      }
    }
    async function copy(directoryFd: number, relative: string, destination: string): Promise<void> {
      request.signal?.throwIfAborted();
      const descriptor = `/proc/self/fd/${directoryFd}`;
      for await (const entry of await opendir(descriptor)) {
        if (++entries > 100_000 || Date.now() - started > 10_000)
          throw new Error("Project sandbox metadata limit exceeded.");
        if (
          isBlockedWorkspacePathSegment(entry.name) ||
          [".next", ".turbo", ".cache", "coverage"].includes(entry.name)
        )
          continue;
        const local = `${descriptor}/${entry.name}`;
        const targetRelative = `${relative}${entry.name}`;
        const stat = await lstat(local);
        if (privateFiles.has(targetRelative)) {
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
            throw new Error("Linked private snapshot entry refused.");
          continue;
        }
        if (stat.isSymbolicLink()) throw new Error("Source links refused in project snapshot.");
        if (entry.name === "node_modules" && stat.isDirectory()) {
          const dependency = await open(
            local,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          dependencyHandles.push(dependency);
          const dependencySource = `/proc/self/fd/${dependency.fd}`;
          const dependencyTarget = `/workspace/${targetRelative}`;
          const privateDirectory = join(destination, entry.name);
          await mkdir(privateDirectory);
          await scanDependencies(dependencySource, dependencyTarget);
          async function mountEntries(
            source: string,
            target: string,
            privatePath: string,
            container: boolean,
          ): Promise<void> {
            for await (const installed of await opendir(source)) {
              request.signal?.throwIfAborted();
              if (++entries > 100_000 || Date.now() - started > 10_000)
                throw new Error("Project sandbox metadata limit exceeded.");
              if (
                isBlockedWorkspacePathSegment(installed.name) ||
                [".cache", ".vite"].includes(installed.name)
              )
                continue;
              const entrySource = join(source, installed.name);
              const entryTarget = `${target}/${installed.name}`;
              const entryPrivate = join(privatePath, installed.name);
              const metadata = await lstat(entrySource);
              if (privateFiles.has(entryTarget.slice("/workspace/".length))) {
                if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
                  throw new Error("Linked private dependency refused.");
                continue;
              }
              if (metadata.isSymbolicLink()) {
                const canonical = await realpath(entrySource);
                if (!canonical.startsWith(`${root}/`))
                  throw new Error("External dependency link refused.");
                if (privateFiles.has(canonical.slice(root.length + 1)))
                  throw new Error("Private dependency alias refused.");
                await symlink(`/workspace/${canonical.slice(root.length + 1)}`, entryPrivate);
              } else if (metadata.isDirectory()) {
                const directory = await open(
                  entrySource,
                  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
                );
                dependencyHandles.push(directory);
                await mkdir(entryPrivate);
                const directorySource = `/proc/${process.pid}/fd/${directory.fd}`;
                const containsPrivateState = [...privateFiles].some((path) =>
                  path.startsWith(`${entryTarget.slice("/workspace/".length)}/`),
                );
                if (
                  containsPrivateState ||
                  installed.name === ".bin" ||
                  (container && installed.name.startsWith("@"))
                )
                  await mountEntries(directorySource, entryTarget, entryPrivate, false);
                else dependencies.push({ fd: directory.fd, target: entryTarget });
              } else {
                if (!metadata.isFile() || metadata.nlink !== 1)
                  throw new Error("Unsupported dependency entry.");
                const file = await open(
                  entrySource,
                  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
                );
                try {
                  const expected = await file.stat();
                  const content = await readProjectSnapshotBytes(file, expected, request.signal);
                  if ((bytes += content.length) > 67_108_864)
                    throw new Error("Project snapshot file limit exceeded.");
                  await writeFile(entryPrivate, content, { mode: expected.mode & 0o777 });
                } finally {
                  await file.close();
                }
              }
            }
          }
          await mountEntries(dependencySource, dependencyTarget, privateDirectory, true);
        } else if (stat.isDirectory()) {
          const handle = await open(
            local,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            await mkdir(join(destination, entry.name));
            await copy(handle.fd, `${targetRelative}/`, join(destination, entry.name));
          } finally {
            await handle.close();
          }
        } else {
          if (!stat.isFile() || stat.nlink !== 1)
            throw new Error("Project snapshot file limit exceeded.");
          const handle = await open(
            local,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const current = await handle.stat();
            if (
              !current.isFile() ||
              current.nlink !== 1 ||
              current.size > 8_388_608 ||
              (bytes += current.size) > 67_108_864
            )
              throw new Error("Project snapshot file limit exceeded.");
            const content = await readProjectSnapshotBytes(handle, current, request.signal);
            await writeFile(join(destination, entry.name), content, { mode: current.mode & 0o777 });
          } finally {
            await handle.close();
          }
        }
      }
    }
    await copy(rootHandle.fd, "", snapshot);
    const script = request.command.slice("project-".length);
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--ro-bind",
      "/usr",
      "/usr",
    ];
    for (const path of ["/lib", "/lib64", "/bin"])
      if (existsSync(path)) args.push("--ro-bind", path, path);
    args.push(
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--bind",
      snapshot,
      "/workspace",
      "--ro-bind",
      await realpath(process.execPath),
      "/zet-node",
      "--ro-bind",
      npmRoot,
      "/zet-npm",
      "--dir",
      "/zet-bin",
      "--symlink",
      "/zet-node",
      "/zet-bin/node",
      "--symlink",
      "/zet-npm/bin/npm-cli.js",
      "/zet-bin/npm",
      "--symlink",
      "/zet-npm/bin/npx-cli.js",
      "/zet-bin/npx",
      "--chdir",
      "/workspace",
    );
    const inheritedDependencyFDs = dependencies.map((dependency) => dependency.fd);
    for (const dependency of dependencies)
      args.push(
        "--ro-bind-fd",
        String(3 + inheritedDependencyFDs.indexOf(dependency.fd)),
        dependency.target,
      );
    for (const mask of masks) args.push(...mask);
    for (const [key, value] of Object.entries({
      PATH: "/zet-bin:/usr/bin:/bin",
      HOME: "/tmp",
      TMPDIR: "/tmp",
      npm_config_cache: "/tmp/npm-cache",
      npm_config_userconfig: "/tmp/zet-user.npmrc",
      npm_config_globalconfig: "/tmp/zet-global.npmrc",
      npm_config_update_notifier: "false",
      npm_config_audit: "false",
      npm_config_fund: "false",
      CI: "1",
    }))
      args.push("--setenv", key, value);
    const marker = `ZET_SANDBOX_READY_${randomUUID()}`;
    args.push(
      "--",
      "/bin/sh",
      "-c",
      'printf "%s\\n" "$1" >&2; shift; exec "$@"',
      "zet-project",
      marker,
      "/zet-node",
      "/zet-npm/bin/npm-cli.js",
      "run",
      "--ignore-scripts",
      script,
    );
    const boundedRequest: ProcessRunRequest = {
      command: "/usr/bin/bwrap",
      args,
      cwd: root,
      env: {},
      limits: { timeoutMs: 120_000, maxOutputBytes: 131_072, killGraceMs: 250 },
      ...(request.signal ? { signal: request.signal } : {}),
    };
    const result =
      runner === runBoundedProcess
        ? await runBoundedProcessWithDescriptors(boundedRequest, inheritedDependencyFDs)
        : await runner(boundedRequest);
    request.signal?.throwIfAborted();
    if (result.outcome !== "exited" || !result.stderr.startsWith(`${marker}\n`))
      throw new Error("Project sandbox execution interrupted; no host fallback.");
    // Nonzero script exit is useful test/build evidence and is returned, never retried on the host.
    return { ...result, stderr: result.stderr.slice(marker.length + 1) };
  } finally {
    await Promise.all(dependencyHandles.map((handle) => handle.close()));
    await rootHandle.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

/** Read at most the approved initial size plus one byte; concurrent growth cannot allocate unbounded memory. */
export async function readProjectSnapshotBytes(
  handle: {
    read(
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ): Promise<{ bytesRead: number }>;
    stat(): Promise<{ size: number; mtimeMs: number; nlink: number }>;
  },
  expected: { size: number; mtimeMs: number; nlink: number },
  signal?: AbortSignal,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(expected.size) ||
    expected.size < 0 ||
    expected.size > 8_388_608 ||
    expected.nlink !== 1
  )
    throw new Error("Project snapshot file limit exceeded.");
  const buffer = Buffer.alloc(expected.size + 1);
  let length = 0;
  while (length < buffer.length) {
    signal?.throwIfAborted();
    const read = await handle.read(buffer, length, buffer.length - length, length);
    if (read.bytesRead === 0) break;
    if (
      !Number.isInteger(read.bytesRead) ||
      read.bytesRead < 0 ||
      read.bytesRead > buffer.length - length
    )
      throw new Error("Project snapshot read refused.");
    length += read.bytesRead;
  }
  const final = await handle.stat();
  if (
    length !== expected.size ||
    final.size !== expected.size ||
    final.mtimeMs !== expected.mtimeMs ||
    final.nlink !== 1
  )
    throw new Error("Project changed during snapshot.");
  return buffer.subarray(0, length);
}

/** Approved managed worktree effects get only their owned container and Git metadata writable. */
export async function runSandboxedManagedWorktree(
  request: ProcessRunRequest,
  scope: ManagedWorktreeSandboxScope,
  privatePaths?: readonly string[],
): Promise<ProcessRunResult> {
  return runSandboxedProcess(request, runBoundedProcess, process.platform, scope, privatePaths);
}
