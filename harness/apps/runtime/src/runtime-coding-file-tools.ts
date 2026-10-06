import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { AdapterInvocationContext, JsonObject, ToolAdapter } from "@zet-harness/plugin-api";
import {
  createWorkspacePrivateGuard,
  isBlockedWorkspacePathSegment,
} from "./runtime-workspace-read-tools.js";
import { createWorkspacePathResolver } from "@zet-harness/tools";
import { executeWindowsCodingOperation } from "./runtime-windows-coding.js";
import type { RuntimeMutationToolOptions } from "./runtime-coding-mutation-tools.js";
const MAX_BYTES = 65_536;
const refused = (): Error => new Error("Workspace file operation rejected the request.");
function parts(value: unknown): string[] {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  )
    throw refused();
  const result = value.split("/");
  if (
    result.some(
      (part) => !part || part === "." || part === ".." || isBlockedWorkspacePathSegment(part),
    )
  )
    throw refused();
  return result;
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > MAX_BYTES ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  )
    throw refused();
  return value;
}
function patch(input: JsonObject): { snapshot: JsonObject; before: string; after: string } {
  if (Object.keys(input).some((key) => !["path", "expectedContent", "edits"].includes(key)))
    throw refused();
  parts(input.path);
  const before = text(input.expectedContent);
  if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > 20)
    throw refused();
  let after = before;
  const edits = input.edits.map((edit: unknown) => {
    if (
      !edit ||
      typeof edit !== "object" ||
      Array.isArray(edit) ||
      Object.keys(edit).some((key) => !["oldText", "newText"].includes(key))
    )
      throw refused();
    const fields = edit as Record<string, unknown>;
    const oldText = text(fields.oldText);
    const newText = text(fields.newText);
    if (!oldText) throw refused();
    const index = after.indexOf(oldText);
    if (index < 0 || after.indexOf(oldText, index + 1) >= 0) throw refused();
    after = after.slice(0, index) + newText + after.slice(index + oldText.length);
    text(after);
    return Object.freeze({ oldText, newText });
  });
  const snapshot: JsonObject = { path: input.path!, expectedContent: before, edits };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 196_608) throw refused();
  Object.freeze(edits);
  Object.freeze(snapshot);
  return { snapshot, before, after };
}
async function anchoredParent(root: string, fileParts: string[]): Promise<FileHandle> {
  const canonical = await realpath(root);
  if (canonical.split(path.sep).some(isBlockedWorkspacePathSegment)) throw refused();
  let current = await open(
    canonical,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const part of fileParts) {
      const next = await open(
        `/proc/self/fd/${current.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await current.close();
      current = next;
    }
    const relative = path.relative(canonical, await realpath(`/proc/self/fd/${current.fd}`));
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).some(isBlockedWorkspacePathSegment)
    )
      throw refused();
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}
async function replace(
  root: string,
  filePath: string,
  before: string,
  after: string,
  signal: AbortSignal,
  privateGuard: ReturnType<typeof createWorkspacePrivateGuard>,
): Promise<void> {
  const components = parts(filePath);
  const filename = components.pop()!;
  const parent = await anchoredParent(root, components);
  let temporary: string | undefined;
  try {
    const destination = `/proc/self/fd/${parent.fd}/${filename}`;
    const source = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    let mode: number;
    let inode: number;
    let device: number;
    try {
      const stat = await source.stat();
      await privateGuard.assertAllowed(await realpath(`/proc/self/fd/${source.fd}`), stat);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw refused();
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let count = 0;
      while (count < buffer.length) {
        const read = await source.read(buffer, count, buffer.length - count, count);
        if (read.bytesRead === 0) break;
        count += read.bytesRead;
      }
      if (count > MAX_BYTES || !buffer.subarray(0, count).equals(Buffer.from(before)))
        throw refused();
      mode = stat.mode & 0o777;
      inode = stat.ino;
      device = stat.dev;
    } finally {
      await source.close();
    }
    signal.throwIfAborted();
    temporary = `/proc/self/fd/${parent.fd}/.zet-patch-${randomUUID()}`;
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    try {
      await file.writeFile(after, "utf8");
      await file.chmod(mode);
      await file.sync();
    } finally {
      await file.close();
    }
    const current = await lstat(destination);
    await privateGuard.assertAllowed(destination, current);
    if (!current.isFile() || current.nlink !== 1 || current.ino !== inode || current.dev !== device)
      throw refused();
    signal.throwIfAborted();
    await rename(temporary, destination);
    temporary = undefined;
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
    await parent.close();
  }
}
async function makeDirectory(
  root: string,
  filePath: string,
  signal: AbortSignal,
  privateGuard: ReturnType<typeof createWorkspacePrivateGuard>,
): Promise<void> {
  const components = parts(filePath);
  const name = components.pop()!;
  const parent = await anchoredParent(root, components);
  try {
    signal.throwIfAborted();
    await privateGuard.assertAllowed(`/proc/self/fd/${parent.fd}/${name}`);
    signal.throwIfAborted();
    await mkdir(`/proc/self/fd/${parent.fd}/${name}`, { mode: 0o700 });
  } finally {
    await parent.close();
  }
}
type FileOperation = "apply_patch" | "mkdir" | "write" | "rename" | "delete";
function operationSnapshot(
  operation: FileOperation,
  input: JsonObject,
): { snapshot: JsonObject; before?: string; after?: string } {
  if (operation === "apply_patch") return patch(input);
  const fields =
    operation === "mkdir"
      ? ["path"]
      : operation === "write"
        ? ["path", "expectedContent", "content"]
        : operation === "rename"
          ? ["path", "to", "expectedContent"]
          : ["path", "expectedContent"];
  if (Object.keys(input).some((key) => !fields.includes(key))) throw refused();
  parts(input.path);
  if (operation === "mkdir") return { snapshot: Object.freeze({ path: input.path! }) };
  if (operation === "write") {
    if (!Object.hasOwn(input, "expectedContent")) throw refused();
    return {
      snapshot: Object.freeze({
        path: input.path!,
        expectedContent: input.expectedContent === null ? null : text(input.expectedContent),
        content: text(input.content),
      }),
    };
  }
  const expectedContent = text(input.expectedContent);
  if (operation === "rename") parts(input.to);
  return {
    snapshot: Object.freeze({
      path: input.path!,
      expectedContent,
      ...(operation === "rename" ? { to: input.to! } : {}),
    }),
  };
}
/** Exact consent precedes every effect; Windows mutations require locked expected content. */
export function createRuntimeCodingFileTools(
  options: RuntimeMutationToolOptions,
): readonly ToolAdapter[] {
  const resolver = createWorkspacePathResolver({ root: options.root });
  const privateGuard = createWorkspacePrivateGuard(options.privatePaths);
  const operations: readonly FileOperation[] =
    process.platform === "win32"
      ? ["apply_patch", "mkdir", "write", "rename", "delete"]
      : ["apply_patch", "mkdir"];
  return operations.map((operation): ToolAdapter => ({
    manifest: {
      id: `harness.fs.${operation}`,
      version: "1",
      title: `Workspace ${operation} after consent`,
      description:
        operation === "apply_patch"
          ? "Apply up to 20 unique ordered exact-text replacements to one 64 KiB UTF-8 file. Supply full expectedContent; ambiguous edits or mismatches fail. Structured patch, not unified diff. Linux atomic replacement; Windows exclusive in-place write with best-effort rollback, not crash atomic."
          : operation === "mkdir"
            ? "Create one new directory under existing workspace parents. Linux/Windows; credentials and links refused. No recursive parents."
            : operation === "write"
              ? "Create or replace a Windows UTF-8 file up to 64 KiB. expectedContent:null requires a new file; exact string requires matching existing content. Exclusive write with best-effort rollback, not crash atomic."
              : operation === "rename"
                ? "Rename one existing Windows regular UTF-8 file under workspace parents to a NEW destination. Exact expectedContent required; no overwrite, directory rename, credentials or links."
                : "Delete one existing Windows regular UTF-8 file up to 64 KiB by its locked handle. Exact expectedContent required; no directory or recursive deletion, credentials or links.",
      inputSchema:
        operation === "apply_patch"
          ? {
              type: "object",
              additionalProperties: false,
              required: ["path", "expectedContent", "edits"],
              properties: {
                path: { type: "string" },
                expectedContent: { type: "string" },
                edits: {
                  type: "array",
                  minItems: 1,
                  maxItems: 20,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["oldText", "newText"],
                    properties: {
                      oldText: { type: "string", minLength: 1 },
                      newText: { type: "string" },
                    },
                  },
                },
              },
            }
          : {
              type: "object",
              additionalProperties: false,
              required:
                operation === "mkdir"
                  ? ["path"]
                  : operation === "write"
                    ? ["path", "expectedContent", "content"]
                    : operation === "rename"
                      ? ["path", "to", "expectedContent"]
                      : ["path", "expectedContent"],
              properties: {
                path: { type: "string" },
                ...(operation === "mkdir"
                  ? {}
                  : {
                      expectedContent: {
                        type: operation === "write" ? ["string", "null"] : "string",
                      },
                    }),
                ...(operation === "write" ? { content: { type: "string" } } : {}),
                ...(operation === "rename" ? { to: { type: "string" } } : {}),
              },
            },
      outputSchema: { type: "object" },
      behavior: {
        primitiveFamily: "effect",
        determinism: "nondeterministic",
        effect: "external-write",
        idempotency: "unknown",
        recovery: "manual",
        executionMode: "in-process",
        requiredCapabilities: ["fs:write"],
      },
    },
    async invoke(input: JsonObject, context: AdapterInvocationContext) {
      context.signal.throwIfAborted();
      if (process.platform !== "linux" && process.platform !== "win32") throw refused();
      const planned = operationSnapshot(operation, input);
      const snapshot = planned.snapshot;
      try {
        resolver.resolveLexical(snapshot.path as string);
        if (operation === "rename") resolver.resolveLexical(snapshot.to as string);
      } catch {
        throw refused();
      }
      await privateGuard.assertAllowed(resolver.resolveLexical(snapshot.path as string));
      if (operation === "rename")
        await privateGuard.assertAllowed(resolver.resolveLexical(snapshot.to as string));
      let approved = false;
      try {
        approved = await options.approve(
          Object.freeze({ tool: `harness.fs.${operation}`, args: snapshot }),
          context,
        );
      } catch {
        context.signal.throwIfAborted();
        throw refused();
      }
      if (!approved) throw refused();
      context.signal.throwIfAborted();
      try {
        if (process.platform === "win32") {
          const value = await executeWindowsCodingOperation(
            {
              operation: operation === "apply_patch" ? "write" : operation,
              root: resolver.root,
              ...(privateGuard.paths.length ? { privatePaths: privateGuard.paths } : {}),
              path: snapshot.path as string,
              ...(operation === "apply_patch"
                ? { expectedContent: planned.before!, content: planned.after! }
                : operation === "write"
                  ? {
                      expectedContent: snapshot.expectedContent as string | null,
                      content: snapshot.content as string,
                    }
                  : operation === "rename"
                    ? {
                        expectedContent: snapshot.expectedContent as string,
                        to: snapshot.to as string,
                      }
                    : operation === "delete"
                      ? { expectedContent: snapshot.expectedContent as string }
                      : {}),
            },
            context.signal,
          );
          context.signal.throwIfAborted();
          return { value };
        }
        if (operation === "apply_patch")
          await replace(
            resolver.root,
            snapshot.path as string,
            planned.before!,
            planned.after!,
            context.signal,
            privateGuard,
          );
        else if (operation === "mkdir")
          await makeDirectory(resolver.root, snapshot.path as string, context.signal, privateGuard);
        else throw refused();
        return {
          value: {
            path: snapshot.path!,
            operation,
            ...(planned.after === undefined
              ? {}
              : { writtenBytes: Buffer.byteLength(planned.after) }),
          },
        };
      } catch {
        context.signal.throwIfAborted();
        throw refused();
      }
    },
  }));
}
