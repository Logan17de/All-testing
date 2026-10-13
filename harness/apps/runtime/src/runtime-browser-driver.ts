import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserPinnedAddress } from "./runtime-browser-policy.js";
import type {
  BrowserAction,
  BrowserScope,
  RuntimeBrowserDriver,
  BrowserWorkerFailure,
} from "./runtime-browser-session.js";

/** Structural Playwright boundary permits deterministic fixtures without launching a browser. */
export interface BrowserEngine {
  launch(options: {
    headless: boolean;
    channel: "chromium";
    chromiumSandbox: boolean;
    timeout: number;
    args: string[];
  }): Promise<BrowserInstance>;
}
export interface BrowserInstance {
  newContext(options: {
    acceptDownloads: boolean;
    serviceWorkers: "block";
    permissions: string[];
    viewport: { width: number; height: number };
  }): Promise<BrowserContext>;
  close(): Promise<void>;
}
export interface BrowserContext {
  route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<unknown>;
  routeWebSocket(pattern: string, handler: (socket: { close(): void }) => void): Promise<unknown>;
  addInitScript(script: string): Promise<unknown>;
  on(event: "page", handler: (page: BrowserPage) => void): void;
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}
export interface BrowserRoute {
  request(): { url(): string; method(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}
export interface BrowserPage {
  on(event: "dialog", handler: (dialog: { dismiss(): Promise<void> }) => void): void;
  on(event: "download", handler: (download: { cancel(): Promise<void> }) => void): void;
  close(): Promise<void>;
  goto(url: string, options: { timeout: number; waitUntil: "domcontentloaded" }): Promise<unknown>;
  locator(selector: string): BrowserLocator;
  keyboard: { press(key: string): Promise<void> };
  screenshot(options: { path: string; fullPage: boolean; timeout: number }): Promise<unknown>;
}
export interface BrowserLocator {
  count(): Promise<number>;
  innerText(options: { timeout: number }): Promise<string>;
  getAttribute(name: string, options: { timeout: number }): Promise<string | null>;
  click(options: { timeout: number }): Promise<void>;
  fill(text: string, options: { timeout: number }): Promise<void>;
}
/** No persistent context, cookies, stored profiles, CDP, JS execution, or host-process fallback. */
export async function createPlaywrightBrowserDriver(options: {
  engine: BrowserEngine;
  onStartupFailure?: (code: BrowserWorkerFailure) => void;
  onStartupPhase?: (phase: "launch" | "context" | "routes" | "page" | "ready") => void;
  scope: BrowserScope;
  pins: BrowserPinnedAddress[];
  signal: AbortSignal;
}): Promise<RuntimeBrowserDriver> {
  if (options.signal.aborted || !options.pins.length) throw new Error("Browser scope unavailable");
  const rules = options.pins.map((pin) => {
    if (!/^[a-z0-9.-]+$/.test(pin.hostname) || !/^[a-fA-F0-9:.]+$/.test(pin.address))
      throw new Error("Invalid browser DNS pin");
    return `MAP ${pin.hostname} ${pin.family === 6 ? `[${pin.address}]` : pin.address}`;
  });
  const closing = new WeakSet<BrowserInstance>();
  const closeBrowser = (value: BrowserInstance) => {
    if (closing.has(value)) return Promise.resolve();
    closing.add(value);
    return boundedBrowserClose(value);
  };
  let browser: BrowserInstance;
  let discardedLaunch = false;
  let launchTimer: ReturnType<typeof setTimeout> | undefined;
  let launchAbort: (() => void) | undefined;
  try {
    options.onStartupPhase?.("launch");
    const launching = options.engine.launch({
      headless: true,
      channel: "chromium",
      chromiumSandbox: true,
      timeout: 10_000,
      args: [
        `--host-resolver-rules=${rules.join(",")},MAP * ~NOTFOUND`,
        "--disable-quic",
        "--no-proxy-server",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-background-networking",
      ],
    });
    void launching.then(
      (late) => {
        if (discardedLaunch) void closeBrowser(late).catch(() => undefined);
      },
      () => undefined,
    );
    browser = await Promise.race([
      launching,
      new Promise<never>((_resolve, reject) => {
        launchAbort = () => {
          discardedLaunch = true;
          reject(new Error("Browser stopped"));
        };
        options.signal.addEventListener("abort", launchAbort, { once: true });
        launchTimer = setTimeout(() => {
          discardedLaunch = true;
          reject(new Error("Browser startup deadline"));
        }, 10_000);
        if (options.signal.aborted) launchAbort();
      }),
    ]);
  } catch (error) {
    options.onStartupFailure?.(browserStartupFailure(error));
    discardedLaunch = true;
    throw new Error("Sandboxed browser unavailable");
  } finally {
    if (launchTimer) clearTimeout(launchTimer);
    if (launchAbort) options.signal.removeEventListener("abort", launchAbort);
  }
  let directory: string | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener("abort", abort);
    await closeBrowser(browser);
    if (directory) await rm(directory, { recursive: true, force: true });
  };
  const abort = () => {
    void close().catch(() => undefined);
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal.aborted) throw new Error("Browser stopped");
    options.onStartupPhase?.("context");
    const context = await startupAwait(
      browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
        viewport: { width: 1280, height: 720 },
      }),
      options.signal,
    );
    options.onStartupPhase?.("routes");
    // Network-mutating requests remain disabled even after input approval in this initial subset.
    await startupAwait(
      context.route("**/*", async (route) => {
        const request = route.request();
        if (
          closed ||
          options.signal.aborted ||
          !options.scope.permits(request.url()) ||
          !["GET", "HEAD"].includes(request.method())
        )
          await route.abort();
        else await route.continue();
      }),
      options.signal,
    );
    await startupAwait(
      context.routeWebSocket("**/*", (socket) => socket.close()),
      options.signal,
    );
    // Fixed hardening only; the public API never accepts scripts. Chromium routing
    // is not OS egress isolation. Block non-HTTP browser transports as precautions.
    await startupAwait(
      context.addInitScript(`
      for (const key of ["RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport"]) {
        Object.defineProperty(globalThis, key, { value: undefined, configurable: false, writable: false });
      }
    `),
      options.signal,
    );
    const primary = { ready: false };
    context.on("page", (opened) => {
      if (primary.ready) void opened.close().catch(() => undefined);
    });
    options.onStartupPhase?.("page");
    const page = await startupAwait(context.newPage(), options.signal);
    primary.ready = true;
    page.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => undefined);
    });
    page.on("download", (download) => {
      void download.cancel().catch(() => undefined);
    });
    directory = await mkdtemp(join(tmpdir(), "zet-browser-"));
    if (closed || options.signal.aborted) {
      await rm(directory, { recursive: true, force: true });
      throw new Error("Browser stopped");
    }
    options.onStartupPhase?.("ready");
    return {
      close,
      async execute(action: BrowserAction, signal: AbortSignal) {
        if (closed || options.signal.aborted || signal.aborted) throw new Error("Browser stopped");
        signal.addEventListener("abort", abort, { once: true });
        try {
          if (action.kind === "navigate") {
            if (!options.scope.permits(action.url)) throw new Error("Browser URL refused");
            await page.goto(action.url, { timeout: 15_000, waitUntil: "domcontentloaded" });
            return null;
          }
          if (action.kind === "capture") {
            const id = randomUUID();
            await page.screenshot({
              path: join(directory!, `${id}.png`),
              fullPage: false,
              timeout: 5000,
            });
            return { id, width: 1280, height: 720 };
          }
          if (action.kind === "key") {
            await page.keyboard.press(action.key);
            return null;
          }
          const locator = page.locator(action.selector);
          if ((await locator.count()) !== 1)
            throw new Error("Browser selector must identify one element");
          if (action.kind === "read") return await locator.innerText({ timeout: 5000 });
          if (action.kind === "type") {
            const type = (await locator.getAttribute("type", { timeout: 5000 }))?.toLowerCase();
            const autocomplete =
              (await locator.getAttribute("autocomplete", { timeout: 5000 }))?.toLowerCase() ?? "";
            if (
              ["password", "file", "hidden"].includes(type ?? "") ||
              /password|cc-|one-time-code/.test(autocomplete)
            )
              throw new Error("Sensitive browser input refused");
            await locator.fill(action.text, { timeout: 5000 });
          } else await locator.click({ timeout: 5000 });
          return null;
        } catch {
          throw new Error("Browser action failed or refused");
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
    };
  } catch (error) {
    options.onStartupFailure?.(browserStartupFailure(error));
    await close();
    throw new Error("Sandboxed browser unavailable");
  }
}

