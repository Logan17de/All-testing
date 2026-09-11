import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AdapterInvocationContext,
  JsonObject,
  ToolAdapter,
  ToolResult,
} from "@zet-harness/plugin-api";

import {
  FS_READ_CAPABILITY,
  FS_WRITE_CAPABILITY,
  createNativeFileSystemPlugin,
  createNativeFileSystemTools,
  isNativeToolError,
} from "./native-fs-tools.js";
import { isWorkspacePathError } from "./workspace-path.js";

/**
 * Stand-in for the trusted invocation broker.
 *
 * The tools must never read authority from this object, so it carries only the
 * identity fields the contract defines.
 */
function invocationContext(signal?: AbortSignal): AdapterInvocationContext {
  return {
    runId: "run-1",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "effect-1",
    signal: signal ?? new AbortController().signal,
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => 0,
    },
  };
}

function asRecord(result: ToolResult): Record<string, unknown> {
  return result.value as Record<string, unknown>;
}

async function failureCode(adapter: ToolAdapter, input: JsonObject): Promise<string> {
  try {
    await adapter.invoke(input, invocationContext());
  } catch (error: unknown) {
    if (isNativeToolError(error)) return error.code;
    if (isWorkspacePathError(error)) return error.code;
    throw error;
  }
  throw new Error("Expected the invocation to be refused.");
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zet-fs-tools-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(root, "README.md"), "# project\n", "utf8");
  await writeFile(join(root, "src", "index.ts"), "export const answer = 42;\n", "utf8");
  await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports={};", "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("manifests", () => {
  it("declares fs:read demand for the read-only tools", () => {
    const tools = createNativeFileSystemTools({ root });
    expect(tools.list.manifest.behavior.requiredCapabilities).toEqual([FS_READ_CAPABILITY]);
    expect(tools.read.manifest.behavior.requiredCapabilities).toEqual([FS_READ_CAPABILITY]);
  });

  it("omits the write tool unless writing is enabled", () => {
    const tools = createNativeFileSystemTools({ root });
    expect(tools.write).toBeUndefined();
    expect(tools.adapters).toHaveLength(2);
  });

  it("declares fs:write demand only on the write tool", () => {
    const tools = createNativeFileSystemTools({ root, enableWrite: true });
    expect(tools.write?.manifest.behavior.requiredCapabilities).toEqual([FS_WRITE_CAPABILITY]);
    expect(tools.adapters).toHaveLength(3);
  });

  it("classifies reads as external-read and writes as external-write", () => {
    const tools = createNativeFileSystemTools({ root, enableWrite: true });
    expect(tools.read.manifest.behavior.effect).toBe("external-read");
    expect(tools.write?.manifest.behavior.effect).toBe("external-write");
  });

  it("freezes adapters so a plugin cannot swap an implementation after registration", () => {
    const tools = createNativeFileSystemTools({ root, enableWrite: true });
    expect(Object.isFrozen(tools.read)).toBe(true);
    expect(Object.isFrozen(tools.read.manifest)).toBe(true);
  });

  it("rejects a non-positive limit at construction", () => {
    expect(() => createNativeFileSystemTools({ root, maxReadBytes: 0 })).toThrow(TypeError);
  });
});

