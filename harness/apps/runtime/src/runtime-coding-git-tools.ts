import { lstat, opendir, realpath, open } from "node:fs/promises";
import { constants } from "node:fs";
import { createWorkspacePrivateGuard } from "./runtime-workspace-read-tools.js";
import { join, relative, isAbsolute, sep } from "node:path";
import type { AdapterInvocationContext, JsonObject, ToolAdapter } from "@zet-harness/plugin-api";
import { runSandboxedProcess } from "./runtime-process-sandbox.js";
import { buildGitCommand, gitPaths } from "./runtime-git-command.js";

export interface RuntimeGitToolOptions {
  readonly root: string;
  readonly privatePaths?: readonly string[];
  readonly managedJournalPath?: string | undefined;
  readonly approve?: (
    request: { tool: string; args: JsonObject },
    context: AdapterInvocationContext,
  ) => Promise<boolean>;
  /** Test seam for the sandbox process boundary. Production always uses runSandboxedProcess. */
  readonly sandbox?: typeof runSandboxedProcess;
}
const refuse = () => new Error("Scoped Git tool rejected the request.");
async function validateRepository(root: string, journalPath?: string): Promise<string> {
  const canonical = await realpath(root);
  const metadata = join(canonical, ".git");
  if (!(await lstat(metadata)).isDirectory() || (await realpath(metadata)) !== metadata)
    throw refuse();
  let seen = 0;
  async function scan(directory: string): Promise<void> {
    for await (const entry of await opendir(directory)) {
      if (++seen > 5000) throw refuse();
      const file = join(directory, entry.name);
      const stat = await lstat(file);
      if (
        stat.isSymbolicLink() ||
        (stat.isFile() && stat.nlink !== 1) ||
        (!stat.isDirectory() && !stat.isFile())
      )
        throw refuse();
      if (entry.name === "worktrees" && file === join(metadata, "worktrees") && journalPath) {
        const { verifyManagedWorktreeOwnership } = await import("./runtime-coding-worktrees.js");
        await verifyManagedWorktreeOwnership(canonical, journalPath);
        continue;
      }
      if (["alternates", "commondir", "gitdir", "worktrees"].includes(entry.name)) throw refuse();
      if (stat.isDirectory()) await scan(file);
    }
  }
  await scan(metadata);
  return canonical;
}
async function validateFiles(
  root: string,
  paths: readonly string[],
  privateGuard: ReturnType<typeof createWorkspacePrivateGuard>,
): Promise<void> {
  for (const file of paths) {
    await privateGuard.assertAllowed(join(root, file));
    let current = root;
    for (const part of file.split("/")) {
      current = join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (stat.nlink > 1 && stat.isFile())) throw refuse();
    }
    const handle = await open(
      current,
      constants.O_RDONLY | (process.platform === "linux" ? constants.O_NOFOLLOW : 0),
    );
    try {
      const stat = await handle.stat();
      const canonical = await realpath(
        process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : current,
      );
      await privateGuard.assertAllowed(canonical, stat);
      const rel = relative(root, canonical);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        rel === ".." ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel)
      )
        throw refuse();
    } finally {
      await handle.close();
    }
  }
}
export function createRuntimeGitTools(options: RuntimeGitToolOptions): readonly ToolAdapter[] {
  const root = options.root;
  const privateGuard = createWorkspacePrivateGuard(options.privatePaths);
  const sandbox = options.sandbox ?? runSandboxedProcess;
  const approve = options.approve;
  return Object.freeze(
    (["status", "diff", "log", ...(approve ? ["add", "commit"] : [])] as const).map((operation) => {
      const write = operation === "add" || operation === "commit";
      const id = `harness.git.${operation}`;
      const tool: ToolAdapter = {
        manifest: {
          id,
          version: "1",
          title: `Scoped Git ${operation}`,
          description: write
            ? "Exact scoped Git mutation after per-call human approval, in required OS sandbox; no hooks, signing, network or push."
            : "Bounded local Git read in required OS sandbox. Diff requires explicit ordinary file paths; no external diff or textconv.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required:
              operation === "commit"
                ? ["paths", "message", "authorName", "authorEmail"]
                : operation === "diff" || operation === "add"
                  ? ["paths"]
                  : [],
            properties:
              operation === "commit"
                ? {
                    paths: { type: "array", items: { type: "string" } },
                    message: { type: "string" },
                    authorName: { type: "string" },
                    authorEmail: { type: "string" },
                  }
                : operation === "diff"
                  ? {
                      paths: { type: "array", items: { type: "string" } },
                      staged: { type: "boolean" },
                    }
                  : operation === "add"
                    ? { paths: { type: "array", items: { type: "string" } } }
                    : {},
          },
          outputSchema: { type: "object" },
          behavior: {
            primitiveFamily: "effect",
            determinism: "nondeterministic",
            effect: write ? "external-write" : "external-read",
            idempotency: "unknown",
            recovery: "manual",
            executionMode: "in-process",
            requiredCapabilities: [write ? "git:write" : "git:read"],
          },
        },
        async invoke(input, context) {
          context.signal.throwIfAborted();
          const snapshot = structuredClone(input);
          const args = buildGitCommand(
            operation as Parameters<typeof buildGitCommand>[0],
            snapshot,
          );
          const paths =
            operation === "add" || operation === "diff" || operation === "commit"
              ? gitPaths(snapshot.paths)
              : [];
          try {
            const canonical = await validateRepository(root, options.managedJournalPath);
            await validateFiles(canonical, paths, privateGuard);
            if (
              write &&
              (!approve || !(await approve({ tool: id, args: structuredClone(snapshot) }, context)))
            )
              throw refuse();
            context.signal.throwIfAborted();
            if ((await validateRepository(root, options.managedJournalPath)) !== canonical)
              throw refuse();
            await validateFiles(canonical, paths, privateGuard);
            const run = async (argv: readonly string[]) => {
              await validateFiles(canonical, paths, privateGuard);
              context.signal.throwIfAborted();
              return sandbox({
                command: "git",
                args: argv,
                cwd: canonical,
                env: {},
                signal: context.signal,
                limits: { timeoutMs: 10000, maxOutputBytes: 65536, killGraceMs: 250 },
              });
            };
            if (operation === "commit") {
              const staged = await run(buildGitCommand("staged-paths", {}));
              if (
                staged.outcome !== "exited" ||
                staged.exitCode !== 0 ||
                staged.stdoutTruncated ||
                staged.stderrTruncated
              )
                throw refuse();
              const names = staged.stdout.split("\0").filter(Boolean);
              if (names.length !== paths.length || names.some((name) => !paths.includes(name)))
                throw refuse();
            }
            const result = await run(args);
            context.signal.throwIfAborted();
            return { value: { ...result } };
          } catch {
            context.signal.throwIfAborted();
            throw refuse();
          }
        },
      };
      return Object.freeze(tool);
    }),
  );
}
