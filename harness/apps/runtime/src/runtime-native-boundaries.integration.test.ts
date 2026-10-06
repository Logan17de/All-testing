import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedProcess } from "@zet-harness/tools";
import {
  buildManagedWorktreeCommand,
  createRuntimeWorktreeTools,
} from "./runtime-coding-worktrees.js";
import { runSandboxedProcess } from "./runtime-process-sandbox.js";
import type { AdapterInvocationContext } from "@zet-harness/plugin-api";
import {
  RuntimeCodingImageStore,
  type CodingImageAuthority,
} from "./runtime-coding-image-store.js";

function fixture() {
  let now = 1_000;
  let current = true;
  const authority: CodingImageAuthority = {
    runId: "run",
    sessionId: "session",
    modelId: "model",
    accountId: "account-digest",
    root: process.platform === "win32" ? "C:\\workspace" : "/workspace",
    desktopGeneration: 4,
  };
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  const store = new RuntimeCodingImageStore({ now: () => now, isCurrent: () => current });
  const part = store.createApprovedLease({
    authority,
    bytes,
    artifactId: "00000000-0000-0000-0000-000000000000",
    expiresAt: 2_000,
    maxUses: 8,
    approved: true,
  });
  return {
    authority,
    bytes,
    store,
    part,
    expire: () => {
      now = 2_000;
    },
    invalidate: () => {
      current = false;
    },
  };
}