describe("fs.list", () => {
  it("lists the workspace root by default", async () => {
    const { list } = createNativeFileSystemTools({ root });
    const value = asRecord(await list.invoke({}, invocationContext()));
    const names = (value["entries"] as { path: string }[]).map((entry) => entry.path);
    expect(names).toContain("README.md");
    expect(names).toContain("src");
  });

  it("returns entries in a stable sorted order", async () => {
    const { list } = createNativeFileSystemTools({ root });
    const value = asRecord(await list.invoke({}, invocationContext()));
    const names = (value["entries"] as { path: string }[]).map((entry) => entry.path);
    expect(names).toEqual([...names].sort());
  });

  it("excludes noise directories such as node_modules", async () => {
    const { list } = createNativeFileSystemTools({ root });
    const value = asRecord(await list.invoke({ recursive: true }, invocationContext()));
    const names = (value["entries"] as { path: string }[]).map((entry) => entry.path);
    expect(names.some((name) => name.startsWith("node_modules"))).toBe(false);
  });

  it("descends only when recursion is requested", async () => {
    const { list } = createNativeFileSystemTools({ root });
    const flat = asRecord(await list.invoke({}, invocationContext()));
    const deep = asRecord(await list.invoke({ recursive: true }, invocationContext()));
    const flatNames = (flat["entries"] as { path: string }[]).map((entry) => entry.path);
    const deepNames = (deep["entries"] as { path: string }[]).map((entry) => entry.path);
    expect(flatNames).not.toContain("src/index.ts");
    expect(deepNames).toContain("src/index.ts");
  });

  it("reports size and modification time for files", async () => {
    const { list } = createNativeFileSystemTools({ root });
    const value = asRecord(await list.invoke({ path: "src" }, invocationContext()));
    const entry = (value["entries"] as { path: string; sizeBytes?: number }[])[0];
    expect(entry?.sizeBytes).toBe("export const answer = 42;\n".length);
  });

  it("truncates at the host entry cap and says so", async () => {
    const { list } = createNativeFileSystemTools({ root, maxEntries: 1 });
    const value = asRecord(await list.invoke({}, invocationContext()));
    expect(value["truncated"]).toBe(true);
    expect(value["entries"]).toHaveLength(1);
  });

  it("does not let an argument raise the host entry cap", async () => {
    const { list } = createNativeFileSystemTools({ root, maxEntries: 1 });
    const value = asRecord(await list.invoke({ maxEntries: 500 }, invocationContext()));
    expect(value["entries"]).toHaveLength(1);
  });

  it("refuses a path outside the workspace", async () => {
    const { list } = createNativeFileSystemTools({ root });
    expect(await failureCode(list, { path: "../.." })).toBe("escapes-root");
  });

  it("refuses to list a file", async () => {
    const { list } = createNativeFileSystemTools({ root });
    expect(await failureCode(list, { path: "README.md" })).toBe("not-a-directory");
  });

  it("refuses a missing directory", async () => {
    const { list } = createNativeFileSystemTools({ root });
    expect(await failureCode(list, { path: "nope" })).toBe("not-found");
  });

  it("honours an aborted signal", async () => {
    const { list } = createNativeFileSystemTools({ root });
    const controller = new AbortController();
    controller.abort();
    await expect(list.invoke({}, invocationContext(controller.signal))).rejects.toBeDefined();
  });
});

