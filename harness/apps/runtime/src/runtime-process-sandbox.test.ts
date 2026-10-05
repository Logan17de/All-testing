import { mkdtemp, writeFile, rm, mkdir, readFile, readlink, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ProcessRunRequest } from "@zet-harness/tools";
import {
  runSandboxedProcess,
  runSandboxedProjectCommand,
  readProjectSnapshotBytes,
} from "./runtime-process-sandbox.js";

it("refuses host execution and unsupported OS without fallback", async () => {
  let called = false;
  const runner = () => {
    called = true;
    return Promise.reject(new Error("must not execute"));
  };
  const request = { command: process.execPath, args: ["--version"], cwd: tmpdir(), env: {} };
  await expect(runSandboxedProcess(request, runner, "win32")).rejects.toThrow("unavailable");
  await expect(
    runSandboxedProcess({ ...request, args: ["-e", "dangerous"] }, runner),
  ).rejects.toThrow("refused");
  expect(called).toBe(false);
});
it.runIf(process.platform === "linux")(
  "builds a separate network/filesystem boundary and refuses failed isolation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-sandbox-"));
    try {
      await writeFile(join(root, ".env"), "fixture only");
      let captured: ProcessRunRequest | undefined;
      await expect(
        runSandboxedProcess(
          {
            command: process.execPath,
            args: ["--version"],
            cwd: root,
            env: { PRIVATE: "must not forward" },
          },
          (request) => {
            captured = request;
            return Promise.resolve({
              outcome: "exited",
              exitCode: 1,
              signal: null,
              stdout: "",
              stderr: "fixture failure",
              stdoutTruncated: false,
              stderrTruncated: false,
              durationMs: 1,
            });
          },
        ),
      ).rejects.toThrow("no host fallback");
      expect(captured?.command).toBe("/usr/bin/bwrap");
      expect(captured?.args).toContain("--unshare-all");
      expect(captured?.args).toContain("/workspace/.env");
      expect(captured?.env).toEqual({});
      expect(JSON.stringify(captured)).not.toContain("must not forward");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it.runIf(process.platform === "linux")(
  "runs fixed project scripts in private source copy with no credentials or host fallback",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-project-fixture-"));
    const npmRoot = await mkdtemp(join(tmpdir(), "zet-npm-fixture-"));
    let captured: ProcessRunRequest | undefined;
    try {
      await mkdir(join(npmRoot, "bin"));
      await writeFile(join(npmRoot, "bin/npm-cli.js"), "fixture");
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ scripts: { test: "test fixture" } }),
      );
      await writeFile(join(root, ".env"), "private fixture");
      await writeFile(join(root, "source.ts"), "unchanged");
      await mkdir(join(root, "node_modules/pkg"), { recursive: true });
      await mkdir(join(root, "node_modules/.bin"));
      await writeFile(join(root, "node_modules/pkg/bin.js"), "fixturedependency");
      await symlink("../pkg/bin.js", join(root, "node_modules/.bin/tool"));
      await mkdir(join(root, ".next"));
      await writeFile(join(root, ".next", "generated.bin"), Buffer.alloc(8_388_609));
      const result = await runSandboxedProjectCommand(
        { cwd: root, command: "project-test" },
        {
          npmCliPath: join(npmRoot, "bin/npm-cli.js"),
          runner: async (request) => {
            captured = request;
            const args = request.args;
            const privateRoot = args[args.indexOf("--bind") + 1]!;
            expect(await readFile(join(privateRoot, "source.ts"), "utf8")).toBe("unchanged");
            expect(await readlink(join(privateRoot, "node_modules/.bin/tool"))).toBe(
              "/workspace/node_modules/pkg/bin.js",
            );
            await mkdir(join(privateRoot, "node_modules/.vite"));
            await writeFile(join(privateRoot, "node_modules/.vite/result"), "privatecache");
            expect(args).toContain("/workspace/node_modules/pkg");
            await expect(readFile(join(privateRoot, ".env"))).rejects.toThrow();
            await writeFile(join(privateRoot, "source.ts"), "sandbox mutation");
            const marker = args.find((arg) => arg.startsWith("ZET_SANDBOX_READY_"))!;
            return {
              outcome: "exited",
              exitCode: 1,
              signal: null,
              stdout: "test failure",
              stderr: `${marker}\nfixture assertion`,
              stdoutTruncated: false,
              stderrTruncated: false,
              durationMs: 1,
            };
          },
        },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("fixture assertion");
      expect(await readFile(join(root, "source.ts"), "utf8")).toBe("unchanged");
      expect(captured?.args.slice(-4)).toEqual([
        "/zet-npm/bin/npm-cli.js",
        "run",
        "--ignore-scripts",
        "test",
      ]);
      expect(captured?.env).toEqual({});
      expect(captured?.args).toContain("--unshare-all");
      expect(captured?.limits?.timeoutMs).toBe(120000);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(npmRoot, { recursive: true, force: true });
    }
  },
);
it("refuses unsupported project commands without runner effects", async () => {
  const runner = () => Promise.reject(new Error("must not execute"));
  await expect(
    runSandboxedProjectCommand({ cwd: tmpdir(), command: "project-install" as never }, { runner }),
  ).rejects.toThrow("refused");
});
it.runIf(process.platform === "linux")(
  "rejects source links before sandbox runner execution",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-project-link-"));
    const npmRoot = await mkdtemp(join(tmpdir(), "zet-npm-link-"));
    let calls = 0;
    try {
      await mkdir(join(npmRoot, "bin"));
      await writeFile(join(npmRoot, "bin/npm-cli.js"), "fixture");
      await writeFile(join(root, "ordinary.ts"), "fixture");
      await symlink(join(root, "ordinary.ts"), join(root, "linked.ts"));
      const options = {
        npmCliPath: join(npmRoot, "bin/npm-cli.js"),
        runner: () => {
          calls++;
          return Promise.reject(new Error("must not execute"));
        },
      };
      await expect(
        runSandboxedProjectCommand({ cwd: root, command: "project-test" }, options),
      ).rejects.toThrow("links refused");
      await rm(join(root, "linked.ts"));
      await link(join(root, "ordinary.ts"), join(root, "hard.ts"));
      await expect(
        runSandboxedProjectCommand({ cwd: root, command: "project-test" }, options),
      ).rejects.toThrow("file limit");
      expect(calls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(npmRoot, { recursive: true, force: true });
    }
  },
);
it("concurrently growing snapshot files use only the initial size plus one byte", async () => {
  let allocated = 0;
  await expect(
    readProjectSnapshotBytes(
      {
        read: (buffer) => {
          allocated = buffer.length;
          return Promise.resolve({ bytesRead: buffer.length });
        },
        stat: () => Promise.resolve({ size: 100_000_000, mtimeMs: 2, nlink: 1 }),
      },
      { size: 1, mtimeMs: 1, nlink: 1 },
    ),
  ).rejects.toThrow("changed");
  expect(allocated).toBe(2);
});
