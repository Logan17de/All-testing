import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { AdapterInvocationContext, JsonObject, ToolAdapter } from "@zet-harness/plugin-api";
import { isBlockedWorkspacePathSegment } from "./runtime-workspace-read-tools.js";
import type { RuntimeMutationToolOptions } from "./runtime-coding-mutation-tools.js";
const MAX_BYTES = 65_536;
const refused = (): Error => new Error("Workspace file operation rejected the request.");
function parts(value: unknown): string[] {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.isAbsolute(value)
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
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > MAX_BYTES)
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
async function makeDirectory(root: string, filePath: string, signal: AbortSignal): Promise<void> {
  const components = parts(filePath);
  const name = components.pop()!;
  const parent = await anchoredParent(root, components);
  try {
    signal.throwIfAborted();
    await mkdir(`/proc/self/fd/${parent.fd}/${name}`, { mode: 0o700 });
  } finally {
    await parent.close();
  }
}
/** Narrow structured patches and single-directory creation; exact consent precedes every effect. */
export function createRuntimeCodingFileTools(
  options: RuntimeMutationToolOptions,
): readonly ToolAdapter[] {
  return (["apply_patch", "mkdir"] as const).map((operation): ToolAdapter => ({
    manifest: {
      id: `harness.fs.${operation}`,
      version: "1",
      title:
        operation === "apply_patch"
          ? "Apply exact workspace edits after consent"
          : "Create workspace directory after consent",
      description:
        operation === "apply_patch"
          ? "Apply up to 20 ordered unique exact-text replacements to one existing UTF-8 file. Supply full expectedContent; mismatches/ambiguous edits fail without writing. Linux only, 64 KiB files, credentials/links refused. This is a structured patch, not unified diff."
          : "Create one new directory under existing workspace parents after explicit consent. Linux only; credentials and links refused. Does not recursively create parents.",
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
              required: ["path"],
              properties: { path: { type: "string" } },
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
      if (process.platform !== "linux") throw refused();
      const edit = operation === "apply_patch" ? patch(input) : undefined;
      if (!edit && Object.keys(input).some((key) => key !== "path")) throw refused();
      parts(input.path);
      const snapshot = edit?.snapshot ?? Object.freeze({ path: input.path! });
      if (
        !(await options.approve(
          Object.freeze({ tool: `harness.fs.${operation}`, args: snapshot }),
          context,
        ))
      )
        throw refused();
      context.signal.throwIfAborted();
      try {
        if (edit)
          await replace(
            options.root,
            snapshot.path as string,
            edit.before,
            edit.after,
            context.signal,
          );
        else await makeDirectory(options.root, snapshot.path as string, context.signal);
        return {
          value: {
            path: snapshot.path!,
            operation,
            ...(edit ? { writtenBytes: Buffer.byteLength(edit.after) } : {}),
          },
        };
      } catch {
        context.signal.throwIfAborted();
        throw refused();
      }
    },
  }));
}
