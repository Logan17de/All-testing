import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  executeWindowsSandboxedProjectCommand,
  probeWindowsProcessSandbox,
  validateWindowsProcessSandboxBridge,
  WINDOWS_PROCESS_BRIDGE,
} from "./runtime-windows-process-sandbox.js";

describe("Windows native process sandbox", () => {
  it("declares zero capabilities, handle allowlist and a non-breakaway kill job before resume", () => {
    expect(WINDOWS_PROCESS_BRIDGE).toContain("sc.sid=sid");
    expect(WINDOWS_PROCESS_BRIDGE).toContain("new IntPtr(0x20002)");
    expect(WINDOWS_PROCESS_BRIDGE).toContain("limits.limit.flags=0x2000");
    expect(
      WINDOWS_PROCESS_BRIDGE.indexOf(
        "Check(IsProcessInJob(pi.process,job,out assigned) && assigned)",
      ),
    ).toBeLessThan(WINDOWS_PROCESS_BRIDGE.indexOf("Check(ResumeThread(pi.thread)"));
  });
  it("refuses arbitrary project scripts", async () => {
    await expect(
      executeWindowsSandboxedProjectCommand({ cwd: process.cwd(), command: "project-test" }),
    ).rejects.toThrow();
  });
  it("runs fixed internal probes without filesystem main-script bootstrap", () => {
    expect(WINDOWS_PROCESS_BRIDGE).toContain('args="--input-type=commonjs -e "+Quote(source)');
    expect(WINDOWS_PROCESS_BRIDGE).not.toContain("File.WriteAllText(script,source)");
    expect(WINDOWS_PROCESS_BRIDGE).not.toContain('"probe.js"');
    expect(WINDOWS_PROCESS_BRIDGE).toContain('string source=command=="probe-hold" ?');
  });
  it.skipIf(process.platform === "win32")("fails closed on other platforms", async () => {
    await expect(
      executeWindowsSandboxedProjectCommand({ cwd: process.cwd(), command: "node-version" }),
    ).rejects.toThrow();
  });
  it.skipIf(process.platform !== "win32")(
    "compiles the actual interop",
    async () => {
      await validateWindowsProcessSandboxBridge();
    },
    160_000,
  );
  it.skipIf(process.platform !== "win32")(
    "runs copied Node with kernel outside-file and loopback denial",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zet-kernel-probe-"));
      const server = createServer((socket) => socket.destroy());
      try {
        await writeFile(join(root, "outside.txt"), "private probe");
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No probe port.");
        const result = await probeWindowsProcessSandbox({
          cwd: root,
          outside: join(root, "outside.txt"),
          port: address.port,
        });
        // Only fixed synthetic probes run here; bound child diagnostics for CI failures.
        expect(result.exitCode, result.stderr.slice(0, 4096)).toBe(0);
        expect(result.stdout.trim()).toBe("outside-file-and-network-denied");
        const version = await executeWindowsSandboxedProjectCommand({
          cwd: root,
          command: "node-version",
        });
        expect(version.exitCode, version.stderr.slice(0, 4096)).toBe(0);
        expect(version.stdout.trim()).toBe(process.version);
      } finally {
        server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
  it.skipIf(process.platform !== "win32")(
    "kills descendants at the native deadline",
    async () => {
      const result = await probeWindowsProcessSandbox({
        cwd: process.cwd(),
        outside: "",
        port: 1,
        hold: true,
      });
      expect(
        result.outcome,
        `exit=${result.exitCode}; stderr=${result.stderr.slice(0, 4096)}`,
      ).toBe("timed-out");
      const pid = Number(result.stdout.trim());
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    },
    160_000,
  );
  it.skipIf(process.platform !== "win32")(
    "bounds cancellation and cleans up",
    async () => {
      const controller = new AbortController();
      const started = Date.now();
      const pending = probeWindowsProcessSandbox({
        cwd: process.cwd(),
        outside: "",
        port: 1,
        hold: true,
        signal: controller.signal,
      });
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        await expect(pending).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(100_000);
      } finally {
        clearTimeout(timer);
      }
    },
    160_000,
  );
});
