import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { WINDOWS_PROCESS_BRIDGE } from "./runtime-windows-process-sandbox.js";
import {
  executeWindowsSandboxedProjectScript,
  WINDOWS_PROJECT_COMMANDS,
} from "./runtime-windows-project-sandbox.js";

describe("experimental Windows project copy sandbox", () => {
  it("withholds unsupported commands and operating systems", async () => {
    await expect(
      executeWindowsSandboxedProjectScript({ cwd: tmpdir(), command: "project-install" as never }),
    ).rejects.toThrow("unsupported");
    if (process.platform !== "win32")
      await expect(
        executeWindowsSandboxedProjectScript({ cwd: tmpdir(), command: "project-test" }),
      ).rejects.toThrow("unavailable");
  });
  it("declares native private-copy exclusions and protected dependency permissions", () => {
    expect(WINDOWS_PROCESS_BRIDGE).toContain("privateFiles.Contains(Path.GetFullPath(entry))");
    expect(WINDOWS_PROCESS_BRIDGE).toContain("StringComparer.OrdinalIgnoreCase");
    expect(WINDOWS_PROCESS_BRIDGE).toContain("acl.SetAccessRuleProtection(true,false)");
    expect(WINDOWS_PROCESS_BRIDGE).toContain(
      'writable && !String.Equals(Path.GetFileName(entry),"node_modules",StringComparison.OrdinalIgnoreCase)',
    );
    expect(WINDOWS_PROCESS_BRIDGE).toContain('"S:(ML;OICI;NW;;;LW)"');
    expect(WINDOWS_PROCESS_BRIDGE).toContain('" run --ignore-scripts "+command.Substring(8)');
    expect(WINDOWS_PROCESS_BRIDGE).toContain("120000u:10000u");
    expect(WINDOWS_PROCESS_BRIDGE.indexOf("ProvePrivateHostDenied(pi.process)")).toBeLessThan(
      WINDOWS_PROCESS_BRIDGE.indexOf("Check(ResumeThread(pi.thread)"),
    );
    expect(WINDOWS_PROCESS_BRIDGE).toContain("CreatePrivateObjectSecurityEx(parent,IntPtr.Zero");
    expect(WINDOWS_PROCESS_BRIDGE).toContain("RequireKernelReadDenied(path,token,false)");
  });
  it.skipIf(process.platform !== "win32")(
    "requires trusted npm and rejects malformed private paths before launch",
    async () => {
      await expect(
        executeWindowsSandboxedProjectScript(
          { cwd: tmpdir(), command: "project-test" },
          { npmCliPath: "npm" },
        ),
      ).rejects.toThrow("trusted");
      await expect(
        executeWindowsSandboxedProjectScript(
          { cwd: tmpdir(), command: "project-test" },
          { npmCliPath: join(tmpdir(), "bin", "npm-cli.js"), privatePaths: ["relative.sqlite"] },
        ),
      ).rejects.toThrow("private state");
    },
  );
  it.skipIf(process.platform !== "win32")(
    "runs all four npm scripts with private state excluded, dependencies read-only and host/network denied",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zet-win-project-fixture-"));
      const outside = await mkdtemp(join(tmpdir(), "zet-win-project-outside-"));
      const server = createServer((socket) => socket.destroy());
      try {
        const npmCliPath = process.env["ZET_NPM_CLI"] ?? process.env["npm_execpath"];
        if (!npmCliPath)
          throw new Error("Native fixture requires trusted npm_execpath or ZET_NPM_CLI.");
        await mkdir(join(root, "NoDe_MoDuLeS", "demo"), { recursive: true });
        await mkdir(join(root, ".GiT"));
        await writeFile(join(root, ".GiT", "Config"), "synthetic Git config fixture");
        await writeFile(join(root, "node_modules", "demo", "data.txt"), "readonly dependency");
        await writeFile(
          join(root, "node_modules", "demo", "cache.sqlite"),
          "private dependency fixture",
        );
        await writeFile(join(root, "source.txt"), "host source unchanged");
        await writeFile(join(root, "state.sqlite"), "private runtime fixture");
        await writeFile(join(root, "state.sqlite-wal"), "private WAL fixture");
        await writeFile(join(root, ".env"), "synthetic credential fixture");
        const outsideFile = join(outside, "outside.txt");
        await writeFile(outsideFile, "outside fixture");
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No fixture port.");
        const source = `const fs=require('node:fs');const assert=require('node:assert/strict');
for(const file of ['state.sqlite','state.sqlite-wal','state.sqlite-shm','state.sqlite-journal','.env','.git/Config','node_modules/demo/cache.sqlite','node_modules/demo/cache.sqlite-wal'])assert.equal(fs.existsSync(file),false,file);
assert.equal(fs.readFileSync('node_modules/demo/data.txt','utf8'),'readonly dependency');
assert.throws(()=>fs.writeFileSync('node_modules/demo/data.txt','changed'));
assert.throws(()=>fs.renameSync('node_modules','moved-dependencies'));
assert.throws(()=>fs.rmSync('node_modules/demo/data.txt'));
assert.throws(()=>fs.readFileSync(${JSON.stringify(join(root, "state.sqlite"))}));
assert.throws(()=>fs.readFileSync(${JSON.stringify(outsideFile)}));
fs.writeFileSync('source.txt','private copied source');fs.writeFileSync('result.txt','private output');
const socket=require('node:net').connect({host:'127.0.0.1',port:${address.port}});
socket.once('connect',()=>process.exit(21));socket.once('error',()=>{console.log('project-private-copy-and-kernel-denial');process.exit(0)});setTimeout(()=>process.exit(22),3000);`;
        await writeFile(join(root, "check.cjs"), source);
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({
            scripts: {
              pretest: "node -e process.exit(99)",
              test: "node check.cjs",
              build: "node check.cjs",
              typecheck: "node check.cjs",
              lint: "node check.cjs",
            },
          }),
        );
        const privatePaths = [
          join(root, "STATE.SQLITE"),
          join(root, "state.sqlite-wal"),
          join(root, "state.sqlite-shm"),
          join(root, "state.sqlite-journal"),
          join(root, "node_modules", "demo", "cache.sqlite"),
          join(root, "node_modules", "demo", "cache.sqlite-wal"),
        ];
        for (const command of WINDOWS_PROJECT_COMMANDS) {
          const result = await executeWindowsSandboxedProjectScript(
            { cwd: root, command },
            { npmCliPath, privatePaths },
          );
          expect(result.outcome, result.stderr.slice(0, 4096)).toBe("exited");
          expect(result.exitCode, result.stderr.slice(0, 4096)).toBe(0);
          expect(result.stdout).toContain("project-private-copy-and-kernel-denial");
        }
        expect(await readFile(join(root, "source.txt"), "utf8")).toBe("host source unchanged");
        expect(await readFile(join(root, "state.sqlite"), "utf8")).toBe("private runtime fixture");
        expect(await readFile(join(root, "node_modules", "demo", "data.txt"), "utf8")).toBe(
          "readonly dependency",
        );
        await expect(readFile(join(root, "result.txt"))).rejects.toThrow();
      } finally {
        server.close();
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    },
    720_000,
  );
  it.skipIf(process.platform !== "win32")(
    "refuses source links and hardlinked private state before running scripts",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zet-win-project-links-"));
      const npmCliPath = process.env["ZET_NPM_CLI"] ?? process.env["npm_execpath"];
      if (!npmCliPath) throw new Error("Native fixture requires trusted npm.");
      try {
        const database = join(root, "state.sqlite");
        await writeFile(database, "private fixture");
        await link(database, join(root, "alias.sqlite"));
        await expect(
          executeWindowsSandboxedProjectScript(
            { cwd: root, command: "project-test" },
            { npmCliPath, privatePaths: [database] },
          ),
        ).rejects.toThrow("no host fallback");
        await rm(join(root, "alias.sqlite"));
        await symlink(root, join(root, "source-link"), "junction");
        await expect(
          executeWindowsSandboxedProjectScript(
            { cwd: root, command: "project-test" },
            { npmCliPath },
          ),
        ).rejects.toThrow("no host fallback");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    240_000,
  );
  it.skipIf(process.platform !== "win32")(
    "refuses ambient readable private files and file-only inheritance for absent sidecars",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zet-win-private-ambient-"));
      const npmCliPath = process.env["ZET_NPM_CLI"] ?? process.env["npm_execpath"];
      if (!npmCliPath) throw new Error("Native fixture requires trusted npm.");
      const icacls = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "icacls.exe");
      try {
        const database = join(root, "state.sqlite");
        await writeFile(database, "ambient private fixture");
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ scripts: { test: "node -e process.exit(99)" } }),
        );
        execFileSync(icacls, [database, "/grant", "*S-1-15-2-1:(R)"], { stdio: "pipe" });
        await expect(
          executeWindowsSandboxedProjectScript(
            { cwd: root, command: "project-test" },
            { npmCliPath, privatePaths: [database] },
          ),
        ).rejects.toThrow("project-private-host-access");
        execFileSync(icacls, [database, "/remove:g", "*S-1-15-2-1"], { stdio: "pipe" });
        execFileSync(icacls, [root, "/grant", "*S-1-15-2-1:(OI)(IO)(R)"], { stdio: "pipe" });
        await expect(
          executeWindowsSandboxedProjectScript(
            { cwd: root, command: "project-test" },
            { npmCliPath, privatePaths: [join(root, "state.sqlite-shm")] },
          ),
        ).rejects.toThrow("project-private-host-access");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    360_000,
  );
});