it.skipIf(process.platform !== "linux")(
  "constructs only held read-only managed inspection mounts and refuses forged journal identity",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "zet-boundary-worktree-"));
    try {
      const root = join(await realpath(directory), "repo");
      const privateState = join(await realpath(directory), "private");
      await mkdir(root);
      await mkdir(privateState, { mode: 0o700 });
      expect(
        (await runBoundedProcess({ command: "git", args: ["init"], cwd: root, env: {} })).exitCode,
      ).toBe(0);
      let executions = 0;
      const tools = createRuntimeWorktreeTools({
        root,
        journalPath: join(privateState, "journal.json"),
        approve: () => Promise.resolve(true),
        sandbox: async (request, scope) => {
          const before = executions;
          const writing = scope.pendingCreation !== undefined;
          const runner: typeof runBoundedProcess = (invocation) => {
            executions++;
            expect(invocation.command).toBe("/usr/bin/bwrap");
            const args = invocation.args;
            expect(args).toContain("--unshare-all");
            expect(args).toContain("--clearenv");
            expect(args).not.toContain("--bind");
            expect(args.some((arg) => /^\/proc\/\d+\/fd\//u.test(arg))).toBe(false);
            if (!writing) expect(args).not.toContain("--bind-fd");
            const rootIndex = args.indexOf(root);
            expect(args[rootIndex - 2]).toBe("--ro-bind-fd");
            expect(args[rootIndex - 1]).toBe("3");
            const containerIndex = args.indexOf(join(root, ".zet-worktrees"));
            expect(args[containerIndex - 2]).toBe(writing ? "--bind-fd" : "--ro-bind-fd");
            expect(Number(args[containerIndex - 1])).toBeGreaterThanOrEqual(4);
            if (writing) {
              const gitIndex = args.indexOf(join(root, ".git"));
              expect(args[gitIndex - 2]).toBe("--bind-fd");
              expect(Number(args[gitIndex - 1])).toBeGreaterThanOrEqual(4);
              expect(args[gitIndex - 1]).not.toBe(args[containerIndex - 1]);
            }
            expect(args).not.toContain(privateState);
            return Promise.resolve({
              outcome: "exited",
              exitCode: 0,
              signal: null,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              durationMs: 0,
            });
          };
          await expect(
            runSandboxedProcess(request, runner, "linux", {
              ...scope,
              root: { ...scope.root, ino: "0" },
            }),
          ).rejects.toThrow("ownership");
          expect(executions).toBe(before);
          for (const args of [
            buildManagedWorktreeCommand("create", { name: "unowned", commit: "b".repeat(40) }),
            buildManagedWorktreeCommand("remove", { name: "unowned" }),
            buildManagedWorktreeCommand("create", { name: "task", commit: "b".repeat(40) }),
          ]) {
            await expect(
              runSandboxedProcess({ ...request, args }, runner, "linux", scope),
            ).rejects.toThrow();
          }
          expect(executions).toBe(before);
          return runSandboxedProcess(request, runner, "linux", scope);
        },
      });
      const context: AdapterInvocationContext = {
        runId: "fixture",
        logicalEffectId: "fixture",
        opIndex: 0,
        iteration: 0,
        attempt: 1,
        signal: new AbortController().signal,
        retryBudget: {
          maxAttempts: 1,
          repeatAuthorized: false,
          usedAttempts: 1,
          remainingAttempts: 0,
          reportInternalRetries: () => 0,
        },
      };
      await expect(
        tools[0]!.invoke({ name: "task", commit: "a".repeat(40) }, context),
      ).rejects.toThrow();
      expect(executions).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

describe("native image authority boundaries", () => {
  it("replaces prior run consent without reviving its opaque reference", async () => {
    const f = fixture();
    try {
      const replacement = f.store.createApprovedLease({
        authority: f.authority,
        bytes: f.bytes,
        artifactId: "11111111-1111-1111-1111-111111111111",
        expiresAt: 2_000,
        maxUses: 1,
        approved: true,
      });
      expect(f.store.partsFor(f.authority)).toEqual([replacement]);
      await expect(
        f.store.resolve(f.part.artifactRef, f.authority, new AbortController().signal),
      ).rejects.toThrow("unavailable");
      expect(
        (
          await f.store.resolve(replacement.artifactRef, f.authority, new AbortController().signal)
        )[0],
      ).toBe(137);
      await expect(
        f.store.resolve(replacement.artifactRef, f.authority, new AbortController().signal),
      ).rejects.toThrow("unavailable");
    } finally {
      f.store.clear();
    }
  });
  it("denies every cross-bound authority without consuming the approved budget", async () => {
    const f = fixture();
    try {
      for (const authority of [
        { ...f.authority, runId: "other" },
        { ...f.authority, sessionId: "other" },
        { ...f.authority, modelId: "other" },
        { ...f.authority, accountId: null },
        { ...f.authority, root: `${f.authority.root}/other` },
        { ...f.authority, desktopGeneration: 5 },
      ])
        await expect(
          f.store.resolve(f.part.artifactRef, authority, new AbortController().signal),
        ).rejects.toThrow("unavailable");
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () =>
          f.store.resolve(f.part.artifactRef, f.authority, new AbortController().signal),
        ),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(8);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(4);
      expect(f.store.partsFor(f.authority)).toEqual([]);
    } finally {
      f.store.clear();
    }
  });
  it("copies private bytes, denies cancelled resolves, and revokes expired or stale leases", async () => {
    const f = fixture();
    try {
      f.bytes.fill(0);
      const abort = new AbortController();
      abort.abort();
      await expect(f.store.resolve(f.part.artifactRef, f.authority, abort.signal)).rejects.toThrow(
        "unavailable",
      );
      const resolved = await f.store.resolve(
        f.part.artifactRef,
        f.authority,
        new AbortController().signal,
      );
      expect(resolved[0]).toBe(137);
      resolved.fill(0);
      expect(
        (await f.store.resolve(f.part.artifactRef, f.authority, new AbortController().signal))[0],
      ).toBe(137);
      f.invalidate();
      await expect(
        f.store.resolve(f.part.artifactRef, f.authority, new AbortController().signal),
      ).rejects.toThrow("unavailable");
    } finally {
      f.store.clear();
    }
    const expired = fixture();
    expired.expire();
    await expect(
      expired.store.resolve(
        expired.part.artifactRef,
        expired.authority,
        new AbortController().signal,
      ),
    ).rejects.toThrow("unavailable");
    expired.store.clear();
    const revoked = fixture();
    revoked.store.revokeRun(revoked.authority.runId);
    await expect(
      revoked.store.resolve(
        revoked.part.artifactRef,
        revoked.authority,
        new AbortController().signal,
      ),
    ).rejects.toThrow("unavailable");
    revoked.store.clear();
  });
});
