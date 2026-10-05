import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ProcessRunRequest } from "@zet-harness/tools";
import { runSandboxedProcess } from "./runtime-process-sandbox.js";

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
