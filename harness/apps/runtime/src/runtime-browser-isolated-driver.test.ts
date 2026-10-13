import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createIsolatedBrowserDriver } from "./runtime-browser-isolated-driver.js";
import type { BrowserWorkerTransport } from "./runtime-browser-worker-launcher.js";
function fixture() {
  const events = new EventEmitter();
  let directory = "";
  const terminate = vi.fn(() => Promise.resolve());
  const send = vi.fn((value: unknown) => {
    const body = value as { id: number; kind: string; data?: { kind: string } };
    if (body.kind === "init")
      queueMicrotask(() => events.emit("message", { id: body.id, ok: true, value: null }));
    else if (body.kind === "action")
      queueMicrotask(() =>
        events.emit("message", {
          id: body.id,
          ok: true,
          value: body.data?.kind === "read" ? "fixture text" : null,
        }),
      );
  });
  const transport: BrowserWorkerTransport = {
    send,
    on(event: "message" | "exit" | "error", fn: (value?: unknown) => void) {
      events.on(event, fn);
      return transport;
    },
    terminate,
  };
  const factory = vi.fn((path: string) => {
    directory = path;
    return Promise.resolve(transport);
  });
  const controller = new AbortController();
  const onFailure = vi.fn();
  const options = {
    pins: [{ hostname: "example.com", address: "8.8.8.8", family: 4 as const }],
    scope: {
      permits: (url: string) => url.startsWith("https://example.com/"),
      pin: () => Promise.resolve([]),
    },
    signal: controller.signal,
    onFailure,
  };
  return {
    events,
    send,
    terminate,
    factory,
    controller,
    onFailure,
    options,
    directory: () => directory,
  };
}
it("sends fixed pins/actions and cleans owned artifacts on close", async () => {
  const f = fixture();
  const driver = await createIsolatedBrowserDriver(f.options, f.factory);
  expect(
    await driver.execute({ kind: "read", selector: "body" }, new AbortController().signal),
  ).toBe("fixture text");
  await expect(
    driver.execute(
      { kind: "navigate", url: "https://elsewhere.com/" },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(f.send).toHaveBeenCalledTimes(2);
  await driver.close();
  await driver.close();
  expect(f.terminate).toHaveBeenCalledOnce();
  await expect(stat(f.directory())).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.onFailure).not.toHaveBeenCalled();
});
it("contains worker crash, rejects pending actions, revokes once and removes private directory", async () => {
  const f = fixture();
  const driver = await createIsolatedBrowserDriver(f.options, f.factory);
  f.send.mockImplementation(() => undefined);
  const action = driver.execute({ kind: "read", selector: "body" }, new AbortController().signal);
  const rejected = expect(action).rejects.toThrow("Isolated browser unavailable");
  f.events.emit("exit");
  f.events.emit("error");
  await rejected;
  await driver.close();
  expect(f.onFailure).toHaveBeenCalledOnce();
  expect(f.terminate).toHaveBeenCalledOnce();
  await expect(stat(f.directory())).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects forged or mismatched worker replies instead of accepting success", async () => {
  const f = fixture();
  f.send.mockImplementation(() =>
    queueMicrotask(() =>
      f.events.emit("message", { id: 999, ok: true, value: null, script: "forged" }),
    ),
  );
  await expect(createIsolatedBrowserDriver(f.options, f.factory)).rejects.toThrow(
    "Isolated browser unavailable",
  );
  expect(f.onFailure).toHaveBeenCalledOnce();
  expect(f.terminate).toHaveBeenCalledOnce();
});
it("cancels an outstanding action and rejects later authority", async () => {
  const f = fixture();
  const driver = await createIsolatedBrowserDriver(f.options, f.factory);
  f.send.mockImplementation(() => undefined);
  const controller = new AbortController();
  const action = driver.execute({ kind: "read", selector: "body" }, controller.signal);
  const rejected = expect(action).rejects.toThrow();
  controller.abort();
  await rejected;
  await driver.close();
  await expect(driver.execute({ kind: "capture" }, new AbortController().signal)).rejects.toThrow();
  expect(f.terminate).toHaveBeenCalledOnce();
});
it("bounds startup with a nonresponsive worker and handles late success", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.send.mockImplementation(() => undefined);
  try {
    const creating = createIsolatedBrowserDriver(f.options, f.factory);
    const rejected = expect(creating).rejects.toThrow();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(14000);
    await rejected;
    f.events.emit("message", { id: 1, ok: true, value: null });
    expect(f.onFailure).toHaveBeenCalledOnce();
    expect(f.terminate).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("exposes only closed startup phase metadata when worker exits", async () => {
  const f = fixture();
  const driver = await createIsolatedBrowserDriver(f.options, f.factory);
  f.send.mockImplementation(() => undefined);
  const action = driver.execute({ kind: "read", selector: "body" }, new AbortController().signal);
  const rejected = expect(action).rejects.toThrow();
  f.events.emit("message", { kind: "phase", stage: "action" });
  f.events.emit("exit");
  await rejected;
  await driver.close();
  expect(f.onFailure).toHaveBeenCalledWith("action", "worker-exit", expect.any(Object), {});
});

it("preserves closed protocol diagnostic across worker exit and refuses arbitrary codes", async () => {
  const f = fixture();
  const driver = await createIsolatedBrowserDriver(f.options, f.factory);
  f.send.mockImplementation(() => undefined);
  const action = driver.execute({ kind: "read", selector: "body" }, new AbortController().signal);
  const rejected = expect(action).rejects.toThrow();
  f.events.emit("message", { kind: "diagnostic", code: "protocol-assertion" });
  f.events.emit("message", { kind: "diagnostic", code: "browser-exit-zero" });
  f.events.emit("exit");
  await rejected;
  await driver.close();
  expect(f.onFailure).toHaveBeenCalledWith(
    "worker-start",
    "protocol-assertion",
    expect.any(Object),
    {},
  );
  const other = fixture();
  const otherDriver = await createIsolatedBrowserDriver(other.options, other.factory);
  other.events.emit("message", { kind: "diagnostic", code: "private arbitrary text" });
  await otherDriver.close();
  expect(other.onFailure).toHaveBeenCalledWith(
    "worker-start",
    "worker-exit",
    expect.any(Object),
    {},
  );
});

it("separates cold startup and page deadlines without allowing repeated-phase keepalive", async () => {
  const f = fixture();
  const originalFactory = f.factory.getMockImplementation()!;
  f.factory.mockImplementation((path: string) => {
    vi.useFakeTimers();
    return originalFactory(path);
  });
  f.send.mockImplementation(() => undefined);
  const starting = createIsolatedBrowserDriver(f.options, f.factory);
  const rejected = expect(starting).rejects.toThrow();
  while (!f.send.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
  try {
    await vi.advanceTimersByTimeAsync(13000);
    expect(f.onFailure).not.toHaveBeenCalled();
    f.events.emit("message", { kind: "phase", stage: "launch" });
    await vi.advanceTimersByTimeAsync(11000);
    expect(f.onFailure).not.toHaveBeenCalled();
    for (const stage of ["context", "routes", "page"])
      f.events.emit("message", { kind: "phase", stage });
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(f.onFailure).toHaveBeenCalledWith(
      "page",
      "page-timeout",
      expect.objectContaining({ page: 5000, launch: 11000 }),
      {},
    );
  } finally {
    vi.useRealTimers();
  }
});

it("rejects a repeated startup phase instead of refreshing its deadline", async () => {
  const f = fixture();
  f.send.mockImplementation(() => undefined);
  const starting = createIsolatedBrowserDriver(f.options, f.factory);
  const rejected = expect(starting).rejects.toThrow();
  while (!f.send.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
  f.events.emit("message", { kind: "phase", stage: "launch" });
  f.events.emit("message", { kind: "phase", stage: "launch" });
  await rejected;
  expect(f.terminate).toHaveBeenCalledTimes(1);
});

it("retains fixed browser-process diagnosis when the page deadline later expires", async () => {
  const f = fixture();
  const originalFactory = f.factory.getMockImplementation()!;
  f.factory.mockImplementation((path: string) => {
    vi.useFakeTimers();
    return originalFactory(path);
  });
  f.send.mockImplementation(() => undefined);
  const starting = createIsolatedBrowserDriver(f.options, f.factory);
  const rejected = expect(starting).rejects.toThrow();
  while (!f.send.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
  try {
    for (const stage of ["launch", "context", "routes", "page"])
      f.events.emit("message", { kind: "phase", stage });
    f.events.emit("message", { kind: "diagnostic", code: "browser-sandbox-executable-denied" });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(f.onFailure).toHaveBeenCalledWith(
      "page",
      "browser-sandbox-executable-denied",
      expect.objectContaining({ page: 5000 }),
      {},
    );
  } finally {
    vi.useRealTimers();
  }
});

it("retains only closed startup protocol counters and terminates instrumented readiness before actions", async () => {
  vi.stubEnv("ZET_BROWSER_STARTUP_PROTOCOL_DIAGNOSTICS", "1");
  const f = fixture();
  f.send.mockImplementation(() => undefined);
  const starting = createIsolatedBrowserDriver(f.options, f.factory);
  const rejected = expect(starting).rejects.toThrow();
  while (!f.send.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
  try {
    f.events.emit("message", {
      kind: "protocol",
      name: "Page.enable",
      sent: 1,
      received: 0,
      events: 0,
      outstanding: 1,
    });
    for (const stage of ["launch", "context", "routes", "page", "ready"])
      f.events.emit("message", { kind: "phase", stage });
    await rejected;
    expect(f.onFailure).toHaveBeenCalledWith(
      "ready",
      "startup-diagnostic-complete",
      expect.any(Object),
      { "Page.enable": { sent: 1, received: 0, events: 0, outstanding: 1 } },
    );
    expect(f.send.mock.calls.some(([value]) => (value as { kind: string }).kind === "action")).toBe(
      false,
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

it("rejects unknown protocol names, private fields and oversized counters without retaining them", async () => {
  for (const bad of [
    { name: "PRIVATE_CREDENTIAL", sent: 1 },
    { name: "Page.enable", sent: 257 },
    { name: "Page.enable", sent: 1, params: "PRIVATE_CREDENTIAL" },
  ]) {
    const f = fixture();
    f.send.mockImplementation(() => undefined);
    const starting = createIsolatedBrowserDriver(f.options, f.factory);
    const rejected = expect(starting).rejects.toThrow();
    while (!f.send.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
    f.events.emit("message", { kind: "protocol", received: 0, events: 0, outstanding: 0, ...bad });
    await rejected;
    expect(f.onFailure.mock.calls[0]?.[3]).toEqual({});
    expect(JSON.stringify(f.onFailure.mock.calls)).not.toContain("PRIVATE_CREDENTIAL");
  }
});

it("invalidates immediately on the closed renderer target crash event without waiting for page deadline", async () => {
  const f = fixture();
  f.send.mockImplementation(() => undefined);
  const starting = createIsolatedBrowserDriver(f.options, f.factory);
  const rejected = expect(starting).rejects.toThrow();
  while (!f.send.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
  for (const stage of ["launch", "context", "routes", "page"])
    f.events.emit("message", { kind: "phase", stage });
  f.events.emit("message", {
    kind: "protocol",
    name: "Inspector.targetCrashed",
    sent: 0,
    received: 0,
    events: 1,
    outstanding: 0,
  });
  await rejected;
  expect(f.onFailure).toHaveBeenCalledWith("page", "page-crashed", expect.any(Object), {
    "Inspector.targetCrashed": { sent: 0, received: 0, events: 1, outstanding: 0 },
  });
  expect(f.terminate).toHaveBeenCalledTimes(1);
});

it("exposes only worker prelaunch booleans after failure and refuses arbitrary environment fields", async () => {
  const f = fixture();
  f.send.mockImplementation(() => undefined);
  const starting = createIsolatedBrowserDriver(f.options, f.factory);
  const rejected = expect(starting).rejects.toThrow();
  while (!f.send.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
  f.events.emit("message", {
    kind: "environment",
    executablePresent: true,
    expectedRevision: true,
  });
  f.events.emit("exit");
  await rejected;
  expect(f.onFailure.mock.calls[0]?.[4]).toEqual({
    executablePresent: true,
    expectedRevision: true,
  });
  const bad = fixture();
  bad.send.mockImplementation(() => undefined);
  const next = createIsolatedBrowserDriver(bad.options, bad.factory);
  const refused = expect(next).rejects.toThrow();
  while (!bad.send.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
  bad.events.emit("message", {
    kind: "environment",
    executablePresent: true,
    expectedRevision: true,
    path: "PRIVATE_PATH",
  });
  await refused;
  expect(JSON.stringify(bad.onFailure.mock.calls)).not.toContain("PRIVATE_PATH");
});
