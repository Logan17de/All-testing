import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_DYNAMIC_TOOLS, executeCodexDynamicTool } from "./runtime-codex-dynamic-tools.js";

describe("fixed Codex dynamic workspace tools (local fixtures)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zet-tools-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const rejected = {
    success: false,
    contentItems: [
      {
        type: "inputText",
        text: "Workspace tool rejected the request or could not access the permitted resource.",
      },
    ],
  };
  const read = (root: string, args: unknown) =>
    executeCodexDynamicTool(root, "zet_workspace_read_file", args);
  it("exposes only two fixed read-only tools and reads UTF-8", async () => {
    expect(CODEX_DYNAMIC_TOOLS.map((spec) => spec.name)).toEqual([
      "zet_workspace_read_file",
      "zet_workspace_list",
    ]);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "hello.ts"), "hello 🌍");
    expect(await read(root, { path: "src/hello.ts" })).toEqual(
      process.platform === "linux"
        ? {
            success: true,
            contentItems: [{ type: "inputText", text: "hello 🌍" }],
          }
        : rejected,
    );
  });
  it("lists ordinary entries while hiding symlinks and credential names", async () => {
    await writeFile(path.join(root, "safe.ts"), "safe");
    await writeFile(path.join(root, ".env.local"), "secret");
    await mkdir(path.join(root, ".git"));
    await mkdir(path.join(root, "src"));
    await symlink(path.join(root, "safe.ts"), path.join(root, "shortcut"));
    const result = await executeCodexDynamicTool(root, "zet_workspace_list", {});
    if (process.platform !== "linux") {
      expect(result).toEqual(rejected);
      return;
    }
    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0]!.text)).toEqual({
      entries: [
        { name: "safe.ts", type: "file" },
        { name: "src", type: "directory" },
      ],
      truncated: false,
    });
  });
  it.each([
    null,
    [],
    "x",
    {},
    { path: 3 },
    { path: "../outside" },
    { path: "/etc/passwd" },
    { path: "C:\\secret" },
    { path: "a\0b" },
    { path: ".env.production" },
    { path: ".git/config" },
    { path: ".codex/auth.json" },
    { path: "key.pem" },
    { path: "id_ed25519" },
    { path: "auth.json" },
    { path: ".git-credentials" },
    { path: ".bash_history" },
    { path: ".zsh_history" },
    { path: ".gcloud/credentials.json" },
    { path: ".zet-codex/config.toml" },
    { path: "safe.ts", extra: true },
  ])("rejects malformed, secret or escaping read arguments %j", async (args) => {
    expect((await read(root, args)).success).toBe(false);
  });
  it("rejects final and parent symlinks, hardlinks, directories, unknown tools", async () => {
    await writeFile(path.join(root, "safe.ts"), "safe");
    await symlink("safe.ts", path.join(root, "file-link"));
    await symlink(tmpdir(), path.join(root, "dir-link"));
    await link(path.join(root, "safe.ts"), path.join(root, "hardlink"));
    for (const file of ["file-link", "dir-link/test", "hardlink", "."])
      expect((await read(root, { path: file })).success).toBe(false);
    expect((await executeCodexDynamicTool(root, "zet_git_status", {})).success).toBe(false);
    expect(
      (await executeCodexDynamicTool(root, "zet_workspace_list", { path: "dir-link" })).success,
    ).toBe(false);
  });
  it("bounds file size and rejects binary and invalid UTF-8", async () => {
    for (const [name, content] of [
      ["large", Buffer.alloc(65537, 65)],
      ["binary", Buffer.from([0])],
      ["invalid", Buffer.from([255])],
    ] as const) {
      await writeFile(path.join(root, name), content);
      expect((await read(root, { path: name })).success).toBe(false);
    }
    await writeFile(path.join(root, "limit"), "a".repeat(65536));
    const result = await read(root, { path: "limit" });
    if (process.platform === "linux") expect(result.success).toBe(true);
    else expect(result).toEqual(rejected);
  });
  it("limits directory output to 200 entries", async () => {
    await Promise.all(
      Array.from({ length: 205 }, (_, index) => writeFile(path.join(root, `file-${index}`), "")),
    );
    const result = await executeCodexDynamicTool(root, "zet_workspace_list", {});
    if (process.platform !== "linux") {
      expect(result).toEqual(rejected);
      return;
    }
    expect(result.success).toBe(true);
    const listing = JSON.parse(result.contentItems[0]!.text) as {
      entries: unknown[];
      truncated: boolean;
    };
    expect(listing.entries).toHaveLength(200);
    expect(listing.truncated).toBe(true);
  });
  it.each(["win32", "darwin", "freebsd"])(
    "fails closed on %s for otherwise valid reads and listings",
    async (platform) => {
      await writeFile(path.join(root, "safe.ts"), "private fixture content");
      const original = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        Object.defineProperty(process, "platform", { ...original, value: platform });
        expect(await read(root, { path: "safe.ts" })).toEqual(rejected);
        expect(await executeCodexDynamicTool(root, "zet_workspace_list", {})).toEqual(rejected);
      } finally {
        Object.defineProperty(process, "platform", original);
      }
    },
  );
  it.each([".ssh", ".codex"])("rejects %s selected as the workspace root", async (name) => {
    const credentials = path.join(root, name);
    await mkdir(credentials);
    await writeFile(path.join(credentials, "config"), "private host data");
    expect((await read(credentials, { path: "config" })).success).toBe(false);
    expect((await executeCodexDynamicTool(credentials, "zet_workspace_list", {})).success).toBe(
      false,
    );
  });
  it("returns generic errors without private host paths", async () => {
    const result = await read(root, { path: "missing-sensitive-name" });
    expect(result.success).toBe(false);
    expect(result.contentItems[0]!.text).not.toContain(root);
    expect(result.contentItems[0]!.text).not.toContain("missing-sensitive-name");
  });
});