async function boundedBrowserClose(browser: BrowserInstance): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      browser.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function startupAwait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    const result = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("Browser stopped"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
    signal.throwIfAborted();
    return result;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export function browserStartupFailure(error: unknown): BrowserWorkerFailure {
  if (!(error instanceof Error)) return "setup-failed";
  // Inspect only fixed SDK/status signatures; never return or persist error text.
  const errno = (error as Error & { code?: unknown }).code;
  if (
    errno === "ENOENT" ||
    /^browserType\.launch: (?:Failed to launch: (?:Error: )?)?spawn [^\r\n]+ ENOENT(?:\r?\n|$)/u.test(
      error.message,
    )
  )
    return "browser-spawn-not-found";
  if (
    errno === "EACCES" ||
    errno === "EPERM" ||
    /^browserType\.launch: (?:Failed to launch: (?:Error: )?)?spawn [^\r\n]+ (?:EACCES|EPERM)(?:\r?\n|$)/u.test(
      error.message,
    )
  )
    return "browser-spawn-denied";
  if (error.message.includes("Executable doesn't exist at ")) return "browser-spawn-not-found";
  if (error.message.includes("Host system is missing dependencies"))
    return "browser-dependency-missing";
  if (/process did exit: exitCode=-1073741819(?:\D|$)/u.test(error.message))
    return "browser-access-violation";
  if (/process did exit: exitCode=-1073741790(?:\D|$)/u.test(error.message))
    return "browser-access-denied";
  const processExit = /process did exit: exitCode=(-?[0-9]{1,10}),/u.exec(error.message);
  if (processExit)
    return processExit[1] === "0"
      ? "browser-exit-zero"
      : processExit[1] === "1"
        ? "browser-exit-one"
        : "browser-exit-other";
  if (error.name === "ProtocolError") return "browser-protocol-error";
  if (error.name === "TypeError") return "browser-launch-type-error";
  if (error.name === "RangeError") return "browser-launch-range-error";
  if (error.name === "TimeoutError" || error.message === "Browser startup deadline")
    return "page-timeout";
  if (/Page crashed/u.test(error.message)) return "page-crashed";
  if (/Target page, context or browser has been closed/u.test(error.message))
    return "target-closed";
  if (error.name === "AbortError" || error.message === "Browser stopped") return "cancelled";
  return "setup-failed";
}
