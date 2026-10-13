import { describe, expect, it, vi } from "vitest";
import {
  createPlaywrightBrowserDriver,
  browserStartupFailure,
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
    expect(launch.mock.calls[0]?.[0]).toMatchObject({
      chromiumSandbox: true,
      headless: true,
      channel: "chromium",
    });
    const launchOptions = launch.mock.calls[0]?.[0];
    expect(launchOptions?.args).toContain(
      "--host-resolver-rules=MAP allowed.org 8.8.8.8,MAP * ~NOTFOUND",
    );
    expect(launchOptions?.args).toContain("--no-proxy-server");
    expect(launchOptions?.args).not.toContain("--no-sandbox");
    expect(launchOptions).not.toHaveProperty("executablePath");
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

it("cancels a pending launch promptly and closes late success without context setup", async () => {
  const f = fixture();
  let resolveLaunch!: (value: Awaited<ReturnType<BrowserEngine["launch"]>>) => void;
  const newContext = vi.fn(() => Promise.resolve(f.context));
  const launch = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<BrowserEngine["launch"]>>>((resolve) => {
        resolveLaunch = resolve;
      }),
  );
  const creating = createPlaywrightBrowserDriver({ ...f.options, engine: { launch } });
  const rejected = expect(creating).rejects.toThrow("Sandboxed browser unavailable");
  f.controller.abort();
  await rejected;
  resolveLaunch({ newContext, close: f.close });
  await Promise.resolve();
  expect(newContext).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
});
it("bounds pending launch and closes late success after timeout", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let resolveLaunch!: (value: Awaited<ReturnType<BrowserEngine["launch"]>>) => void;
  const newContext = vi.fn(() => Promise.resolve(f.context));
  const launch: BrowserEngine["launch"] = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<BrowserEngine["launch"]>>>((resolve) => {
        resolveLaunch = resolve;
      }),
  );
  try {
    const creating = createPlaywrightBrowserDriver({ ...f.options, engine: { launch } });
    const rejected = expect(creating).rejects.toThrow("Sandboxed browser unavailable");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 10_000, chromiumSandbox: true, channel: "chromium" }),
    );
    resolveLaunch({ newContext, close: f.close });
    await vi.advanceTimersByTimeAsync(0);
    expect(newContext).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it("cancels pending context creation without subsequent setup or capture directory", async () => {
  const f = fixture();
  let resolveContext!: (value: BrowserContext) => void;
  const newContext = vi.fn(
    () =>
      new Promise<BrowserContext>((resolve) => {
        resolveContext = resolve;
      }),
  );
  const route = vi.fn(() => Promise.resolve());
  f.context.route = route;
  const creating = createPlaywrightBrowserDriver({
    ...f.options,
    engine: { launch: () => Promise.resolve({ newContext, close: f.close }) },
  });
  const rejected = expect(creating).rejects.toThrow("Sandboxed browser unavailable");
  await vi.waitFor(() => expect(newContext).toHaveBeenCalledOnce());
  f.controller.abort();
  await rejected;
  resolveContext(f.context);
  await Promise.resolve();
  expect(route).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
});

it("classifies startup errors using closed codes without persisting dependency text", async () => {
  const { browserStartupFailure } = await import("./runtime-browser-driver.js");
  const timeout = new Error("secret timeout diagnostic");
  timeout.name = "TimeoutError";
  expect(browserStartupFailure(timeout)).toBe("page-timeout");
  expect(
    browserStartupFailure(
      new Error("Target page, context or browser has been closed\nprivate diagnostic"),
    ),
  ).toBe("target-closed");
  expect(browserStartupFailure(new Error("Page crashed private diagnostic"))).toBe("page-crashed");
  expect(
    browserStartupFailure(new Error("process did exit: exitCode=-1073741819, signal=null")),
  ).toBe("browser-access-violation");
  expect(browserStartupFailure(new Error("private arbitrary response"))).toBe("setup-failed");
});

it("maps fixed launch error names, errno and exit categories without exposing text", () => {
  for (const [errno, expected] of [
    ["ENOENT", "browser-spawn-not-found"],
    ["EACCES", "browser-spawn-denied"],
    ["EPERM", "browser-spawn-denied"],
  ]) {
    expect(browserStartupFailure(Object.assign(new Error("PRIVATE_BODY"), { code: errno }))).toBe(
      expected,
    );
  }
  for (const [name, expected] of [
    ["ProtocolError", "browser-protocol-error"],
    ["TypeError", "browser-launch-type-error"],
    ["RangeError", "browser-launch-range-error"],
  ]) {
    const error = new Error("PRIVATE_BODY");
    error.name = name!;
    expect(browserStartupFailure(error)).toBe(expected);
  }
  for (const [code, expected] of [
    [0, "browser-exit-zero"],
    [1, "browser-exit-one"],
    [42, "browser-exit-other"],
    [-1073741819, "browser-access-violation"],
    [-1073741790, "browser-access-denied"],
  ]) {
    expect(
      browserStartupFailure(
        new Error(`PRIVATE_BODY process did exit: exitCode=${code}, signal=null`),
      ),
    ).toBe(expected);
  }
  expect(
    browserStartupFailure(new Error("Host system is missing dependencies! PRIVATE_BODY")),
  ).toBe("browser-dependency-missing");
  expect(browserStartupFailure(new Error("Executable doesn't exist at PRIVATE_BODY"))).toBe(
    "browser-spawn-not-found",
  );
  expect(
    browserStartupFailure(Object.assign(new Error("PRIVATE_BODY"), { code: "PRIVATE_BODY" })),
  ).toBe("setup-failed");
});

it("recognizes only anchored serialized SDK spawn errno signatures", () => {
  for (const errno of ["ENOENT", "EACCES", "EPERM"]) {
    const code = errno === "ENOENT" ? "browser-spawn-not-found" : "browser-spawn-denied";
    expect(
      browserStartupFailure(
        new Error(
          `browserType.launch: Failed to launch: Error: spawn PRIVATE_PATH ${errno}\nPRIVATE_BODY`,
        ),
      ),
    ).toBe(code);
    expect(browserStartupFailure(new Error(`PRIVATE_BODY mentions ${errno}`))).toBe("setup-failed");
  }
});
