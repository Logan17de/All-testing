import { constants } from "node:fs";
import { lstat, realpath, open, mkdir, rename, unlink, opendir } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, sep, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { isBlockedWorkspacePathSegment } from "./runtime-workspace-read-tools.js";
import type { AdapterInvocationContext, JsonObject, ToolAdapter } from "@zet-harness/plugin-api";
import type { ProcessRunRequest, ProcessRunResult } from "@zet-harness/tools";

export const MANAGED_WORKTREE_CONTAINER = ".zet-worktrees";
const PREFIX = [
  "--no-pager",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "submodule.recurse=false",
  "-c",
  "core.sparseCheckout=false",
  "-c",
  "core.protectNTFS=true",
  "-c",
  "core.protectHFS=true",
];
export type ManagedWorktreeOperation = "create" | "list" | "remove" | "inspect";
const refused = () => new Error("Managed worktree request refused or requires recovery.");
function name(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(value)) throw refused();
  return value;
}
export function buildManagedWorktreeCommand(
  operation: ManagedWorktreeOperation,
  input: JsonObject,
): readonly string[] {
  const keys =
    operation === "create"
      ? ["name", "commit"]
      : operation === "inspect"
        ? ["commit"]
        : operation === "remove"
          ? ["name"]
          : [];
  if (Object.keys(input).some((key) => !keys.includes(key))) throw refused();
  const commit =
    operation === "create" || operation === "inspect"
      ? typeof input.commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit)
        ? input.commit
        : (() => {
            throw refused();
          })()
      : undefined;
  const suffix =
    operation === "inspect"
      ? ["ls-tree", "-r", "-l", "-z", "--full-tree", commit!]
      : operation === "list"
        ? ["worktree", "list", "--porcelain", "-z"]
        : operation === "remove"
          ? ["worktree", "remove", "--", `${MANAGED_WORKTREE_CONTAINER}/${name(input.name)}`]
          : [
              "worktree",
              "add",
              "--detach",
              "--",
              `${MANAGED_WORKTREE_CONTAINER}/${name(input.name)}`,
              commit!,
            ];
  return Object.freeze([...PREFIX, ...suffix]);
}
export function classifyManagedWorktreeArgs(args: readonly string[]): "read" | "write" | undefined {
  if (JSON.stringify(args) === JSON.stringify(buildManagedWorktreeCommand("list", {})))
    return "read";
  try {
    if (
      JSON.stringify(args) ===
      JSON.stringify(buildManagedWorktreeCommand("inspect", { commit: args[PREFIX.length + 5]! }))
    )
      return "read";
  } catch {
    /* Unsupported object name. */
  }
  for (const operation of ["create", "remove"] as const) {
    const suffix = args.slice(PREFIX.length);
    try {
      const path = operation === "create" ? suffix[4] : suffix[3];
      if (!path?.startsWith(`${MANAGED_WORKTREE_CONTAINER}/`)) continue;
      const input: JsonObject = {
        name: path.slice(MANAGED_WORKTREE_CONTAINER.length + 1),
        ...(operation === "create" ? { commit: suffix[5]! } : {}),
      };
      if (JSON.stringify(args) === JSON.stringify(buildManagedWorktreeCommand(operation, input)))
        return "write";
    } catch {
      /* Unknown argv never gains write authority. */
    }
  }
  return undefined;
}

/** Fixed ls-tree output only. Bounds disk expansion and refuses credential names,
 * symlink/gitlink modes and portable path hazards before reserving a worktree. */
