import { describe, expect, it, vi } from "vitest";
import {
  createPlaywrightBrowserDriver,
  type BrowserContext,
  type BrowserEngine,
  type BrowserRoute,
  type BrowserPage,
} from "./runtime-browser-driver.js";

describe("sandboxed browser driver", () => {
  it("requires sandbox and scoped read-only network without profiles", async () => {
    let routing: ((route: BrowserRoute) => Promise<void>) | undefined;
    const fill = vi.fn(() => Promise.resolve());
    const context: BrowserContext = {
      addInitScript: () => Promise.resolve(),
      on: () => undefined,
      route: (_pattern, handler) => {
        routing = handler;
        return Promise.resolve();
      },
      routeWebSocket: () => Promise.resolve(),
      close: () => Promise.resolve(),
      newPage: () =>
        Promise.resolve({
          on: () => undefined,
          close: () => Promise.resolve(),
          goto: () => Promise.resolve(null),
          keyboard: { press: () => Promise.resolve() },
          screenshot: () => Promise.resolve(null),
          locator: () => ({
            count: () => Promise.resolve(1),
            innerText: () => Promise.resolve("visible text"),
            getAttribute: (name) => Promise.resolve(name === "type" ? "password" : null),
            fill,
            click: () => Promise.resolve(),
          }),
        }),
    };
    const launch = vi.fn((options: Parameters<BrowserEngine["launch"]>[0]) => {
      void options;
      return Promise.resolve({
        newContext: () => Promise.resolve(context),
        close: () => Promise.resolve(),
      });
    });
    const engine: BrowserEngine = { launch };
    const signal = new AbortController().signal;
    const driver = await createPlaywrightBrowserDriver({
      engine,
      scope: {
        permits: (url) => url.startsWith("https://allowed.org/"),
        pin: () => Promise.resolve([]),
      },
      pins: [{ hostname: "allowed.org", address: "8.8.8.8", family: 4 }],
      signal,
    });
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ chromiumSandbox: true, headless: true });
    const abort = vi.fn(() => Promise.resolve());
    const proceed = vi.fn(() => Promise.resolve());
    await routing?.({
      request: () => ({ url: () => "http://localhost/", method: () => "GET" }),
      abort,
      continue: proceed,
    });
    await routing?.({
      request: () => ({ url: () => "https://allowed.org/form", method: () => "POST" }),
      abort,
      continue: proceed,
    });
    expect(abort).toHaveBeenCalledTimes(2);
    expect(proceed).not.toHaveBeenCalled();
    await expect(
      driver.execute({ kind: "type", selector: "input", text: "private" }, signal),
    ).rejects.toThrow("refused");
    expect(fill).not.toHaveBeenCalled();
    await driver.close();
  });
});

function fixture() {
  const handlers = new Map<string, (value: unknown) => void>();
  let pageHandler: ((page: BrowserPage) => void) | undefined;
  const popupClose = vi.fn(() => Promise.resolve());
  const initScript = vi.fn(() => Promise.resolve());
  const page: BrowserPage = {
    on: (event, handler) => {
      handlers.set(event, handler as (value: unknown) => void);
    },
    close: popupClose,
    goto: vi.fn(() => Promise.resolve(null)),
    keyboard: { press: () => Promise.resolve() },
    screenshot: () => Promise.resolve(null),
    locator: () => ({
      count: () => Promise.resolve(1),
      innerText: () => Promise.resolve("text"),
      getAttribute: () => Promise.resolve(null),
      click: () => Promise.resolve(),
      fill: () => Promise.resolve(),
    }),
  };
  const context: BrowserContext = {
    route: () => Promise.resolve(),
    routeWebSocket: () => Promise.resolve(),
    addInitScript: initScript,
    on: (_event, handler) => {
      pageHandler = handler;
    },
    newPage: () => Promise.resolve(page),
    close: () => Promise.resolve(),
  };
  const close = vi.fn(() => Promise.resolve());
  const launch = vi.fn(() =>
    Promise.resolve({ newContext: () => Promise.resolve(context), close }),
  );
  const controller = new AbortController();
  const options = {
    engine: { launch },
    scope: { permits: () => true, pin: () => Promise.resolve([]) },
    pins: [{ hostname: "allowed.org", address: "8.8.8.8", family: 4 as const }],
    signal: controller.signal,
  };
  return {
    options,
    context,
    page,
    close,
    launch,
    controller,
    handlers,
    popupClose,
    initScript,
    popup: (popup: BrowserPage) => pageHandler?.(popup),
  };
}

describe("browser interaction refusal and lifecycle", () => {
  it("dismisses dialogs, cancels downloads, closes popups and fixes transport hardening", async () => {
    const f = fixture();
    const driver = await createPlaywrightBrowserDriver(f.options);
    const dismiss = vi.fn(() => Promise.resolve());
    const cancel = vi.fn(() => Promise.resolve());
    f.handlers.get("dialog")?.({ dismiss });
    f.handlers.get("download")?.({ cancel });
    f.popup(f.page);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.popupClose).toHaveBeenCalledOnce();
    expect(f.initScript).toHaveBeenCalledWith(expect.stringContaining("RTCPeerConnection"));
    await driver.close();
    await driver.close();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("sanitizes launch failure without fallback", async () => {
    const f = fixture();
    const launch = vi.fn(() => Promise.reject(new Error("private provider diagnostic")));
    await expect(
      createPlaywrightBrowserDriver({ ...f.options, engine: { launch } }),
    ).rejects.toThrow("Sandboxed browser unavailable");
    expect(launch).toHaveBeenCalledOnce();
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("closes after context setup failure", async () => {
    const f = fixture();
    f.context.addInitScript = () => Promise.reject(new Error("private diagnostic"));
    await expect(createPlaywrightBrowserDriver(f.options)).rejects.toThrow(
      "Sandboxed browser unavailable",
    );
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("closes on session cancellation and rejects further actions", async () => {
    const f = fixture();
    const driver = await createPlaywrightBrowserDriver(f.options);
    f.controller.abort();
    await expect(
      driver.execute(
        { kind: "navigate", url: "https://allowed.org/" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Browser stopped");
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("closes on action cancellation", async () => {
    const f = fixture();
    const action = new AbortController();
    f.page.goto = () => {
      action.abort();
      return Promise.reject(new Error("cancelled"));
    };
    const driver = await createPlaywrightBrowserDriver(f.options);
    await expect(
      driver.execute({ kind: "navigate", url: "https://allowed.org/" }, action.signal),
    ).rejects.toThrow("Browser action failed");
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("bounds close even if the browser never settles", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.close.mockImplementation(() => new Promise<void>(() => undefined));
    try {
      const driver = await createPlaywrightBrowserDriver(f.options);
      const closing = driver.close();
      await vi.advanceTimersByTimeAsync(3000);
      await closing;
      expect(f.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
