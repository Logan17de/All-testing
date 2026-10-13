import { expect, it, vi } from "vitest";
import { createBrowserWorkerController } from "./runtime-browser-worker-controller.js";
import type { BrowserContext, BrowserPage, BrowserEngine } from "./runtime-browser-driver.js";
function fixture() {
  const page: BrowserPage = {
    on: () => undefined,
    close: () => Promise.resolve(),
    goto: () => Promise.resolve(null),
    screenshot: () => Promise.resolve(null),
    keyboard: { press: () => Promise.resolve() },
    locator: () => ({
      count: () => Promise.resolve(1),
      innerText: () => Promise.resolve("fixture text"),
      getAttribute: () => Promise.resolve(null),
      click: () => Promise.resolve(),
      fill: () => Promise.resolve(),
    }),
  };
  const context: BrowserContext = {
    route: () => Promise.resolve(),
    routeWebSocket: () => Promise.resolve(),
    addInitScript: () => Promise.resolve(),
    on: () => undefined,
    newPage: () => Promise.resolve(page),
    close: () => Promise.resolve(),
  };
  const close = vi.fn(() => Promise.resolve());
  const launch = vi.fn(() =>
    Promise.resolve({ newContext: () => Promise.resolve(context), close }),
  );
  const engine: BrowserEngine = { launch };
  const send = vi.fn();
  const controller = createBrowserWorkerController(engine, send);
  const init = {
    id: 1,
    kind: "init",
    data: { pins: [{ hostname: "example.com", address: "8.8.8.8", family: 4 }] },
  };
  return { controller, send, launch, close, init };
}
it("accepts only validated pins and bounded fixed browser actions preserving sandbox", async () => {
  const f = fixture();
  expect(await f.controller.receive(f.init)).toBe("open");
  expect(f.launch).toHaveBeenCalledWith(
    expect.objectContaining({ chromiumSandbox: true, headless: true, timeout: 10000 }),
  );
  expect(
    await f.controller.receive({ id: 2, kind: "action", data: { kind: "read", selector: "body" } }),
  ).toBe("open");
  expect(f.send).toHaveBeenLastCalledWith({ id: 2, ok: true, value: "fixture text" });
  expect(
    await f.controller.receive({
      id: 3,
      kind: "action",
      data: { kind: "navigate", url: "http://127.0.0.1/" },
    }),
  ).toBe("closed");
  expect(f.send).toHaveBeenLastCalledWith({ id: 3, ok: false, value: null });
  expect(f.close).toHaveBeenCalledOnce();
});
it("rejects scripts/executables in init and private pinned addresses before launch", async () => {
  for (const data of [
    { pins: [{ hostname: "example.com", address: "127.0.0.1", family: 4 }] },
    { pins: [{ hostname: "example.com", address: "8.8.8.8", family: 4 }], script: "arbitrary" },
  ]) {
    const f = fixture();
    expect(await f.controller.receive({ id: 1, kind: "init", data })).toBe("closed");
    expect(f.launch).not.toHaveBeenCalled();
  }
});
it("rejects duplicate IDs and closes rather than reexecuting an action", async () => {
  const f = fixture();
  await f.controller.receive(f.init);
  expect(await f.controller.receive(f.init)).toBe("closed");
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledOnce();
});