export function validateManagedWorktreeCheckout(result: ProcessRunResult): void {
  if (
    result.outcome !== "exited" ||
    result.exitCode !== 0 ||
    result.stdoutTruncated ||
    result.stderrTruncated ||
    (result.stdout && !result.stdout.endsWith("\0"))
  )
    throw refused();
  const entries = result.stdout.split("\0").filter(Boolean);
  if (entries.length > 10000) throw refused();
  let total = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    const match = entry.match(
      /^(100644|100755) blob (?:[a-f0-9]{40}|[a-f0-9]{64}) +([0-9]+)\t(.+)$/u,
    );
    if (!match) throw refused();
    const size = Number(match[2]);
    const path = match[3]!;
    if (
      !Number.isSafeInteger(size) ||
      size > 8388608 ||
      (total += size) > 67108864 ||
      Buffer.byteLength(path) > 1024 ||
      /[\\\x00-\x1f\x7f:]/u.test(path) ||
      path.startsWith("/") ||
      seen.has(path) ||
      path
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part === MANAGED_WORKTREE_CONTAINER ||
            isBlockedWorkspacePathSegment(part),
        )
    )
      throw refused();
    seen.add(path);
  }
}
export interface WorktreeAnchor {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
}
export interface ManagedWorktreeRecord {
  readonly name: string;
  readonly commit: string;
  readonly phase: "creating" | "owned";
  readonly tree?: WorktreeAnchor;
  readonly gitFile?: WorktreeAnchor;
  readonly admin?: WorktreeAnchor;
}
interface Journal {
  version: 1;
  root: WorktreeAnchor;
  container: WorktreeAnchor;
  records: ManagedWorktreeRecord[];
}
export interface ManagedWorktreeSandboxScope {
  readonly root: WorktreeAnchor;
  readonly container: WorktreeAnchor;
  readonly git: WorktreeAnchor;
  readonly journalPath: string;
  readonly records: readonly ManagedWorktreeRecord[];
  readonly pendingCreation?: { readonly name: string; readonly commit: string };
}
export interface RuntimeWorktreeToolOptions {
  readonly root: string;
  /** Host-private state outside the workspace; caller creates its private parent directory. */
  readonly journalPath: string;
  readonly approve: (
    request: { tool: string; args: JsonObject },
    context: AdapterInvocationContext,
  ) => Promise<boolean>;
  /** Required independent OS sandbox. No host runner or fallback is supplied by this module. */
  readonly sandbox: (
    request: ProcessRunRequest,
    scope: ManagedWorktreeSandboxScope,
  ) => Promise<ProcessRunResult>;
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
async function anchor(path: string, directory = true): Promise<WorktreeAnchor> {
  const stat = await lstat(path, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) ||
    (await realpath(path)) !== path
  )
    throw refused();
  return Object.freeze({ path, dev: String(stat.dev), ino: String(stat.ino) });
}
async function unchanged(expected: WorktreeAnchor, directory = true): Promise<void> {
  const actual = await anchor(expected.path, directory);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw refused();
}
async function boundedFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw refused();
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
function checkAnchor(value: unknown): asserts value is WorktreeAnchor {
  const record = value as WorktreeAnchor | undefined;
  if (
    !record ||
    typeof record.path !== "string" ||
    !isAbsolute(record.path) ||
    !/^[0-9]+$/.test(record.dev) ||
    !/^[0-9]+$/.test(record.ino)
  )
    throw refused();
}
async function journalLocation(root: string, path: string): Promise<void> {
  if (!isAbsolute(path) || inside(root, path) || (await realpath(dirname(path))) !== dirname(path))
    throw refused();
  const stat = await lstat(dirname(path));
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw refused();
}
async function load(root: string, path: string): Promise<Journal | undefined> {
  await journalLocation(root, path);
  let text: string;
  try {
    text = await boundedFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw refused();
  }
  const state = JSON.parse(text) as Journal;
  if (state.version !== 1 || !Array.isArray(state.records) || state.records.length > 16)
    throw refused();
  checkAnchor(state.root);
  checkAnchor(state.container);
  if (state.root.path !== root || state.container.path !== join(root, MANAGED_WORKTREE_CONTAINER))
    throw refused();
  const seen = new Set<string>();
  for (const record of state.records) {
    name(record.name);
    if (
      seen.has(record.name) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.commit) ||
      !["creating", "owned"].includes(record.phase)
    )
      throw refused();
    seen.add(record.name);
    if (record.phase === "owned") {
      checkAnchor(record.tree);
      checkAnchor(record.gitFile);
      checkAnchor(record.admin);
      if (
        record.tree.path !== join(state.container.path, record.name) ||
        record.gitFile.path !== join(record.tree.path, ".git") ||
        dirname(record.admin.path) !== join(root, ".git", "worktrees") ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(basename(record.admin.path))
      )
        throw refused();
    }
  }
  return state;
}
async function save(path: string, state: Journal): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
}
async function recordTree(
  root: string,
  container: string,
  worktreeName: string,
  commit: string,
): Promise<ManagedWorktreeRecord> {
  const tree = await anchor(join(container, worktreeName));
  const gitFile = await anchor(join(tree.path, ".git"), false);
  const pointer = (await boundedFile(gitFile.path)).match(/^gitdir: (.+)\n?$/)?.[1];
  if (
    !pointer ||
    dirname(pointer) !== join(root, ".git", "worktrees") ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(basename(pointer))
  )
    throw refused();
  const admin = await anchor(pointer);
  if (
    (await boundedFile(join(admin.path, "gitdir"))).trim() !== gitFile.path ||
    (await boundedFile(join(admin.path, "commondir"))).trim() !== "../.."
  )
    throw refused();
  return Object.freeze({ name: worktreeName, commit, phase: "owned", tree, gitFile, admin });
}
async function scopeFor(
  state: Journal,
  path: string,
  pendingCreation?: { readonly name: string; readonly commit: string },
): Promise<ManagedWorktreeSandboxScope> {
  await unchanged(state.root);
  await unchanged(state.container);
  const git = await anchor(join(state.root.path, ".git"));
  const expected = new Set(state.records.map((record) => record.name));
  for await (const entry of await opendir(state.container.path))
    if (!expected.has(entry.name)) throw refused();
  for (const record of state.records) {
    if (
      record.phase === "creating" &&
      pendingCreation?.name === record.name &&
      pendingCreation.commit === record.commit
    ) {
      try {
        await lstat(join(state.container.path, record.name));
        throw refused();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw refused();
      }
      continue;
    }
    if (record.phase !== "owned" || !record.tree || !record.gitFile || !record.admin)
      throw refused();
    await unchanged(record.tree);
    await unchanged(record.gitFile, false);
    await unchanged(record.admin);
    const current = await recordTree(
      state.root.path,
      state.container.path,
      record.name,
      record.commit,
    );
    if (JSON.stringify(current) !== JSON.stringify(record)) throw refused();
  }
  let metadataNodes = 0;
  const adminNames = new Set(
    state.records
      .filter((record) => record.phase === "owned")
      .map((record) => basename(record.admin!.path)),
  );
  async function metadataScan(directory: string, ownedAdmin = false): Promise<void> {
    for await (const entry of await opendir(directory)) {
      if (++metadataNodes > 5000) throw refused();
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (
        stat.isSymbolicLink() ||
        (stat.isFile() && stat.nlink !== 1) ||
        (!stat.isDirectory() && !stat.isFile())
      )
        throw refused();
      if (
        entry.name === "alternates" ||
        (!ownedAdmin && ["gitdir", "commondir"].includes(entry.name))
      )
        throw refused();
      if (entry.name === "worktrees" && directory === git.path) {
        if (!stat.isDirectory()) throw refused();
        for await (const adminEntry of await opendir(path)) {
          if (
            !adminNames.has(adminEntry.name) ||
            !adminEntry.isDirectory() ||
            adminEntry.isSymbolicLink()
          )
            throw refused();
          await metadataScan(join(path, adminEntry.name), true);
        }
      } else if (stat.isDirectory()) await metadataScan(path, ownedAdmin);
    }
  }
  await metadataScan(git.path);
  return Object.freeze({
    root: Object.freeze({ ...state.root }),
    container: Object.freeze({ ...state.container }),
    git,
    journalPath: path,
    ...(pendingCreation ? { pendingCreation: Object.freeze({ ...pendingCreation }) } : {}),
    records: Object.freeze(
      state.records.map((record) =>
        Object.freeze({
          ...record,
          ...(record.tree ? { tree: Object.freeze({ ...record.tree }) } : {}),
          ...(record.gitFile ? { gitFile: Object.freeze({ ...record.gitFile }) } : {}),
          ...(record.admin ? { admin: Object.freeze({ ...record.admin }) } : {}),
        }),
      ),
    ),
  });
}
/** Host-side ownership proof for narrow sandbox mounting and normal Git metadata validation. */
export async function verifyManagedWorktreeOwnership(
  root: string,
  journalPath: string,
  pendingCreation?: { readonly name: string; readonly commit: string },
): Promise<ManagedWorktreeSandboxScope> {
  const canonical = await realpath(root);
  if (canonical !== root) throw refused();
  const state = await load(root, journalPath);
  if (!state) throw refused();
  return scopeFor(state, journalPath, pendingCreation);
}

