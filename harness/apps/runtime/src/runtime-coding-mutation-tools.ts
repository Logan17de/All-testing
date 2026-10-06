import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { AdapterInvocationContext, JsonObject, ToolAdapter } from "@zet-harness/plugin-api";
import { createMinimalEnvironment, createWorkspacePathResolver } from "@zet-harness/tools";
import {
  runSandboxedProcess,
  runSandboxedProjectCommand,
  PROJECT_COMMANDS,
  type ProjectCommand,
} from "./runtime-process-sandbox.js";
import {
  createWorkspacePrivateGuard,
  isBlockedWorkspacePathSegment,
} from "./runtime-workspace-read-tools.js";

export interface RuntimeMutationToolOptions {
  readonly root: string;
  readonly privatePaths?: readonly string[];
  /** Host consent for this exact call. Must fail closed on restart or expiry. */
  readonly approve: (
    request: { tool: string; args: JsonObject },
    context: AdapterInvocationContext,
  ) => Promise<boolean>;
}
const refused = (): Error => new Error("Workspace mutation tool rejected the request.");

function writeParts(input: JsonObject): string[] {
  if (
    Object.keys(input).some((key) => key !== "path" && key !== "content") ||
    typeof input.path !== "string" ||
    typeof input.content !== "string" ||
    input.path.length > 4096 ||
    input.path.includes("\\") ||
    input.path.includes("\0") ||
    path.isAbsolute(input.path) ||
    input.content.includes("\0") ||
    Buffer.byteLength(input.content) > 65536
  )
    throw refused();
  const parts = input.path.split("/");
  if (
    !parts.length ||
    parts.some(
      (part) => !part || part === "." || part === ".." || isBlockedWorkspacePathSegment(part),
    )
  )
    throw refused();
  return parts;
}

