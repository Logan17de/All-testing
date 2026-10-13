import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WINDOWS_BROWSER_JOB } from "./runtime-browser-worker-launcher.js";
it("owns a kill-on-close job and assigns fixed worker before resume without security setters", () => {
  expect(WINDOWS_BROWSER_JOB).toContain("limit.limit.flags=0x2000");
  expect(WINDOWS_BROWSER_JOB).toContain("new IntPtr(0x2000D)");
  expect(WINDOWS_BROWSER_JOB.indexOf("IsProcessInJob(pi.process,job")).toBeLessThan(
    WINDOWS_BROWSER_JOB.indexOf("ResumeThread(pi.thread)"),
  );
  expect(WINDOWS_BROWSER_JOB).not.toMatch(/CreateAppContainer|SetAccessControl|icacls|BREAKAWAY/u);
});
it.skipIf(process.platform !== "win32")(
  "compiles fixed Windows job helper without launching worker or browser",
  async () => {
    const source =
      "$CompileOnly=$true;\n" + WINDOWS_BROWSER_JOB.replace(/^param\([^\n]*\)\r?$/mu, "");
    const result = await promisify(execFile)(
      join(process.env["SystemRoot"]!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(source, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 20000, maxBuffer: 65536 },
    );
    expect(result.stdout.trim()).toBe("");
  },
  25000,
);

it.skipIf(process.platform !== "win32")(
  "contains a benign worker assertion and terminates its exact owned descendant",
  async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "zet-browser-job-fixture-"));
    const worker = join(root, "benign-worker.cjs");
    const quote = (value: string) => "'" + value.replace(/'/gu, "''") + "'";
    try {
      await writeFile(
        worker,
        "const {spawn}=require('node:child_process');console.error('2026-10-06T00:00:00.000Z pw:protocol SEND '+String.fromCharCode(0x25ba)+' '+JSON.stringify({id:91,method:'Page.enable',params:{credential:'PRIVATE_BODY_MARKER'}}));console.error('2026-10-06T00:00:00.000Z pw:protocol '+String.fromCharCode(0x25c0)+' RECV '+JSON.stringify({id:91,result:{body:'PRIVATE_BODY_MARKER'}}));console.error('PRIVATE_BODY_MARKER'.repeat(1000));const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log(JSON.stringify({pid:child.pid}));setTimeout(()=>{throw new Error('synthetic worker assertion')},200);",
      );
      const source =
        `$NodePath=${quote(process.execPath)};$WorkerPath=${quote(worker)};$Directory=${quote(root)};$CompileOnly=$false;\n` +
        WINDOWS_BROWSER_JOB.replace(/^param\([^\n]*\)\r?$/mu, "");
      let output = "";
      let code: unknown;
      try {
        await promisify(execFile)(
          join(
            process.env["SystemRoot"]!,
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(source, "utf16le").toString("base64"),
          ],
          { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
        );
      } catch (error) {
        const failure = error as { stdout?: string; code?: unknown };
        output = failure.stdout ?? "";
        code = failure.code;
      }
      expect(code).toBe(1);
      expect(output).not.toContain("PRIVATE_BODY_MARKER");
      expect(output).toContain(
        JSON.stringify({
          kind: "protocol",
          name: "Page.enable",
          sent: 1,
          received: 1,
          events: 0,
          outstanding: 0,
        }),
      );
      const metadata = output
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as { pid?: number })
        .find((item) => item.pid !== undefined) as { pid: number };
      expect(Number.isInteger(metadata.pid)).toBe(true);
      expect(() => process.kill(metadata.pid, 0)).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);

it.skipIf(process.platform !== "win32")(
  "uses canonical scratch paths in actual fixed helper environment without security changes",
  async () => {
    const { mkdtemp, rm, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { canonicalBrowserWorkerDirectory } =
      await import("./runtime-browser-worker-launcher.js");
    const original = await mkdtemp(join(tmpdir(), "zet-browser-canonical-"));
    const directory = await canonicalBrowserWorkerDirectory(original);
    try {
      expect(directory).toBe(await realpath(original));
      const env: NodeJS.ProcessEnv = {
        TEMP: directory,
        TMP: directory,
        HOME: directory,
        USERPROFILE: directory,
      };
      for (const key of [
        "SystemRoot",
        "WINDIR",
        "PATH",
        "LOCALAPPDATA",
        "PLAYWRIGHT_BROWSERS_PATH",
      ])
        if (process.env[key]) env[key] = process.env[key];
      const source =
        "$CompileOnly=$true;\n" + WINDOWS_BROWSER_JOB.replace(/^param\([^\n]*\)\r?$/mu, "");
      const result = await promisify(execFile)(
        join(process.env["SystemRoot"]!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(source, "utf16le").toString("base64"),
        ],
        { cwd: directory, env, windowsHide: true, timeout: 15000, maxBuffer: 65536 },
      );
      expect(result.stdout.trim()).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  20000,
);

it("classifies only fixed browser-process signatures without returning private log text", async () => {
  const { classifyBrowserWorkerStderr, BROWSER_STDERR_SIGNATURES } =
    await import("./runtime-browser-worker-launcher.js");
  for (const [signature, code] of BROWSER_STDERR_SIGNATURES) {
    expect(classifyBrowserWorkerStderr(`private-path private-cookie ${signature} secret`)).toBe(
      code,
    );
    expect(WINDOWS_BROWSER_JOB).toContain(`text.Contains(${JSON.stringify(signature)})`);
  }
  expect(
    classifyBrowserWorkerStderr("Access is denied private arbitrary renderer failure"),
  ).toBeUndefined();
  expect(classifyBrowserWorkerStderr("pw:browser <launched> pid=123")).toBeUndefined();
  expect(
    classifyBrowserWorkerStderr("Assertion error\n_CRSession._onMessage private-protocol"),
  ).toBe("protocol-assertion");
  expect(WINDOWS_BROWSER_JOB).toContain("evidence.Length<8192");
  expect(WINDOWS_BROWSER_JOB).toContain("emitted.Add(diagnosticCode)");
});

it("maps fixed subprocess exit categories and ignores nonnumeric status without raw output", async () => {
  const { classifyBrowserWorkerStderr } = await import("./runtime-browser-worker-launcher.js");
  expect(
    classifyBrowserWorkerStderr("process did exit: exitCode=0, signal=null PRIVATE_BODY"),
  ).toBe("browser-exit-zero");
  expect(
    classifyBrowserWorkerStderr("process did exit: exitCode=1, signal=null PRIVATE_BODY"),
  ).toBe("browser-exit-one");
  expect(
    classifyBrowserWorkerStderr("process did exit: exitCode=42, signal=null PRIVATE_BODY"),
  ).toBe("browser-exit-other");
  expect(
    classifyBrowserWorkerStderr("process did exit: exitCode=PRIVATE_BODY, signal=null"),
  ).toBeUndefined();
});
