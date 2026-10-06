import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import type { ProcessRunResult } from "@zet-harness/tools";
import { bridge } from "./runtime-windows-process-sandbox.js";

export const WINDOWS_PROJECT_COMMANDS = [
  "project-test",
  "project-build",
  "project-typecheck",
  "project-lint",
] as const;
export type WindowsProjectCommand = (typeof WINDOWS_PROJECT_COMMANDS)[number];

/** Native fixed-command entry point; availability requires exact-head kernel acceptance. */
export async function executeWindowsSandboxedProjectScript(
  request: { cwd: string; command: WindowsProjectCommand; signal?: AbortSignal },
  options: { npmCliPath?: string; privatePaths?: readonly string[] } = {},
): Promise<ProcessRunResult> {
  const snapshot = Object.freeze({
    cwd: request.cwd,
    command: request.command,
    signal: request.signal,
  });
  const privatePaths = Object.freeze([...(options.privatePaths ?? [])]);
  const npmPath = options.npmCliPath ?? process.env["ZET_NPM_CLI"];
  if (process.platform !== "win32" || !WINDOWS_PROJECT_COMMANDS.includes(snapshot.command))
    throw new Error("Windows project sandbox unavailable or command unsupported.");
  snapshot.signal?.throwIfAborted();
  if (!npmPath || !isAbsolute(npmPath) || !/[\\/]bin[\\/]npm-cli\.js$/iu.test(npmPath))
    throw new Error("Configure trusted ZET_NPM_CLI for Windows project commands.");
  if (
    privatePaths.length > 16 ||
    privatePaths.some(
      (path) =>
        typeof path !== "string" ||
        !isAbsolute(path) ||
        path !== normalize(path) ||
        path.length > 4096 ||
        /[\x00-\x1f\x7f]/u.test(path),
    )
  )
    throw new Error("Invalid Windows private state path.");
  const npmCli = await realpath(npmPath);
  snapshot.signal?.throwIfAborted();
  return bridge(
    {
      mode: "run",
      command: snapshot.command,
      cwd: snapshot.cwd,
      node: process.execPath,
      npmRoot: dirname(dirname(npmCli)),
      exclusions: privatePaths.join("\n"),
      gitRoot: "",
    },
    snapshot.signal,
  );
}