// Existing directories only; descriptor-relative traversal never follows links.
// This application boundary is not an OS sandbox: a hostile process moving an
// already-open parent directory concurrently requires kernel isolation.
async function writeWorkspace(
  root: string,
  input: JsonObject,
  signal: AbortSignal,
  privateGuard: ReturnType<typeof createWorkspacePrivateGuard>,
): Promise<void> {
  if (process.platform !== "linux") throw refused();
  const parts = writeParts(input);
  const filename = parts.pop()!;
  const canonical = await realpath(root);
  if (canonical.split(path.sep).some(isBlockedWorkspacePathSegment)) throw refused();
  let directory: FileHandle | undefined;
  let temporary: string | undefined;
  try {
    directory = await open(
      canonical,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    for (const part of parts) {
      const next = await open(
        `/proc/self/fd/${directory.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await directory.close();
      directory = next;
    }
    const anchor = `/proc/self/fd/${directory.fd}`;
    const relative = path.relative(canonical, await realpath(anchor));
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).some(isBlockedWorkspacePathSegment)
    )
      throw refused();
    const destination = `${anchor}/${filename}`;
    await privateGuard.assertAllowed(destination);
    let mode = 0o600;
    try {
      const previous = await lstat(destination);
      await privateGuard.assertAllowed(destination, previous);
      if (!previous.isFile() || previous.nlink !== 1) throw refused();
      mode = previous.mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    signal.throwIfAborted();
    temporary = `${anchor}/.zet-write-${randomUUID()}`;
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(input.content as string, "utf8");
      await file.chmod(mode);
      await file.sync();
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    // Whole-file replacement avoids modifying a linked inode; a raced symlink
    // is replaced as a directory entry rather than followed.
    await privateGuard.assertAllowed(destination);
    signal.throwIfAborted();
    await rename(temporary, destination);
    temporary = undefined;
  } finally {
    if (temporary !== undefined) await rm(temporary, { force: true }).catch(() => undefined);
    await directory?.close();
  }
}

export function createRuntimeMutationTools(
  options: RuntimeMutationToolOptions,
): readonly ToolAdapter[] {
  const resolver = createWorkspacePathResolver({ root: options.root });
  const privateGuard = createWorkspacePrivateGuard(options.privatePaths);
  const behavior = {
    primitiveFamily: "effect",
    determinism: "nondeterministic",
    effect: "external-write",
    idempotency: "unknown",
    recovery: "manual",
    executionMode: "in-process",
  } as const;
  return Object.freeze(
    (["write", "exec"] as const).map((operation) => {
      const id = operation === "write" ? "harness.fs.write" : "harness.shell.run";
      const adapter: ToolAdapter = {
        manifest: {
          id,
          version: "1",
          title:
            operation === "write"
              ? "Write workspace file after consent"
              : "Run fixed diagnostic or project script after consent",
          description:
            operation === "write"
              ? "Replace/create one UTF-8 file up to 64 KiB after explicit approval. Existing parent directory required. Linux only; credentials and links refused."
              : "Run approved fixed diagnostics or npm test/build/typecheck/lint scripts with required native OS containment, no network or host fallback. Project scripts run in a bounded private source copy with read-only dependencies; generated outputs are discarded. Requires trusted ZET_NPM_CLI.",
          inputSchema:
            operation === "write"
              ? {
                  type: "object",
                  additionalProperties: false,
                  required: ["path", "content"],
                  properties: { path: { type: "string" }, content: { type: "string" } },
                }
              : {
                  type: "object",
                  additionalProperties: false,
                  required: ["command"],
                  properties: {
                    command: {
                      type: "string",
                      enum: ["node-version", "git-status", ...PROJECT_COMMANDS],
                    },
                  },
                },
          outputSchema: { type: "object" },
          behavior: {
            ...behavior,
            requiredCapabilities: [operation === "write" ? "fs:write" : "process:exec"],
          },
        },
        async invoke(input, context) {
          context.signal.throwIfAborted();
          // Only primitive fields qualify; the frozen snapshot is both approved
          // and executed, never the caller's mutable object after the await.
          let snapshot: JsonObject;
          if (operation === "write") {
            writeParts(input);
            resolver.resolveLexical(input.path as string);
            await privateGuard.assertAllowed(resolver.resolveLexical(input.path as string));
            snapshot = Object.freeze({
              path: input.path as string,
              content: input.content as string,
            });
          } else {
            if (
              Object.keys(input).length !== 1 ||
              !["node-version", "git-status", ...PROJECT_COMMANDS].includes(input.command as string)
            )
              throw refused();
            snapshot = Object.freeze({ command: input.command as string });
          }
          if (
            process.platform !== "linux" &&
            !(process.platform === "win32" && operation === "exec")
          )
            throw refused();
          let approved = false;
          try {
            approved = await options.approve(Object.freeze({ tool: id, args: snapshot }), context);
          } catch {
            context.signal.throwIfAborted();
            throw refused();
          }
          if (!approved) throw refused();
          context.signal.throwIfAborted();
          try {
            if (operation === "write") {
              await writeWorkspace(resolver.root, snapshot, context.signal, privateGuard);
              return {
                value: {
                  path: snapshot.path!,
                  writtenBytes: Buffer.byteLength(snapshot.content as string),
                },
              };
            }
            if (PROJECT_COMMANDS.includes(snapshot.command as ProjectCommand)) {
              const outcome = await runSandboxedProjectCommand(
                {
                  cwd: resolver.root,
                  command: snapshot.command as ProjectCommand,
                  signal: context.signal,
                },
                { privatePaths: privateGuard.paths },
              );
              context.signal.throwIfAborted();
              return {
                value: {
                  ...outcome,
                  executionWorkspace: "temporary-copy",
                  sourceWorkspaceModified: false,
                },
              };
            }
            const node = snapshot.command === "node-version";
            const outcome = await runSandboxedProcess(
              {
                command: node ? process.execPath : "git",
                args: node
                  ? ["--version"]
                  : [
                      "-c",
                      "core.fsmonitor=false",
                      "-c",
                      "core.untrackedCache=false",
                      "status",
                      "--porcelain=v1",
                      "--ignore-submodules=all",
                    ],
                cwd: resolver.root,
                env: createMinimalEnvironment({
                  GIT_CONFIG_NOSYSTEM: "1",
                  GIT_CONFIG_GLOBAL: "/dev/null",
                  GIT_OPTIONAL_LOCKS: "0",
                  GIT_TERMINAL_PROMPT: "0",
                }),
                signal: context.signal,
                limits: { timeoutMs: 10000, maxOutputBytes: 65536, killGraceMs: 250 },
              },
              undefined,
              undefined,
              undefined,
              privateGuard.paths,
            );
            context.signal.throwIfAborted();
            return { value: { ...outcome } };
          } catch {
            context.signal.throwIfAborted();
            throw refused();
          }
        },
      };
      return Object.freeze(adapter);
    }),
  );
}
