import { spawn, type ChildProcess } from "node:child_process";

/**
 * Reason a bounded process run ended.
 *
 * `exited` covers a normal exit with any status code: a non-zero status is a
 * result, not a harness failure. The other outcomes mean the harness stopped
 * the process rather than the process finishing on its own.
 */
export type ProcessRunOutcome =
  "exited" | "timed-out" | "cancelled" | "output-limit" | "spawn-failed";

export interface ProcessRunLimits {
  /** Wall-clock budget for the whole run. */
  readonly timeoutMs?: number;
  /** Maximum bytes retained per stream before the run is stopped. */
  readonly maxOutputBytes?: number;
  /** Grace period between the polite signal and the forced tree kill. */
  readonly killGraceMs?: number;
}

export interface ProcessRunRequest {
  /** Executable name or absolute path. Never a shell command line. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Complete child environment. The parent environment is never inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly limits?: ProcessRunLimits;
  readonly signal?: AbortSignal;
}

export interface ProcessRunResult {
  readonly outcome: ProcessRunOutcome;
  /** Null when the process was killed before it could report a status. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576; // 1 MiB per stream
const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * Bounded byte sink.
 *
 * Chunks past the cap are dropped rather than buffered, so a process that
 * produces unbounded output cannot exhaust harness memory before the kill
 * lands.
 */
class BoundedOutput {
  readonly #chunks: Buffer[] = [];
  readonly #limit: number;
  #length = 0;
  #truncated = false;

  // An explicit field rather than a parameter property: Node's type-stripping
  // mode cannot execute parameter properties, and this repo runs .ts directly.
  constructor(limit: number) {
    this.#limit = limit;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  get exceeded(): boolean {
    return this.#truncated;
  }

  append(chunk: Buffer): void {
    if (this.#length >= this.#limit) {
      this.#truncated = true;
      return;
    }
    const remaining = this.#limit - this.#length;
    if (chunk.length > remaining) {
      this.#chunks.push(chunk.subarray(0, remaining));
      this.#length = this.#limit;
      this.#truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#length += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

/**
 * Terminate a child and everything it started.
 *
 * `child.kill()` signals only the direct child, which leaves grandchildren
 * running: a build tool that spawned a compiler keeps the CPU and the file
 * locks. Windows has no process groups usable from Node, so the whole tree is
 * killed through `taskkill /T`. POSIX children are spawned detached so the
 * negative PID addresses the process group.
 */
function terminateProcessTree(child: ChildProcess, force: boolean): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    if (!force) {
      // Windows has no graceful signal a console child reliably honours, so
      // the polite phase is a no-op and the forced kill does the work.
      return;
    }
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => undefined);
      killer.unref();
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process already exited.
      }
    }
    return;
  }

  try {
    // Negative PID targets the detached process group.
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      // The process already exited.
    }
  }
}

/**
 * Run one process under hard time, output, and cancellation bounds.
 *
 * The command is always spawned directly with an argument vector and
 * `shell: false`. No string is ever handed to a shell, so argument content
 * cannot become a second command regardless of what it contains. The child
 * receives exactly the supplied environment; the harness environment, which
 * may hold provider credentials, is never inherited.
 */
export async function runBoundedProcess(request: ProcessRunRequest): Promise<ProcessRunResult> {
  const timeoutMs = request.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = request.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const killGraceMs = request.limits?.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const startedAt = Date.now();

  if (request.signal?.aborted === true) {
    return Object.freeze({
      outcome: "cancelled" as const,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 0,
    });
  }

  const stdout = new BoundedOutput(maxOutputBytes);
  const stderr = new BoundedOutput(maxOutputBytes);

  return await new Promise<ProcessRunResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: { ...request.env },
        shell: false,
        windowsHide: true,
        // Detaching creates a POSIX process group so the whole tree can be
        // signalled together. Windows ignores this for grouping purposes.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      resolve(
        Object.freeze({
          outcome: "spawn-failed" as const,
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : "Process could not be started.",
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: Date.now() - startedAt,
        }),
      );
      return;
    }

    let outcome: ProcessRunOutcome = "exited";
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const stop = (reason: ProcessRunOutcome): void => {
      if (settled) return;
      // First stop reason wins: a timeout that races a cancellation should not
      // be relabelled by whichever kill lands second.
      if (outcome === "exited") outcome = reason;
      terminateProcessTree(child, false);
      graceTimer ??= setTimeout(() => {
        terminateProcessTree(child, true);
      }, killGraceMs);
      graceTimer.unref?.();
    };

    const onAbort = (): void => {
      stop("cancelled");
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        stop("timed-out");
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      if (stdout.exceeded) stop("output-limit");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
      if (stderr.exceeded) stop("output-limit");
    });

    const finish = (exitCode: number | null, signalCode: string | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve(
        Object.freeze({
          outcome,
          exitCode,
          signal: signalCode,
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          durationMs: Date.now() - startedAt,
        }),
      );
    };

    child.on("error", (error: Error) => {
      if (outcome === "exited") outcome = "spawn-failed";
      stderr.append(Buffer.from(error.message, "utf8"));
      finish(null, null);
    });

    // `close` rather than `exit`: the streams must be drained before the
    // captured output is reported, or a fast-exiting process loses its tail.
    child.on("close", (code: number | null, signalCode: NodeJS.Signals | null) => {
      finish(code, signalCode);
    });
  });
}

/**
 * Build a minimal child environment.
 *
 * The harness process environment can hold provider API keys, so it is never
 * passed through. Only the variables a process needs to start are copied, plus
 * whatever the host explicitly adds.
 */
export function createMinimalEnvironment(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const passthrough =
    process.platform === "win32"
      ? ["PATH", "Path", "PATHEXT", "SystemRoot", "windir", "COMSPEC", "TEMP", "TMP", "USERPROFILE"]
      : ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "TZ"];

  const env: Record<string, string> = {};
  for (const key of passthrough) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}
