import { createHash } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { dirname, join } from "node:path";

import type {
  AdapterInvocationContext,
  HarnessPlugin,
  PluginContext,
  JsonObject,
  JsonValue,
  NodeBehavior,
  ToolAdapter,
  ToolResult,
} from "@zet-harness/plugin-api";
import { PLUGIN_API_VERSION } from "@zet-harness/plugin-api";

import type { ResolvedWorkspacePath, WorkspacePathResolver } from "./workspace-path.js";
import { createWorkspacePathResolver } from "./workspace-path.js";

/** Capability demanded by the read-only filesystem tools. */
export const FS_READ_CAPABILITY = "fs:read";
/** Capability demanded by the write tool. Granting read never implies write. */
export const FS_WRITE_CAPABILITY = "fs:write";

export type NativeToolErrorCode =
  | "invalid-input"
  | "not-found"
  | "not-a-file"
  | "not-a-directory"
  | "unsupported-file-kind"
  | "too-large"
  | "too-many-entries"
  | "already-exists"
  | "write-refused"
  | "io-error";

const TOOL_ERROR_MARKER: unique symbol = Symbol("zet-harness.native-tool-error");

/** Typed tool failure whose provenance cannot be forged by a prototype. */
export class NativeToolError extends Error {
  readonly code: NativeToolErrorCode;

  constructor(code: NativeToolErrorCode, message: string) {
    super(message);
    this.name = "NativeToolError";
    this.code = code;
    Object.defineProperty(this, TOOL_ERROR_MARKER, { value: true, enumerable: false });
  }
}

export function isNativeToolError(value: unknown): value is NativeToolError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[TOOL_ERROR_MARKER] === true
  );
}

const DEFAULT_MAX_READ_BYTES = 1_048_576; // 1 MiB
const DEFAULT_MAX_WRITE_BYTES = 8_388_608; // 8 MiB
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_DEPTH = 32;

export interface NativeFileSystemToolOptions {
  /** Absolute project root; every path is resolved and contained against it. */
  readonly root: string;
  readonly maxReadBytes?: number;
  readonly maxWriteBytes?: number;
  readonly maxEntries?: number;
  readonly maxDepth?: number;
  /**
   * Register the write tool.
   *
   * Defaults to false. Installing a tool and authorizing it stay separate, and
   * a read-only deployment should not carry a write implementation at all.
   */
  readonly enableWrite?: boolean;
  /** Directory names never traversed or listed. */
  readonly excludedDirectories?: readonly string[];
  readonly caseInsensitive?: boolean;
}

/** Noise and credential directories that should never reach a model's context. */
const DEFAULT_EXCLUDED_DIRECTORIES: readonly string[] = [
  ".git",
  "node_modules",
  ".next",
  "dist",
  ".venv",
  "__pycache__",
];

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function requireString(input: JsonObject, key: string, fallback?: string): string {
  const value = input[key];
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new NativeToolError("invalid-input", `'${key}' is required.`);
  }
  if (typeof value !== "string") {
    throw new NativeToolError("invalid-input", `'${key}' must be a string.`);
  }
  return value;
}

function optionalBoolean(input: JsonObject, key: string, fallback: boolean): boolean {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new NativeToolError("invalid-input", `'${key}' must be a boolean.`);
  }
  return value;
}

function optionalBoundedInteger(
  input: JsonObject,
  key: string,
  fallback: number,
  ceiling: number,
): number {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new NativeToolError("invalid-input", `'${key}' must be a positive integer.`);
  }
  // Host limits are a ceiling, never something an argument can raise.
  return Math.min(value, ceiling);
}

type TextEncodingName = "utf8" | "base64";