describe("fs.read", () => {
  it("reads a workspace file as utf8", async () => {
    const { read } = createNativeFileSystemTools({ root });
    const value = asRecord(await read.invoke({ path: "src/index.ts" }, invocationContext()));
    expect(value["content"]).toBe("export const answer = 42;\n");
    expect(value["truncated"]).toBe(false);
    expect(value["path"]).toBe("src/index.ts");
  });

  it("reports a sha256 of the returned bytes", async () => {
    const { read } = createNativeFileSystemTools({ root });
    const value = asRecord(await read.invoke({ path: "README.md" }, invocationContext()));
    expect(value["sha256"]).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("reads as base64 when asked", async () => {
    const { read } = createNativeFileSystemTools({ root });
    const value = asRecord(
      await read.invoke({ path: "README.md", encoding: "base64" }, invocationContext()),
    );
    expect(Buffer.from(value["content"] as string, "base64").toString("utf8")).toBe("# project\n");
  });

  it("truncates at the host byte cap and says so", async () => {
    const { read } = createNativeFileSystemTools({ root, maxReadBytes: 4 });
    const value = asRecord(await read.invoke({ path: "README.md" }, invocationContext()));
    expect(value["truncated"]).toBe(true);
    expect(value["sizeBytes"]).toBe(4);
  });

  it("does not let an argument raise the host byte cap", async () => {
    const { read } = createNativeFileSystemTools({ root, maxReadBytes: 4 });
    const value = asRecord(
      await read.invoke({ path: "README.md", maxBytes: 1_000_000 }, invocationContext()),
    );
    expect(value["sizeBytes"]).toBe(4);
  });

  it("does not mark an exactly-sized read as truncated", async () => {
    const { read } = createNativeFileSystemTools({ root, maxReadBytes: "# project\n".length });
    const value = asRecord(await read.invoke({ path: "README.md" }, invocationContext()));
    expect(value["truncated"]).toBe(false);
  });

  it("refuses a directory", async () => {
    const { read } = createNativeFileSystemTools({ root });
    expect(await failureCode(read, { path: "src" })).toBe("not-a-file");
  });

  it("refuses a missing file", async () => {
    const { read } = createNativeFileSystemTools({ root });
    expect(await failureCode(read, { path: "missing.txt" })).toBe("not-found");
  });

  it("requires a path", async () => {
    const { read } = createNativeFileSystemTools({ root });
    expect(await failureCode(read, {})).toBe("invalid-input");
  });

  it("refuses a non-string path", async () => {
    const { read } = createNativeFileSystemTools({ root });
    expect(await failureCode(read, { path: 7 })).toBe("invalid-input");
  });

  it("refuses an unknown encoding", async () => {
    const { read } = createNativeFileSystemTools({ root });
    expect(await failureCode(read, { path: "README.md", encoding: "hex" })).toBe("invalid-input");
  });

  it("refuses traversal out of the workspace", async () => {
    const { read } = createNativeFileSystemTools({ root });
    expect(await failureCode(read, { path: "../../etc/passwd" })).toBe("escapes-root");
  });

  it("refuses a reserved device name", async () => {
    const { read } = createNativeFileSystemTools({ root });
    expect(await failureCode(read, { path: "NUL" })).toBe("reserved-device-name");
  });

  it("refuses a file reached through a junction that leaves the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "zet-outside-"));
    await writeFile(join(outside, "secrets.txt"), "token\n", "utf8");
    try {
      await symlink(outside, join(root, "linked"), "junction");
    } catch {
      await rm(outside, { recursive: true, force: true });
      return;
    }
    const { read } = createNativeFileSystemTools({ root });
    expect(await failureCode(read, { path: "linked/secrets.txt" })).toBe("symlink-escapes-root");
    await rm(outside, { recursive: true, force: true });
  });
});

describe("fs.write", () => {
  it("creates a new file and reports creation", async () => {
    const tools = createNativeFileSystemTools({ root, enableWrite: true });
    const write = tools.write;
    if (write === undefined) throw new Error("write tool missing");
    const value = asRecord(
      await write.invoke({ path: "notes.txt", content: "hello\n" }, invocationContext()),
    );
    expect(value["created"]).toBe(true);
    expect(value["beforeSha256"]).toBeNull();
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("hello\n");
  });

  it("records before and after hashes when replacing a file", async () => {
    const tools = createNativeFileSystemTools({ root, enableWrite: true });
    const write = tools.write;
    if (write === undefined) throw new Error("write tool missing");
    const value = asRecord(
      await write.invoke({ path: "README.md", content: "# changed\n" }, invocationContext()),
    );
    expect(value["created"]).toBe(false);
    expect(value["beforeSha256"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(value["afterSha256"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(value["beforeSha256"]).not.toBe(value["afterSha256"]);
  });

  it("is idempotent: repeating one write reaches the same content and hash", async () => {
    const tools = createNativeFileSystemTools({ root, enableWrite: true });
    const write = tools.write;
    if (write === undefined) throw new Error("write tool missing");
    const first = asRecord(
      await write.invoke({ path: "same.txt", content: "stable\n" }, invocationContext()),
    );
    const second = asRecord(
      await write.invoke({ path: "same.txt", content: "stable\n" }, invocationContext()),
    );
    expect(second["afterSha256"]).toBe(first["afterSha256"]);
    expect(await readFile(join(root, "same.txt"), "utf8")).toBe("stable\n");
  });

  it("refuses to replace an existing file when overwrite is disabled", async () => {
    const tools = createNativeFileSystemTools({ root, enableWrite: true });
    const write = tools.write;
    if (write === undefined) throw new Error("write tool missing");
    expect(await failureCode(write, { path: "README.md", content: "x", overwrite: false })).toBe(
      "already-exists",
    );
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("# project\n");
  });

  it("does not create parent directories unless asked", async () => {
    const tools = createNativeFileSystemTools({ root, enableWrite: true });
    const write = tools.write;
    if (write === undefined) throw new Error("write tool missing");
    expect(await failureCode(write, { path: "deep/nested/file.txt", content: "x" })).toBe(
      "not-found",
    );
  });

  it("creates parent directories when asked", async () => {
    const tools = createNativeFileSystemTools({ root, enableWrite: true });
    const write = tools.write;
    if (write === undefined) throw new Error("write tool missing");
    await write.invoke(
      { path: "deep/nested/file.txt", content: "x", createDirectories: true },
      invocationContext(),
    );
    expect(await readFile(join(root, "deep", "nested", "file.txt"), "utf8")).toBe("x");
  });

  it("refuses content beyond the write limit", async () => {
    const tools = createNativeFileSystemTools({ root, enableWrite: true, maxWriteBytes: 4 });
    const write = tools.write;
    if (write === undefined) throw new Error("write tool missing");
    expect(await failureCode(write, { path: "big.txt", content: "aaaaaaaa" })).toBe("too-large");
  });

  it("refuses invalid base64 content", async () => {
    const tools = createNativeFileSystemTools({ root, enableWrite: true });
    const write = tools.write;
    if (write === undefined) throw new Error("write tool missing");
    expect(
      await failureCode(write, { path: "b.bin", content: "not base64!", encoding: "base64" }),
    ).toBe("invalid-input");
  });

  it("refuses to write over a directory", async () => {
    const tools = createNativeFileSystemTools({ root, enableWrite: true });
    const write = tools.write;
    if (write === undefined) throw new Error("write tool missing");
    expect(await failureCode(write, { path: "src", content: "x" })).toBe("not-a-file");
  });

  it("refuses to write outside the workspace", async () => {
    const tools = createNativeFileSystemTools({ root, enableWrite: true });
    const write = tools.write;
    if (write === undefined) throw new Error("write tool missing");
    expect(await failureCode(write, { path: "../escape.txt", content: "x" })).toBe("escapes-root");
  });

  it("refuses to write through a junction that leaves the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "zet-outside-"));
    try {
      await symlink(outside, join(root, "linked"), "junction");
    } catch {
      await rm(outside, { recursive: true, force: true });
      return;
    }
    const tools = createNativeFileSystemTools({ root, enableWrite: true });
    const write = tools.write;
    if (write === undefined) throw new Error("write tool missing");
    expect(await failureCode(write, { path: "linked/planted.txt", content: "x" })).toBe(
      "symlink-escapes-root",
    );
    await rm(outside, { recursive: true, force: true });
  });

  it("leaves no temporary file behind after a successful write", async () => {
    const tools = createNativeFileSystemTools({ root, enableWrite: true });
    const write = tools.write;
    if (write === undefined) throw new Error("write tool missing");
    await write.invoke({ path: "clean.txt", content: "x" }, invocationContext());
    const { list } = tools;
    const value = asRecord(await list.invoke({}, invocationContext()));
    const names = (value["entries"] as { path: string }[]).map((entry) => entry.path);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});

describe("plugin registration", () => {
  it("registers the read-only tools without touching the filesystem", async () => {
    const registered: ToolAdapter[] = [];
    const plugin = createNativeFileSystemPlugin({ root: join(root, "does-not-exist") });
    await plugin.activate({
      nodes: { register: () => undefined },
      models: { register: () => undefined },
      tools: { register: (adapter: ToolAdapter) => registered.push(adapter) },
      onDispose: () => undefined,
    });
    expect(registered.map((adapter) => adapter.manifest.id)).toEqual([
      "harness.fs.list",
      "harness.fs.read",
    ]);
  });

  it("declares only fs:read when writing is disabled", () => {
    const plugin = createNativeFileSystemPlugin({ root });
    expect(plugin.manifest.capabilities).toEqual([{ id: FS_READ_CAPABILITY }]);
  });

  it("declares both capabilities when writing is enabled", () => {
    const plugin = createNativeFileSystemPlugin({ root, enableWrite: true });
    expect(plugin.manifest.capabilities).toEqual([
      { id: FS_READ_CAPABILITY },
      { id: FS_WRITE_CAPABILITY },
    ]);
  });
});
