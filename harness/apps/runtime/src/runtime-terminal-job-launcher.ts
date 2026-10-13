import { spawn } from "node:child_process";
import { mkdtemp, rm, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { WINDOWS_TERMINAL_JOB } from "./runtime-terminal-job-source.js";
export interface TerminalJobTransport {
  send(value: unknown): Promise<void>;
  terminate(): Promise<void>;
}
const quote = (value: string) => "'" + value.replace(/'/gu, "''") + "'";
export async function fixedHumanTerminalShell() {
  if (process.platform !== "win32") throw new Error("Windows ConPTY required.");
  const system = process.env["SystemRoot"];
  if (!system) throw new Error("Trusted Windows system directory unavailable.");
  const shell = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const info = await lstat(shell);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Fixed Windows shell unavailable.");
  return realpath(shell);
}
export async function launchTerminalJob(options: {
  windowsIdentity: string;
  onMessage: (value: unknown) => void;
  onExit: (code: number | null) => void;
  compileOnly?: boolean;
  onDiagnostic?: (text: string) => void;
}): Promise<TerminalJobTransport> {
  const shell = await fixedHumanTerminalShell();
  const tempRoot = await realpath(tmpdir());
  const directory = await realpath(await mkdtemp(join(tempRoot, "zet-terminal-job-")));
  if (!directory.startsWith(tempRoot + sep)) throw new Error("Terminal staging directory refused.");
  const worker = fileURLToPath(new URL("./runtime-terminal-pty-worker.js", import.meta.url));
  if (!options.compileOnly) {
    const info = await lstat(worker);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Trusted compiled PTY worker unavailable.");
  }
  const script =
    `$NodePath=${quote(process.execPath)};$WorkerPath=${quote(worker)};$Directory=${quote(directory)};$ExpectedIdentity=${quote(options.windowsIdentity)};$CompileOnly=$${options.compileOnly ? "true" : "false"};\n` +
    WINDOWS_TERMINAL_JOB.replace(/^param\([^\n]*\)\r?$/mu, "");
  const child = spawn(
    shell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      cwd: directory,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        SystemRoot: process.env["SystemRoot"]!,
        windir: process.env["SystemRoot"]!,
        TEMP: directory,
        TMP: directory,
        HOME: directory,
        USERPROFILE: directory,
        LOCALAPPDATA: directory,
        APPDATA: directory,
      },
    },
  );
  let ended = false;
  let terminating: Promise<void> | undefined;
  let failed = false;
  let pending = "";
  const decoder = new StringDecoder("utf8");
  let resolveClosed!: (code: number | null) => void;
  const closed = new Promise<number | null>((resolve) => {
    resolveClosed = resolve;
  });
  const fail = () => {
    if (failed) return;
    failed = true;
    options.onMessage({ kind: "failure", code: "terminal-native-failed" });
    child.kill();
  };
  child.stdout.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk);
    if (Buffer.byteLength(pending) > 262144) {
      fail();
      return;
    }
    let index: number;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (!line.trim()) continue;
      try {
        options.onMessage(JSON.parse(line) as unknown);
      } catch {
        fail();
        return;
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (options.compileOnly) options.onDiagnostic?.(chunk.toString("utf8").slice(0, 4096));
  });
  child.stdin.on("error", fail);
  child.on("error", fail);
  child.on("close", (code) => {
    ended = true;
    resolveClosed(code);
    options.onExit(code);
    void rm(directory, { recursive: true, force: true }).catch(() => {});
  });
  return {
    async send(value) {
      if (ended || failed) throw new Error("Terminal worker unavailable.");
      const line = JSON.stringify(value) + "\n";
      if (Buffer.byteLength(line) > 16384 || child.stdin.writableLength > 65536)
        throw new Error("Terminal input exceeds transport bounds.");
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(line, (error) => (error ? reject(error) : resolve()));
      });
    },
    async terminate() {
      if (ended) return;
      if (terminating) return terminating;
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 1500);
      let deadline: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Terminal Job cleanup could not be confirmed.")),
          5000,
        );
      });
      terminating = Promise.race([closed.then(() => {}), timeout]).finally(() => {
        clearTimeout(timer);
        clearTimeout(deadline);
      });
      return terminating;
    },
  };
}
/** Compile native interop and read inherited identity only; no PTY worker/shell launch. */
export async function preflightHumanTerminalJob(): Promise<{
  windowsIdentity: string;
  shell: string;
}> {
  let identity = "";
  let diagnostic = "";
  let rejectFailure!: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    rejectFailure = () =>
      reject(new Error("Terminal native bridge preflight failed. " + diagnostic));
    void launchTerminalJob({
      windowsIdentity: "",
      compileOnly: true,
      onDiagnostic: (text) => {
        diagnostic = (diagnostic + text).slice(0, 4096);
      },
      onMessage: (value) => {
        if (
          value &&
          typeof value === "object" &&
          "kind" in value &&
          value.kind === "native-ready" &&
          "windowsIdentity" in value &&
          typeof value.windowsIdentity === "string"
        )
          identity = value.windowsIdentity;
      },
      onExit: (code) => {
        if (code === 0 && identity) resolve();
        else rejectFailure();
      },
    }).catch(reject);
  });
  await ready;
  return { windowsIdentity: identity, shell: await fixedHumanTerminalShell() };
}
