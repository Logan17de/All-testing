import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexWorkspacePermissionGrant } from "./runtime-codex-permissions.js";
describe("native workspace-only permission subset", () => {
  it("validates canonical requested paths and refuses network, newer schemas and symlink escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-permissions-"));
    const request = (permissions: unknown) => ({
      threadId: "t",
      turnId: "v",
      itemId: "i",
      startedAtMs: 0,
      reason: null,
      cwd: root,
      environmentId: null,
      permissions,
    });
    try {
      const file = join(root, "safe.txt");
      await writeFile(file, "fixture");
      await mkdir(join(root, ".codex"));
      await writeFile(join(root, ".env"), "fixture");
      await symlink(tmpdir(), join(root, "escape"));
      expect(
        await buildCodexWorkspacePermissionGrant(
          root,
          request({ network: null, fileSystem: { read: [file, file], write: [file] } }),
        ),
      ).toEqual({ fileSystem: { read: [file], write: [file] } });
      for (const profile of [
        { network: { enabled: true }, fileSystem: null },
        { network: null, fileSystem: { read: [root], write: null } },
        { network: null, fileSystem: { read: [tmpdir()], write: null } },
        { network: null, fileSystem: { read: [join(root, "escape")], write: null } },
        { network: null, fileSystem: { read: [join(root, ".env")], write: null } },
        { network: null, fileSystem: { read: [join(root, ".codex")], write: null } },
        { network: null, fileSystem: { read: null, write: null, entries: [] } },
        { network: null, fileSystem: { read: null, write: null, globScanMaxDepth: 4 } },
        { network: null, fileSystem: { read: [join(root, "missing")], write: null } },
      ])
        await expect(buildCodexWorkspacePermissionGrant(root, request(profile))).rejects.toThrow();
      await expect(
        buildCodexWorkspacePermissionGrant(root, {
          ...request({ network: null, fileSystem: null }),
          environmentId: "external",
        }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
