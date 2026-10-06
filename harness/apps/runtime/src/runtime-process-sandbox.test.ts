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
      expect(captured?.args).toContain("/tmp/zet-user.npmrc");
      expect(captured?.args).toContain("/tmp/zet-global.npmrc");
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

const successfulFixture = {
  outcome: "exited" as const,
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 1,
};
// Explicit runner fixtures inspect prepared namespace/snapshot boundaries.
// They do not prove live OS namespace availability or run a hostile script on the host.
it.runIf(process.platform === "linux")(
  "masks exact custom DB and absent sidecars including Git metadata",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-private-process-"));
    try {
      await mkdir(join(root, ".git"));
      const database = join(root, ".git", "custom.data");
      await writeFile(database, "private-fixture-only");
      let captured: ProcessRunRequest | undefined;
      await runSandboxedProcess(
        { command: process.execPath, args: ["--version"], cwd: root, env: {} },
        (request) => {
          captured = request;
          return Promise.resolve(successfulFixture);
        },
        "linux",
        undefined,
        [database, database + "-wal", database + "-shm"],
      );
      for (const name of ["custom.data", "custom.data-wal", "custom.data-shm"]) {
        const target = "/workspace/.git/" + name;
        expect(captured?.args).toContain(target);
        const index = captured!.args.indexOf(target);
        expect(captured!.args.slice(index - 2, index)).toEqual(["--ro-bind", "/dev/null"]);
      }
      expect(JSON.stringify(captured)).not.toContain("private-fixture-only");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === "linux")(
  "private snapshot and dependency containers exclude DB and future sidecars",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-private-project-"));
    const npmRoot = await mkdtemp(join(tmpdir(), "zet-private-npm-"));
    try {
      await mkdir(join(npmRoot, "bin"));
      await writeFile(join(npmRoot, "bin/npm-cli.js"), "fixture");
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ scripts: { test: "attempt private-state reads" } }),
      );
      await mkdir(join(root, "node_modules/pkg"), { recursive: true });
      const database = join(root, "custom.data");
      const dependencyDatabase = join(root, "node_modules/pkg/custom.data");
      await writeFile(database, "private-runtime-fixture");
      await writeFile(dependencyDatabase, "private-dependency-fixture");
      await writeFile(join(root, "node_modules/pkg/safe.js"), "safe dependency");
      await runSandboxedProjectCommand(
        { cwd: root, command: "project-test" },
        {
          npmCliPath: join(npmRoot, "bin/npm-cli.js"),
          privatePaths: [
            database,
            database + "-wal",
            database + "-shm",
            dependencyDatabase,
            dependencyDatabase + "-wal",
            dependencyDatabase + "-shm",
          ],
          runner: async (request) => {
            const snapshot = request.args[request.args.indexOf("--bind") + 1]!;
            for (const path of [
              "custom.data",
              "custom.data-wal",
              "custom.data-shm",
              "node_modules/pkg/custom.data",
              "node_modules/pkg/custom.data-wal",
              "node_modules/pkg/custom.data-shm",
            ])
              await expect(readFile(join(snapshot, path))).rejects.toMatchObject({
                code: "ENOENT",
              });
            expect(await readFile(join(snapshot, "node_modules/pkg/safe.js"), "utf8")).toBe(
              "safe dependency",
            );
            expect(request.args).not.toContain("/workspace/node_modules/pkg");
            await writeFile(dependencyDatabase + "-wal", "future private WAL");
            await expect(
              readFile(join(snapshot, "node_modules/pkg/custom.data-wal")),
            ).rejects.toMatchObject({ code: "ENOENT" });
            const marker = request.args.find((argument) =>
              argument.startsWith("ZET_SANDBOX_READY_"),
            )!;
            return { ...successfulFixture, stderr: marker + "\n" };
          },
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(npmRoot, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === "linux")(
  "refuses private aliases and hardlinks before runner effects",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-private-alias-"));
    try {
      const database = join(root, "custom.data");
      await writeFile(database, "private fixture");
      await symlink(database, join(root, "alias.txt"));
      let calls = 0;
      const runner = () => {
        calls++;
        return Promise.resolve(successfulFixture);
      };
      const request = { command: process.execPath, args: ["--version"], cwd: root, env: {} };
      await expect(
        runSandboxedProcess(request, runner, "linux", undefined, [database]),
      ).rejects.toThrow("Linked");
      await rm(join(root, "alias.txt"));
      await link(database, join(root, "hard.txt"));
      await expect(
        runSandboxedProcess(request, runner, "linux", undefined, [database]),
      ).rejects.toThrow("Linked");
      expect(calls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === "linux")(
  "rejects private files intersecting directly exposed runtime mounts",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-private-runtime-"));
    const npmRoot = await mkdtemp(join(tmpdir(), "zet-private-runtime-npm-"));
    try {
      await mkdir(join(npmRoot, "bin"));
      await writeFile(join(npmRoot, "bin/npm-cli.js"), "fixture");
      const database = join(npmRoot, "custom.data");
      await writeFile(database, "private fixture");
      let calls = 0;
      const runner = () => {
        calls++;
        return Promise.resolve(successfulFixture);
      };
      await expect(
        runSandboxedProjectCommand(
          { cwd: root, command: "project-test" },
          {
            npmCliPath: join(npmRoot, "bin/npm-cli.js"),
            privatePaths: [database],
            runner,
          },
        ),
      ).rejects.toThrow("trusted runtime mount");
      await expect(
        runSandboxedProcess(
          { command: process.execPath, args: ["--version"], cwd: root, env: {} },
          runner,
          "linux",
          undefined,
          ["/usr/custom-private-db"],
        ),
      ).rejects.toThrow("trusted runtime mount");
      expect(calls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(npmRoot, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === "linux")(
  "rejects externally configured DB symlink targeting ordinary workspace data",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-external-private-target-"));
    const external = await mkdtemp(join(tmpdir(), "zet-external-private-link-"));
    const npmRoot = await mkdtemp(join(tmpdir(), "zet-external-private-npm-"));
    try {
      await mkdir(join(npmRoot, "bin"));
      await writeFile(join(npmRoot, "bin/npm-cli.js"), "fixture");
      const actualDatabase = join(root, "ordinary.data");
      const configuredDatabase = join(external, "state.db");
      await writeFile(actualDatabase, "private fixture");
      await symlink(actualDatabase, configuredDatabase);
      let calls = 0;
      const runner = () => {
        calls++;
        return Promise.resolve(successfulFixture);
      };
      await expect(
        runSandboxedProjectCommand(
          { cwd: root, command: "project-test" },
          {
            npmCliPath: join(npmRoot, "bin/npm-cli.js"),
            privatePaths: [configuredDatabase],
            runner,
          },
        ),
      ).rejects.toThrow("Linked private state refused");
      await expect(
        runSandboxedProcess(
          { command: process.execPath, args: ["--version"], cwd: root, env: {} },
          runner,
          "linux",
          undefined,
          [configuredDatabase],
        ),
      ).rejects.toThrow("Linked private state refused");
      expect(calls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
      await rm(npmRoot, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === "linux")(
  "refuses Git writes when private state intersects writable metadata",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-private-git-write-"));
    try {
      const { buildGitCommand } = await import("./runtime-git-command.js");
      await mkdir(join(root, ".git"));
      const database = join(root, ".git/custom.data");
      await writeFile(database, "private fixture");
      let calls = 0;
      await expect(
        runSandboxedProcess(
          {
            command: "git",
            args: buildGitCommand("add", { paths: ["source.txt"] }),
            cwd: root,
            env: {},
          },
          () => {
            calls++;
            return Promise.resolve(successfulFixture);
          },
          "linux",
          undefined,
          [database],
        ),
      ).rejects.toThrow("writable Git metadata");
      expect(calls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === "linux")(
  "masks repository Git config with a synthetic regular inherited file",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zet-git-config-fixture-"));
    try {
      await mkdir(join(root, ".git"));
      await writeFile(join(root, ".git/config"), "credential-fixture-must-not-forward");
      let captured: ProcessRunRequest | undefined;
      await runSandboxedProcess(
        { command: process.execPath, args: ["--version"], cwd: root, env: {} },
        (request) => {
          captured = request;
          return Promise.resolve(successfulFixture);
        },
        "linux",
      );
      const index = captured!.args.indexOf("/workspace/.git/config");
      expect(index).toBeGreaterThan(1);
      expect(captured!.args[index - 2]).toBe("--ro-bind-fd");
      expect(Number(captured!.args[index - 1])).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(captured)).not.toContain("credential-fixture-must-not-forward");
      expect(await readFile(join(root, ".git/config"), "utf8")).toBe(
        "credential-fixture-must-not-forward",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
