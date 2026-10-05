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
import { join, dirname, isAbsolute } from "node:path";
import {
  runBoundedProcess,
  type ProcessRunRequest,
  type ProcessRunResult,
} from "@zet-harness/tools";
import { isBlockedWorkspacePathSegment } from "./runtime-workspace-read-tools.js";

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
): Promise<ProcessRunResult> {
  request.signal?.throwIfAborted();
  const node =
    request.command === process.execPath && JSON.stringify(request.args) === '["--version"]';
  const gitMode = request.command === "git" ? classifySafeGitArgs(request.args) : undefined;
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
  const rootHandle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const held: Awaited<ReturnType<typeof open>>[] = [rootHandle];
  const rootSource = `/proc/${process.pid}/fd/${rootHandle.fd}`;
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
      "--ro-bind",
      rootSource,
      "/workspace",
      "--chdir",
      "/workspace",
    );
    if (gitMode === "write") {
      const gitHandle = await open(
        join(rootSource, ".git"),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      held.push(gitHandle);
      args.push("--bind", `/proc/${process.pid}/fd/${gitHandle.fd}`, "/workspace/.git");
    }
    // Hide known credential paths, including descendants. Too large a scan fails closed.
    let entriesSeen = 0;
    async function mask(directory: string, relative: string): Promise<void> {
      for await (const entry of await opendir(directory)) {
        if (++entriesSeen > 2000) throw new Error("Workspace exceeds process sandbox scan limit.");
        const local = join(directory, entry.name);
        const target = `/workspace/${relative}${entry.name}`;
        if (entry.name === "node_modules") {
          if (entry.isSymbolicLink() || !entry.isDirectory())
            throw new Error("Linked dependency path cannot be sandboxed.");
          args.push("--tmpfs", target);
          continue;
        }
        if (entry.name === ".git" && relative === "" && entry.isDirectory()) {
          for (const name of ["config", "hooks", "logs"]) {
            const path = join(local, name);
            if (existsSync(path))
              args.push(
                ...((await lstat(path)).isDirectory()
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
    const result = await runner({
      command: "/usr/bin/bwrap",
      args,
      cwd: root,
      env: {},
      limits: { timeoutMs: 10000, maxOutputBytes: 65536, killGraceMs: 250 },
      ...(request.signal ? { signal: request.signal } : {}),
    });
    request.signal?.throwIfAborted();
    if (result.outcome !== "exited" || result.exitCode !== 0)
      throw new Error("Independent process sandbox execution failed; no host fallback.");
    return result;
  } finally {
    await Promise.all(held.map((handle) => handle.close()));
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
  options: { npmCliPath?: string; runner?: typeof runBoundedProcess; platform?: string } = {},
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
  let temporary: string | undefined;
  const rootHandle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let entries = 0;
  let bytes = 0;
  const dependencies: { source: string; target: string }[] = [];
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
              if (metadata.isSymbolicLink()) {
                const canonical = await realpath(entrySource);
                if (!canonical.startsWith(`${root}/`))
                  throw new Error("External dependency link refused.");
                await symlink(`/workspace/${canonical.slice(root.length + 1)}`, entryPrivate);
              } else if (metadata.isDirectory()) {
                const directory = await open(
                  entrySource,
                  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
                );
                dependencyHandles.push(directory);
                await mkdir(entryPrivate);
                const directorySource = `/proc/${process.pid}/fd/${directory.fd}`;
                if (installed.name === ".bin" || (container && installed.name.startsWith("@")))
                  await mountEntries(directorySource, entryTarget, entryPrivate, false);
                else dependencies.push({ source: directorySource, target: entryTarget });
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
    for (const dependency of dependencies)
      args.push("--ro-bind", dependency.source, dependency.target);
    for (const mask of masks) args.push(...mask);
    for (const [key, value] of Object.entries({
      PATH: "/zet-bin:/usr/bin:/bin",
      HOME: "/tmp",
      TMPDIR: "/tmp",
      npm_config_cache: "/tmp/npm-cache",
      npm_config_userconfig: "/dev/null",
      npm_config_globalconfig: "/dev/null",
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
    const result = await runner({
      command: "/usr/bin/bwrap",
      args,
      cwd: root,
      env: {},
      limits: { timeoutMs: 120_000, maxOutputBytes: 131_072, killGraceMs: 250 },
      ...(request.signal ? { signal: request.signal } : {}),
    });
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