function readEncoding(input: JsonObject): TextEncodingName {
  const value = input["encoding"];
  if (value === undefined || value === null) return "utf8";
  if (value !== "utf8" && value !== "base64") {
    throw new NativeToolError("invalid-input", "'encoding' must be 'utf8' or 'base64'.");
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function entryKind(entry: Dirent): "file" | "directory" | "symlink" | "other" {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

function ioErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Translate a filesystem errno into a closed tool error without leaking host paths. */
function translateIoError(error: unknown, relativePath: string): NativeToolError {
  if (isNativeToolError(error)) return error;
  const code = ioErrorCode(error);
  switch (code) {
    case "ENOENT":
      return new NativeToolError("not-found", `'${relativePath}' does not exist.`);
    case "ENOTDIR":
      return new NativeToolError("not-a-directory", `'${relativePath}' is not a directory.`);
    case "EISDIR":
      return new NativeToolError("not-a-file", `'${relativePath}' is a directory.`);
    case "EEXIST":
      return new NativeToolError("already-exists", `'${relativePath}' already exists.`);
    case "ENAMETOOLONG":
      return new NativeToolError("io-error", `'${relativePath}' exceeds the host path limit.`);
    default:
      return new NativeToolError("io-error", `Could not access '${relativePath}'.`);
  }
}

const READ_BEHAVIOR: NodeBehavior = Object.freeze({
  primitiveFamily: "effect" as const,
  // The filesystem can change between attempts, so a read is not reproducible.
  determinism: "nondeterministic" as const,
  effect: "external-read" as const,
  idempotency: "idempotent" as const,
  recovery: "rerun" as const,
  executionMode: "in-process" as const,
  requiredCapabilities: Object.freeze([FS_READ_CAPABILITY]),
});

const WRITE_BEHAVIOR: NodeBehavior = Object.freeze({
  primitiveFamily: "effect" as const,
  determinism: "nondeterministic" as const,
  effect: "external-write" as const,
  // Whole-file replacement only: repeating one write reaches the same state.
  // This is why append mode is deliberately absent from the contract.
  idempotency: "idempotent" as const,
  recovery: "rerun" as const,
  executionMode: "in-process" as const,
  requiredCapabilities: Object.freeze([FS_WRITE_CAPABILITY]),
});

export interface NativeFileSystemTools {
  readonly list: ToolAdapter;
  readonly read: ToolAdapter;
  readonly write?: ToolAdapter;
  readonly adapters: readonly ToolAdapter[];
}

/**
 * First-party native filesystem tools.
 *
 * Every path argument is model-supplied and therefore untrusted: it is resolved
 * through the workspace resolver, never joined directly. The tools declare
 * `fs:read`/`fs:write` as demand; the host invocation broker is what authorizes
 * them. Reaching this code is not itself proof of permission.
 */
export function createNativeFileSystemTools(
  options: NativeFileSystemToolOptions,
): NativeFileSystemTools {
  const maxReadBytes = positiveInteger(
    options.maxReadBytes,
    DEFAULT_MAX_READ_BYTES,
    "maxReadBytes",
  );
  const maxWriteBytes = positiveInteger(
    options.maxWriteBytes,
    DEFAULT_MAX_WRITE_BYTES,
    "maxWriteBytes",
  );
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries");
  const maxDepth = positiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH, "maxDepth");
  const excluded = new Set(options.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES);

  const resolver: WorkspacePathResolver = createWorkspacePathResolver(
    options.caseInsensitive === undefined
      ? { root: options.root }
      : { root: options.root, caseInsensitive: options.caseInsensitive },
  );

  async function resolveExisting(
    requested: string,
    context: AdapterInvocationContext,
  ): Promise<{ readonly target: ResolvedWorkspacePath; readonly stats: Stats }> {
    context.signal.throwIfAborted();
    const target = await resolver.resolve(requested);
    if (!target.exists) {
      throw new NativeToolError("not-found", `'${target.relativePath}' does not exist.`);
    }
    try {
      const stats = await stat(target.absolutePath);
      return { target, stats };
    } catch (error: unknown) {
      throw translateIoError(error, target.relativePath);
    }
  }

  const listAdapter: ToolAdapter = Object.freeze({
    manifest: Object.freeze({
      id: "harness.fs.list",
      version: "1",
      title: "List workspace directory",
      description:
        "List files and directories inside the project workspace. Paths are workspace-relative.",
      inputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Workspace-relative directory. Defaults to '.'." },
          recursive: { type: "boolean", description: "Descend into subdirectories." },
          maxEntries: { type: "integer", minimum: 1, description: "Caller cap, bounded by host." },
        },
      }),
      outputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["path", "entries", "truncated"],
        properties: {
          path: { type: "string" },
          truncated: { type: "boolean" },
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "kind"],
              properties: {
                path: { type: "string" },
                kind: { type: "string", enum: ["file", "directory", "symlink", "other"] },
                sizeBytes: { type: "integer" },
                modifiedMs: { type: "integer" },
              },
            },
          },
        },
      }),
      behavior: READ_BEHAVIOR,
    }),
    async invoke(input: JsonObject, context: AdapterInvocationContext): Promise<ToolResult> {
      const requested = requireString(input, "path", ".");
      const recursive = optionalBoolean(input, "recursive", false);
      const limit = optionalBoundedInteger(input, "maxEntries", maxEntries, maxEntries);

      const { target, stats } = await resolveExisting(requested, context);
      if (!stats.isDirectory()) {
        throw new NativeToolError(
          "not-a-directory",
          `'${target.relativePath}' is not a directory.`,
        );
      }

      const entries: JsonValue[] = [];
      let truncated = false;

      const walk = async (absolute: string, relative: string, depth: number): Promise<void> => {
        if (truncated || depth > maxDepth) return;
        context.signal.throwIfAborted();

        let dirents: Dirent[];
        try {
          dirents = await readdir(absolute, { withFileTypes: true });
        } catch (error: unknown) {
          throw translateIoError(error, relative);
        }

        // Stable ordering keeps a run trace reproducible across hosts, which
        // readdir order alone does not guarantee.
        dirents.sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        );

        for (const dirent of dirents) {
          if (truncated) return;
          if (entries.length >= limit) {
            truncated = true;
            return;
          }

          const kind = entryKind(dirent);
          const childRelative = relative === "." ? dirent.name : `${relative}/${dirent.name}`;
          const childAbsolute = join(absolute, dirent.name);

          if (kind === "directory" && excluded.has(dirent.name)) continue;

          const entry: Record<string, JsonValue> = { path: childRelative, kind };
          if (kind === "file") {
            try {
              const childStats = await stat(childAbsolute);
              entry["sizeBytes"] = childStats.size;
              entry["modifiedMs"] = Math.trunc(childStats.mtimeMs);
            } catch {
              // A file that disappears mid-listing is reported without metadata
              // rather than failing the whole listing.
            }
          }
          entries.push(entry);

          if (recursive && kind === "directory") {
            await walk(childAbsolute, childRelative, depth + 1);
          }
        }
      };

      await walk(target.absolutePath, target.relativePath, 1);

      return Object.freeze({
        value: Object.freeze({
          path: target.relativePath,
          entries: Object.freeze(entries),
          truncated,
        }),
      });
    },
  });

  const readAdapter: ToolAdapter = Object.freeze({
    manifest: Object.freeze({
      id: "harness.fs.read",
      version: "1",
      title: "Read workspace file",
      description: "Read one file inside the project workspace.",
      inputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          encoding: { type: "string", enum: ["utf8", "base64"] },
          maxBytes: { type: "integer", minimum: 1, description: "Caller cap, bounded by host." },
        },
      }),
      outputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["path", "encoding", "content", "sizeBytes", "truncated", "sha256"],
        properties: {
          path: { type: "string" },
          encoding: { type: "string", enum: ["utf8", "base64"] },
          content: { type: "string" },
          sizeBytes: { type: "integer" },
          truncated: { type: "boolean" },
          sha256: { type: "string" },
        },
      }),
      behavior: READ_BEHAVIOR,
    }),
    async invoke(input: JsonObject, context: AdapterInvocationContext): Promise<ToolResult> {
      const requested = requireString(input, "path");
      const encoding = readEncoding(input);
      const limit = optionalBoundedInteger(input, "maxBytes", maxReadBytes, maxReadBytes);

      const { target, stats } = await resolveExisting(requested, context);
      if (stats.isDirectory()) {
        throw new NativeToolError("not-a-file", `'${target.relativePath}' is a directory.`);
      }
      if (!stats.isFile()) {
        // Devices and FIFOs can block forever or produce unbounded data.
        throw new NativeToolError(
          "unsupported-file-kind",
          `'${target.relativePath}' is not a regular file.`,
        );
      }

      // Read at most limit+1 bytes: the extra byte distinguishes "exactly at the
      // cap" from "truncated" without reading an oversized file into memory.
      const handle = await open(target.absolutePath, "r").catch((error: unknown) => {
        throw translateIoError(error, target.relativePath);
      });
      let bytes: Uint8Array;
      try {
        context.signal.throwIfAborted();
        const buffer = Buffer.alloc(Math.min(limit + 1, stats.size + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        bytes = buffer.subarray(0, bytesRead);
      } catch (error: unknown) {
        throw translateIoError(error, target.relativePath);
      } finally {
        await handle.close().catch(() => undefined);
      }

      const truncated = bytes.length > limit;
      const content = truncated ? bytes.subarray(0, limit) : bytes;

      return Object.freeze({
        value: Object.freeze({
          path: target.relativePath,
          encoding,
          content: Buffer.from(content).toString(encoding),
          sizeBytes: content.length,
          truncated,
          sha256: sha256(content),
        }),
      });
    },
  });

  const writeAdapter: ToolAdapter = Object.freeze({
    manifest: Object.freeze({
      id: "harness.fs.write",
      version: "1",
      title: "Write workspace file",
      description:
        "Replace the full contents of one file inside the project workspace. Appending is not supported.",
      inputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          content: { type: "string" },
          encoding: { type: "string", enum: ["utf8", "base64"] },
          createDirectories: { type: "boolean", description: "Create missing parents." },
          overwrite: { type: "boolean", description: "Allow replacing an existing file." },
        },
      }),
      outputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["path", "bytesWritten", "created", "beforeSha256", "afterSha256"],
        properties: {
          path: { type: "string" },
          bytesWritten: { type: "integer" },
          created: { type: "boolean" },
          // Null before-hash means the file did not exist; a file-change record
          // needs to tell creation apart from replacing empty content.
          beforeSha256: { type: ["string", "null"] },
          afterSha256: { type: "string" },
        },
      }),
      behavior: WRITE_BEHAVIOR,
    }),
    async invoke(input: JsonObject, context: AdapterInvocationContext): Promise<ToolResult> {
      const requested = requireString(input, "path");
      const rawContent = requireString(input, "content");
      const encoding = readEncoding(input);
      const createDirectories = optionalBoolean(input, "createDirectories", false);
      const overwrite = optionalBoolean(input, "overwrite", true);

      if (encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/u.test(rawContent)) {
        throw new NativeToolError("invalid-input", "'content' is not valid base64.");
      }

      const bytes = Buffer.from(rawContent, encoding);
      if (bytes.length > maxWriteBytes) {
        throw new NativeToolError(
          "too-large",
          `Content exceeds the ${String(maxWriteBytes)} byte write limit.`,
        );
      }

      context.signal.throwIfAborted();
      const target = await resolver.resolve(requested);

      let beforeSha: string | null = null;
      let existed = false;
      try {
        const existing = await stat(target.absolutePath);
        existed = true;
        if (existing.isDirectory()) {
          throw new NativeToolError("not-a-file", `'${target.relativePath}' is a directory.`);
        }
        if (!existing.isFile()) {
          throw new NativeToolError(
            "unsupported-file-kind",
            `'${target.relativePath}' is not a regular file.`,
          );
        }
        if (!overwrite) {
          throw new NativeToolError(
            "already-exists",
            `'${target.relativePath}' already exists and overwrite is disabled.`,
          );
        }
        if (existing.size <= maxReadBytes) {
          const handle = await open(target.absolutePath, "r");
          try {
            const buffer = Buffer.alloc(existing.size);
            await handle.read(buffer, 0, existing.size, 0);
            beforeSha = sha256(buffer);
          } finally {
            await handle.close().catch(() => undefined);
          }
        }
      } catch (error: unknown) {
        if (isNativeToolError(error)) throw error;
        if (ioErrorCode(error) !== "ENOENT") throw translateIoError(error, target.relativePath);
      }

      if (createDirectories) {
        await mkdir(dirname(target.absolutePath), { recursive: true }).catch((error: unknown) => {
          throw translateIoError(error, target.relativePath);
        });
      }

      // Write to a sibling temp file and rename, so a crash mid-write cannot
      // leave a half-written file where the durable record claims a full one.
      // The name comes from a hash of the effect id: effect ids contain ':', which
      // Windows does not allow in file names.
      const temporaryPath = `${target.absolutePath}.${sha256(
        Buffer.from(context.logicalEffectId, "utf8"),
      ).slice(0, 16)}.tmp`;
      try {
        context.signal.throwIfAborted();
        const handle = await open(temporaryPath, "wx");
        try {
          await handle.write(bytes, 0, bytes.length, 0);
          await handle.sync().catch(() => undefined);
        } finally {
          await handle.close().catch(() => undefined);
        }
        await rename(temporaryPath, target.absolutePath);
      } catch (error: unknown) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw translateIoError(error, target.relativePath);
      }

      return Object.freeze({
        value: Object.freeze({
          path: target.relativePath,
          bytesWritten: bytes.length,
          created: !existed,
          beforeSha256: beforeSha,
          afterSha256: sha256(bytes),
        }),
      });
    },
  });

  const adapters =
    options.enableWrite === true
      ? Object.freeze([listAdapter, readAdapter, writeAdapter])
      : Object.freeze([listAdapter, readAdapter]);

  return Object.freeze(
    options.enableWrite === true
      ? { list: listAdapter, read: readAdapter, write: writeAdapter, adapters }
      : { list: listAdapter, read: readAdapter, adapters },
  );
}

/**
 * First-party plugin wrapper.
 *
 * Registration performs no filesystem access; the root is only resolved when a
 * tool is actually invoked.
 */
export function createNativeFileSystemPlugin(options: NativeFileSystemToolOptions): HarnessPlugin {
  const tools = createNativeFileSystemTools(options);
  const capabilities =
    options.enableWrite === true
      ? [{ id: FS_READ_CAPABILITY }, { id: FS_WRITE_CAPABILITY }]
      : [{ id: FS_READ_CAPABILITY }];

  return Object.freeze({
    manifest: Object.freeze({
      id: "harness.tools.native-fs",
      name: "Native filesystem tools",
      version: "1",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: Object.freeze(capabilities),
    }),
    activate(context: PluginContext) {
      for (const adapter of tools.adapters) {
        context.tools.register(adapter);
      }
    },
  });
}
