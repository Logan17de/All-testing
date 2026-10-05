import { lstat, opendir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  const git =
    request.command === "git" && JSON.stringify(request.args) === JSON.stringify(GIT_ARGS);
  if (
    platform !== "linux" ||
    (!node && !git) ||
    (runner === runBoundedProcess && !existsSync("/usr/bin/bwrap"))
  )
    throw new Error("Independent process sandbox unavailable or request refused.");
  const root = await realpath(request.cwd);
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
    root,
    "/workspace",
    "--chdir",
    "/workspace",
  );
  // Hide known credential paths, including descendants. Too large a scan fails closed.
  let entriesSeen = 0;
  async function mask(directory: string, relative: string): Promise<void> {
    for await (const entry of await opendir(directory)) {
      if (++entriesSeen > 2000) throw new Error("Workspace exceeds process sandbox scan limit.");
      const local = join(directory, entry.name);
      const target = `/workspace/${relative}${entry.name}`;
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
  await mask(root, "");
  if (node) args.push("--ro-bind", await realpath(process.execPath), "/zet-node");
  for (const [key, value] of Object.entries({
    PATH: "/usr/bin:/bin",
    HOME: "/tmp",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
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
}
