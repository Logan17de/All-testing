/** Fixed human ConPTY worker. Started inside a native kill-on-close Job Object,
 * never from the agent tool inventory. Native dependencies load only here. */
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { join } from "node:path";
interface Pty {
  write(text: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pause(): void;
  resume(): void;
  onData(callback: (text: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number }) => void): { dispose(): void };
}
interface NativePty {
  spawn(
    file: string,
    args: string[],
    options: {
      cwd: string;
      cols: number;
      rows: number;
      env: Record<string, string>;
      useConpty: boolean;
      useConptyDll: boolean;
      handleFlowControl: boolean;
    },
  ): Pty;
}
const require = createRequire(import.meta.url);
const ptyModule = require("node-pty") as NativePty;
let pty: Pty | undefined;
let nonce = "";
let expires = 0;
let launched = false;
let ending = false;
let lastRequest = 0;
const exact = (message: Record<string, unknown>, keys: string[]) =>
  Object.keys(message).length === keys.length && keys.every((key) => Object.hasOwn(message, key));
const frame = (value: unknown) => {
  const data = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(data) > 131072 || process.stdout.writableLength > 262144) {
    void shutdown();
    return false;
  }
  return process.stdout.write(data);
};
const valid = () => pty && !ending && Date.now() < expires;
const shutdown = () => {
  if (ending) return;
  ending = true;
  try {
    pty?.kill();
  } catch {}
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("uncaughtException", () => {
  frame({ kind: "failure", code: "terminal-worker-failed" });
  shutdown();
});
process.on("unhandledRejection", () => {
  frame({ kind: "failure", code: "terminal-worker-failed" });
  shutdown();
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("close", shutdown);
lines.on("line", (line) => {
  if (Buffer.byteLength(line) > 16384) {
    shutdown();
    return;
  }
  try {
    const v: unknown = JSON.parse(line);
    if (!v || typeof v !== "object") throw new Error();
    const message = v as Record<string, unknown>;
    if (message.kind === "launch") {
      if (launched) throw new Error();
      launched = true;
      if (!exact(message, ["kind", "cwd", "shell", "nonce", "expiresAt", "cols", "rows"]))
        throw new Error();
      if (
        typeof message.cwd !== "string" ||
        typeof message.shell !== "string" ||
        typeof message.nonce !== "string" ||
        !/^[A-Za-z0-9_-]{32,128}$/u.test(message.nonce) ||
        !Number.isSafeInteger(message.expiresAt) ||
        Number(message.expiresAt) <= Date.now() ||
        !Number.isInteger(message.cols) ||
        Number(message.cols) < 10 ||
        Number(message.cols) > 300 ||
        !Number.isInteger(message.rows) ||
        Number(message.rows) < 2 ||
        Number(message.rows) > 120
      )
        throw new Error();
      const system = process.env["SystemRoot"];
      if (!system) throw new Error();
      const fixedShell = realpathSync(
        join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      );
      if (message.shell !== fixedShell || realpathSync(message.cwd) !== message.cwd)
        throw new Error();
      nonce = message.nonce;
      expires = Number(message.expiresAt);
      pty = ptyModule.spawn(fixedShell, ["-NoLogo", "-NoProfile"], {
        cwd: message.cwd,
        cols: Number(message.cols),
        rows: Number(message.rows),
        env: {
          SystemRoot: system,
          windir: system,
          PATH:
            join(system, "System32") + ";" + join(system, "System32", "WindowsPowerShell", "v1.0"),
          TEMP: process.env["TEMP"] ?? message.cwd,
          TMP: process.env["TMP"] ?? message.cwd,
          HOME: message.cwd,
          USERPROFILE: message.cwd,
        },
        useConpty: true,
        useConptyDll: false,
        handleFlowControl: false,
      });
      pty.onData((text) => {
        for (let i = 0; i < text.length; i += 16384) {
          if (!frame({ kind: "output", text: text.slice(i, i + 16384) })) {
            pty?.pause();
            process.stdout.once("drain", () => {
              if (!ending) pty?.resume();
            });
          }
        }
      });
      pty.onExit((event) => {
        frame({ kind: "exit", exitCode: event.exitCode });
        process.exitCode = 0;
        ending = true;
        lines.close();
        setTimeout(() => process.exit(0), 100).unref();
      });
      const timer = setTimeout(shutdown, Math.max(1, expires - Date.now()));
      timer.unref();
      frame({
        kind: "ready",
        cols: Number(message.cols),
        rows: Number(message.rows),
        pid: process.pid,
      });
      return;
    }
    if (message.kind === "close") {
      if (!exact(message, ["kind"])) throw new Error();
      shutdown();
      return;
    }
    if (
      !valid() ||
      message.nonce !== nonce ||
      !Number.isSafeInteger(message.requestId) ||
      Number(message.requestId) <= lastRequest
    )
      throw new Error();
    lastRequest = Number(message.requestId);
    if (message.kind === "input") {
      if (
        !exact(message, ["kind", "nonce", "requestId", "text"]) ||
        typeof message.text !== "string" ||
        !message.text ||
        message.text.length > 4096
      )
        throw new Error();
      pty!.write(message.text);
    } else if (message.kind === "resize") {
      if (
        !exact(message, ["kind", "nonce", "requestId", "cols", "rows"]) ||
        !Number.isInteger(message.cols) ||
        Number(message.cols) < 10 ||
        Number(message.cols) > 300 ||
        !Number.isInteger(message.rows) ||
        Number(message.rows) < 2 ||
        Number(message.rows) > 120
      )
        throw new Error();
      pty!.resize(Number(message.cols), Number(message.rows));
    } else if (message.kind === "interrupt") {
      if (!exact(message, ["kind", "nonce", "requestId"])) throw new Error();
      // ConPTY Ctrl-C is queued input. The acknowledgement below does not claim
      // the foreground command has cancelled or that PowerShell is ready again.
      pty!.write("\x03");
    } else throw new Error();
    frame({ kind: "ack", requestId: message.requestId });
  } catch {
    frame({ kind: "failure", code: "terminal-request-refused" });
    shutdown();
  }
});
frame({ kind: "worker-ready" });
