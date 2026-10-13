import { mkdtemp, rm } from "node:fs/promises";
import type { BrowserExecutableMetadata } from "./runtime-browser-worker-metadata.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchBrowserWorker,
  BROWSER_STARTUP_PROTOCOL_NAMES,
  canonicalBrowserWorkerDirectory,
  type BrowserWorkerTransport,
} from "./runtime-browser-worker-launcher.js";
import {
  checkedBrowserAction,
  type BrowserAction,
  type BrowserScope,
  type RuntimeBrowserDriver,
  type BrowserCapture,
  type BrowserWorkerPhase,
  type BrowserWorkerFailure,
  type BrowserProtocolCounts,
} from "./runtime-browser-session.js";
import type { BrowserPinnedAddress } from "./runtime-browser-policy.js";

const unavailable = () => new Error("Isolated browser unavailable or stopped");
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
/** Fixed host-owned worker; factory is a trusted test seam, never sourced from HTTP/model input. */
export async function createIsolatedBrowserDriver(
  options: {
    scope: BrowserScope;
    pins: BrowserPinnedAddress[];
    signal: AbortSignal;
    onFailure?: (
      stage?: BrowserWorkerPhase,
      code?: BrowserWorkerFailure,
      timings?: Partial<Record<BrowserWorkerPhase, number>>,
      protocol?: BrowserProtocolCounts,
      environment?: BrowserExecutableMetadata,
    ) => void;
  },
  factory: typeof launchBrowserWorker = launchBrowserWorker,
): Promise<RuntimeBrowserDriver> {
  options.signal.throwIfAborted();
  if (!options.pins.length || options.pins.length > 64) throw unavailable();
  const directory = await canonicalBrowserWorkerDirectory(
    await mkdtemp(join(tmpdir(), "zet-browser-worker-")),
  );
  let transport: BrowserWorkerTransport;
  try {
    transport = await factory(directory);
  } catch {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw unavailable();
  }
  const pending = new Map<number, Pending>();
  const protocol: BrowserProtocolCounts = {};
  let environment: BrowserExecutableMetadata | undefined;
  let next = 0;
  let initializing = true;
  const startupPhases = ["launch", "context", "routes", "page", "ready"] as const;
  const phaseBudgets = [12000, 5000, 5000, 5000, 1000];
  let startupPhaseIndex = -1;
  let phase: BrowserWorkerPhase = "worker-start";
  let failureCode: BrowserWorkerFailure = "worker-exit";
  let phaseStarted = performance.now();
  const timings: Partial<Record<BrowserWorkerPhase, number>> = {};
  const elapsed = () => Math.max(0, Math.min(60000, Math.round(performance.now() - phaseStarted)));
  let closed = false;
  let closing: Promise<void> | undefined;
  async function close() {
    if (closing) return closing;
    closed = true;
    options.signal.removeEventListener("abort", abort);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(unavailable());
    }
    pending.clear();
    closing = (async () => {
      try {
        transport.send({ id: ++next, kind: "close" });
      } catch {}
      await transport.terminate();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    })();
    return closing;
  }
  function fail() {
    if (closed) return;
    void close().catch(() => undefined);
    if (environment)
      options.onFailure?.(
        phase,
        failureCode,
        { ...timings, [phase]: elapsed() },
        structuredClone(protocol),
        { ...environment },
      );
    else
      options.onFailure?.(
        phase,
        failureCode,
        { ...timings, [phase]: elapsed() },
        structuredClone(protocol),
      );
  }
  const abort = () => {
    void close().catch(() => undefined);
  };
  transport.on("exit", fail).on("error", () => {
    failureCode = "worker-error";
    fail();
  });
  transport.on("message", (value) => {
    if (closed) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail();
      return;
    }
    const body = value as Record<string, unknown>;
    if (body["kind"] === "environment") {
      if (
        !initializing ||
        environment ||
        Object.keys(body).sort().join(",") !== "executablePresent,expectedRevision,kind" ||
        typeof body["executablePresent"] !== "boolean" ||
        typeof body["expectedRevision"] !== "boolean"
      ) {
        fail();
        return;
      }
      environment = {
        executablePresent: body["executablePresent"],
        expectedRevision: body["expectedRevision"],
      };
      return;
    }
    if (body["kind"] === "protocol") {
      if (
        !initializing ||
        Object.keys(body).sort().join(",") !== "events,kind,name,outstanding,received,sent" ||
        !BROWSER_STARTUP_PROTOCOL_NAMES.includes(
          body["name"] as (typeof BROWSER_STARTUP_PROTOCOL_NAMES)[number],
        ) ||
        ["sent", "received", "events", "outstanding"].some(
          (key) =>
            !Number.isSafeInteger(body[key]) ||
            (body[key] as number) < 0 ||
            (body[key] as number) > 256,
        )
      ) {
        fail();
        return;
      }
      const name = body["name"] as string;
      protocol[name] = {
        sent: body["sent"] as number,
        received: body["received"] as number,
        events: body["events"] as number,
        outstanding: body["outstanding"] as number,
      };
      if (name === "Inspector.targetCrashed" && protocol[name].events > 0) {
        failureCode = "page-crashed";
        fail();
      }
      return;
    }
    if (body["kind"] === "diagnostic") {
      if (
        Object.keys(body).sort().join(",") !== "code,kind" ||
        ![
          "startup-timeout",
          "page-timeout",
          "page-crashed",
          "target-closed",
          "protocol-assertion",
          "worker-exit",
          "worker-error",
          "worker-module-unavailable",
          "setup-failed",
          "cancelled",
          "browser-access-violation",
          "browser-access-denied",
          "browser-sandbox-executable-denied",
          "browser-exit-zero",
          "browser-exit-one",
          "browser-exit-other",
          "browser-spawn-not-found",
          "browser-spawn-denied",
          "browser-protocol-error",
          "browser-launch-type-error",
          "browser-launch-range-error",
          "browser-dependency-missing",
        ].includes(body["code"] as string)
      ) {
        fail();
        return;
      }
      // Preserve the first concrete cause; cleanup exit must not replace startup failure.
      if (failureCode === "worker-exit" || failureCode === "setup-failed")
        failureCode = body["code"] as BrowserWorkerFailure;
      return;
    }
    if (body["kind"] === "phase") {
      if (
        Object.keys(body).sort().join(",") !== "kind,stage" ||
        pending.size === 0 ||
        !["launch", "context", "routes", "page", "ready", "action"].includes(
          body["stage"] as string,
        )
      ) {
        fail();
        return;
      }
      if (initializing) {
        const index = startupPhases.indexOf(body["stage"] as (typeof startupPhases)[number]);
        if (index !== startupPhaseIndex + 1) {
          fail();
          return;
        }
        startupPhaseIndex = index;
        const entry = pending.values().next().value;
        if (!entry) {
          fail();
          return;
        }
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          if (failureCode === "worker-exit")
            failureCode = body["stage"] === "page" ? "page-timeout" : "startup-timeout";
          fail();
        }, phaseBudgets[index]);
      } else if (body["stage"] !== "action") {
        fail();
        return;
      }
      timings[phase] = elapsed();
      phaseStarted = performance.now();
      phase = body["stage"] as BrowserWorkerPhase;
      if (phase === "ready" && process.env["ZET_BROWSER_STARTUP_PROTOCOL_DIAGNOSTICS"] === "1") {
        failureCode = "startup-diagnostic-complete";
        fail();
      }
      return;
    }
    if (
      Object.keys(body).sort().join(",") !== "id,ok,value" ||
      !Number.isSafeInteger(body["id"]) ||
      typeof body["ok"] !== "boolean"
    ) {
      fail();
      return;
    }
    const entry = pending.get(body["id"] as number);
    if (!entry) {
      fail();
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(body["id"] as number);
    if (body["ok"] === false) {
      entry.reject(unavailable());
      fail();
    } else entry.resolve(body["value"]);
  });
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  function request(kind: "init" | "action", data: unknown, timeout: number): Promise<unknown> {
    if (closed) return Promise.reject(unavailable());
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        failureCode = "startup-timeout";
        fail();
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      try {
        transport.send({ id, kind, data });
      } catch {
        fail();
      }
    });
  }
  try {
    const ready = await request("init", { pins: structuredClone(options.pins) }, 14000);
    if (ready !== null) throw unavailable();
    initializing = false;
    return {
      close,
      async execute(input: BrowserAction, signal: AbortSignal) {
        if (closed || options.signal.aborted || signal.aborted) throw unavailable();
        const action = checkedBrowserAction(input);
        if (action.kind === "navigate" && !options.scope.permits(action.url)) throw unavailable();
        const cancel = () => {
          fail();
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          const result = await request("action", action, 18000);
          if (closed || signal.aborted) throw unavailable();
          if (action.kind === "read") {
            if (typeof result !== "string" || Buffer.byteLength(result) > 65536)
              throw unavailable();
            return result;
          }
          if (action.kind === "capture") {
            if (!result || typeof result !== "object" || Array.isArray(result)) throw unavailable();
            const item = result as BrowserCapture;
            if (
              Object.keys(item).sort().join(",") !== "height,id,width" ||
              typeof item.id !== "string" ||
              !/^[0-9a-f-]{36}$/u.test(item.id) ||
              item.width !== 1280 ||
              item.height !== 720
            )
              throw unavailable();
            return item;
          }
          if (result !== null) throw unavailable();
          return null;
        } catch {
          fail();
          throw unavailable();
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      },
    };
  } catch {
    await close();
    throw unavailable();
  }
}