export function createRuntimeWorktreeTools(
  options: RuntimeWorktreeToolOptions,
): readonly ToolAdapter[] {
  options = Object.freeze({ ...options });
  return Object.freeze(
    (["create", "list", "remove"] as const).map((operation): ToolAdapter =>
      Object.freeze<ToolAdapter>({
        manifest: {
          id: `harness.git.worktree.${operation}`,
          version: "1",
          title: `Managed worktree ${operation}`,
          description:
            "Approved local detached worktrees in the owned container. Exact commit only; removal refuses dirty trees. Independent sandbox required, no hooks, shell, network, push or force deletion.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required:
              operation === "create" ? ["name", "commit"] : operation === "remove" ? ["name"] : [],
            properties:
              operation === "create"
                ? { name: { type: "string" }, commit: { type: "string" } }
                : operation === "remove"
                  ? { name: { type: "string" } }
                  : {},
          },
          outputSchema: { type: "object" },
          behavior: {
            primitiveFamily: "effect",
            determinism: "nondeterministic",
            effect: operation === "list" ? "external-read" : "external-write",
            idempotency: "unknown",
            recovery: "manual",
            executionMode: "in-process",
            requiredCapabilities: [operation === "list" ? "git:read" : "git:write"],
          },
        },
        async invoke(input, context) {
          context.signal.throwIfAborted();
          const snapshot = structuredClone(input);
          const args = buildManagedWorktreeCommand(operation, snapshot);
          let lock: Awaited<ReturnType<typeof open>> | undefined;
          try {
            const root = await realpath(options.root);
            if (root !== options.root) throw refused();
            const rootIdentity = await anchor(root);
            const gitIdentity = await anchor(join(root, ".git"));
            await journalLocation(root, options.journalPath);
            lock = await open(
              `${options.journalPath}.lock`,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            );
            let state = await load(root, options.journalPath);
            if (state) await scopeFor(state, options.journalPath);
            else {
              try {
                await lstat(join(root, MANAGED_WORKTREE_CONTAINER));
                throw refused();
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw refused();
              }
              if (operation !== "create") throw refused();
            }
            if (
              operation === "create" &&
              state &&
              (state.records.length >= 16 ||
                state.records.some((record) => record.name === snapshot.name))
            )
              throw refused();
            if (
              operation === "remove" &&
              !state?.records.some(
                (record) => record.name === snapshot.name && record.phase === "owned",
              )
            )
              throw refused();
            if (
              !(await options.approve(
                { tool: `harness.git.worktree.${operation}`, args: structuredClone(snapshot) },
                context,
              ))
            )
              throw refused();
            context.signal.throwIfAborted();
            await unchanged(rootIdentity);
            await unchanged(gitIdentity);
            if (!state) {
              await mkdir(join(root, MANAGED_WORKTREE_CONTAINER), { mode: 0o700 });
              state = {
                version: 1,
                root: rootIdentity,
                container: await anchor(join(root, MANAGED_WORKTREE_CONTAINER)),
                records: [],
              };
              await save(options.journalPath, state);
            }
            let scope = await scopeFor(state, options.journalPath);
            if (operation === "create") {
              const inspection = await options.sandbox(
                {
                  command: "git",
                  args: buildManagedWorktreeCommand("inspect", { commit: snapshot.commit! }),
                  cwd: root,
                  env: {},
                  signal: context.signal,
                  limits: { timeoutMs: 10000, maxOutputBytes: 1048576, killGraceMs: 250 },
                },
                scope,
              );
              context.signal.throwIfAborted();
              validateManagedWorktreeCheckout(inspection);
              await unchanged(rootIdentity);
              await unchanged(gitIdentity);
              scope = await scopeFor(state, options.journalPath);
              state.records.push({
                name: name(snapshot.name),
                commit: snapshot.commit as string,
                phase: "creating",
              });
              await save(options.journalPath, state);
              scope = await scopeFor(state, options.journalPath, {
                name: name(snapshot.name),
                commit: snapshot.commit as string,
              });
            }
            const result = await options.sandbox(
              {
                command: "git",
                args,
                cwd: root,
                env: {},
                signal: context.signal,
                limits: { timeoutMs: 10000, maxOutputBytes: 65536, killGraceMs: 250 },
              },
              scope,
            );
            context.signal.throwIfAborted();
            if (
              result.outcome !== "exited" ||
              result.exitCode !== 0 ||
              result.stdoutTruncated ||
              result.stderrTruncated
            )
              throw refused();
            await unchanged(rootIdentity);
            await unchanged(state.container);
            if (operation === "create") {
              const owned = await recordTree(
                root,
                state.container.path,
                name(snapshot.name),
                snapshot.commit as string,
              );
              state.records[state.records.length - 1] = owned;
              await save(options.journalPath, state);
            } else if (operation === "remove") {
              try {
                await lstat(join(state.container.path, name(snapshot.name)));
                throw refused();
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw refused();
              }
              state.records = state.records.filter((record) => record.name !== snapshot.name);
              await save(options.journalPath, state);
            }
            await scopeFor(state, options.journalPath);
            return {
              value: {
                worktrees: state.records.map((record) => ({
                  name: record.name,
                  commit: record.commit,
                  path: `${MANAGED_WORKTREE_CONTAINER}/${record.name}`,
                })),
              },
            };
          } catch {
            context.signal.throwIfAborted();
            throw refused();
          } finally {
            if (lock) {
              const held = await lock.stat({ bigint: true });
              await lock.close();
              const current = await lstat(`${options.journalPath}.lock`, { bigint: true }).catch(
                () => undefined,
              );
              if (current?.dev === held.dev && current.ino === held.ino)
                await unlink(`${options.journalPath}.lock`);
            }
          }
        },
      }),
    ),
  );
}
