import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserPinnedAddress } from "./runtime-browser-policy.js";
import type {
  BrowserAction,
  BrowserScope,
  RuntimeBrowserDriver,
} from "./runtime-browser-session.js";

/** Structural Playwright boundary permits deterministic fixtures without launching a browser. */
export interface BrowserEngine {
  launch(options: {
    headless: boolean;
    chromiumSandbox: boolean;
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
  let browser: BrowserInstance;
  try {
    browser = await options.engine.launch({
      headless: true,
      chromiumSandbox: true,
      args: [
        `--host-resolver-rules=${rules.join(",")},MAP * ~NOTFOUND`,
        "--disable-quic",
        "--no-proxy-server",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-background-networking",
      ],
    });
  } catch {
    throw new Error("Sandboxed browser unavailable");
  }
  let directory: string | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener("abort", abort);
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
    if (directory) await rm(directory, { recursive: true, force: true });
  };
  const abort = () => {
    void close().catch(() => undefined);
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal.aborted) throw new Error("Browser stopped");
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
      viewport: { width: 1280, height: 720 },
    });
    // Network-mutating requests remain disabled even after input approval in this initial subset.
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (
        closed ||
        options.signal.aborted ||
        !options.scope.permits(request.url()) ||
        !["GET", "HEAD"].includes(request.method())
      )
        await route.abort();
      else await route.continue();
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    // Fixed hardening only; the public API never accepts scripts. Chromium routing
    // is not OS egress isolation. Block non-HTTP browser transports as precautions.
    await context.addInitScript(`
      for (const key of ["RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport"]) {
        Object.defineProperty(globalThis, key, { value: undefined, configurable: false, writable: false });
      }
    `);
    const primary = { ready: false };
    context.on("page", (opened) => {
      if (primary.ready) void opened.close().catch(() => undefined);
    });
    const page = await context.newPage();
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
  } catch {
    await close();
    throw new Error("Sandboxed browser unavailable");
  }
}
