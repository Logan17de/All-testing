import type * as NodePath from "node:path";
import type * as NodeFsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, realpath } from "node:fs/promises";
import { buildCodexWorkspacePermissionGrant } from "./runtime-codex-permissions.js";

vi.mock("node:path", async (original) => {
  const actual = await original<typeof NodePath>();
  return { ...actual.win32, default: actual.win32 };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeFsPromises>();
  return { ...actual, realpath: vi.fn(), lstat: vi.fn() };
});

const lexicalRoot = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\zet";
const canonicalRoot = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\zet";
const lexicalFile = `${lexicalRoot}\\safe.txt`;
const canonicalFile = `${canonicalRoot}\\safe.txt`;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const request = (target: string) => ({
  threadId: "t",
  turnId: "v",
  itemId: "i",
  startedAtMs: 0,
  reason: null,
  cwd: lexicalRoot,
  environmentId: null,
  permissions: { network: null, fileSystem: { read: [target], write: null } },
});

describe("native permission Windows path aliases (mocked filesystem, not live Windows)", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    vi.mocked(realpath).mockImplementation((target) => {
      const value = String(target);
      if (value.toLowerCase() === lexicalRoot.toLowerCase()) return Promise.resolve(canonicalRoot);
      if (value.toLowerCase() === lexicalFile.toLowerCase()) return Promise.resolve(canonicalFile);
      return Promise.resolve(value);
    });
    vi.mocked(lstat).mockResolvedValue({
      isSymbolicLink: () => false,
      isFile: () => true,
      nlink: 1,
    } as Awaited<ReturnType<typeof lstat>>);
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    vi.resetAllMocks();
  });
  it("accepts a configured 8.3 root alias and returns canonical output", async () => {
    expect(await buildCodexWorkspacePermissionGrant(lexicalRoot, request(lexicalFile))).toEqual({
      fileSystem: { read: [canonicalFile], write: null },
    });
    expect(await buildCodexWorkspacePermissionGrant(lexicalRoot, request(canonicalFile))).toEqual({
      fileSystem: { read: [canonicalFile], write: null },
    });
  });
  it("rejects a sibling sharing the workspace prefix", async () => {
    await expect(
      buildCodexWorkspacePermissionGrant(
        lexicalRoot,
        request(`${canonicalRoot}-sibling\\safe.txt`),
      ),
    ).rejects.toThrow();
  });
  it("rejects a case-distinct canonical directory even when lexical comparison folds case", async () => {
    vi.mocked(realpath).mockImplementation((target) =>
      Promise.resolve(
        String(target) === lexicalRoot
          ? canonicalRoot
          : String(target) === lexicalFile
            ? canonicalFile.replace("\\zet\\", "\\ZET\\")
            : String(target),
      ),
    );
    await expect(
      buildCodexWorkspacePermissionGrant(lexicalRoot, request(lexicalFile)),
    ).rejects.toThrow();
  });
  it("rejects a symlink below the configured lexical root", async () => {
    vi.mocked(lstat).mockResolvedValue({
      isSymbolicLink: () => true,
      isFile: () => true,
      nlink: 1,
    } as Awaited<ReturnType<typeof lstat>>);
    await expect(
      buildCodexWorkspacePermissionGrant(lexicalRoot, request(lexicalFile)),
    ).rejects.toThrow();
  });
});
