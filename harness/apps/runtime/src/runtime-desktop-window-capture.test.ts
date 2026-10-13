import { readFile, access } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeDesktopSession,
  windowCaptureScope,
  type DesktopWindow,
  type DesktopMonitor,
  type DesktopDriver,
} from "./runtime-desktop-session.js";
import { RuntimeWindowsDesktopDriver, WINDOWS_DESKTOP_SCRIPT } from "./runtime-windows-desktop.js";
const monitor: DesktopMonitor = {
  id: "left",
  x: -100,
  y: -20,
  width: 100,
  height: 100,
  scale: 1.5,
};
const window: DesktopWindow = {
  id: "123",
  title: "Owned fixture",
  processId: 7,
  processStartedAt: "100",
  windowClass: "Fixture",
  focused: true,
  bounds: { x: -90, y: -10, width: 20, height: 30 },
};
const signal = () => new AbortController().signal;
function fixture() {
  const inventory = vi.fn(() =>
    Promise.resolve({ monitors: [structuredClone(monitor)], windows: [structuredClone(window)] }),
  );
  const capture = vi.fn(() =>
    Promise.resolve({ localPath: "forbidden-monitor", width: 100, height: 100 }),
  );
  const captureWindow = vi.fn((w: DesktopWindow, m: DesktopMonitor) => {
    const scope = windowCaptureScope(m, w);
    return Promise.resolve({
      localPath: "owned-fixture",
      width: scope.width,
      height: scope.height,
      scope,
    });
  });
  const removeCapture = vi.fn(() => Promise.resolve());
  const driver = {
    inventory,
    capture,
    captureWindow,
    removeCapture,
    act: vi.fn(() => Promise.resolve()),
  } satisfies DesktopDriver;
  return {
    driver,
    session: new RuntimeDesktopSession({ driver, approve: () => Promise.resolve(false) }),
  };
}

describe("selected window capture confinement (synthetic only)", () => {
  it("clips physical window bounds to the selected monitor including negative origins", () => {
    expect(
      windowCaptureScope(monitor, {
        ...window,
        bounds: { x: -120, y: -30, width: 60, height: 40 },
      }),
    ).toMatchObject({
      x: -100,
      y: -20,
      width: 40,
      height: 30,
      windowBounds: { x: -120, y: -30, width: 60, height: 40 },
    });
    for (const changed of [{ focused: false }, { bounds: { x: 0, y: 0, width: 1, height: 1 } }])
      expect(() => windowCaptureScope(monitor, { ...window, ...changed })).toThrow();
    for (const key of ["processId", "processStartedAt", "windowClass"] as const) {
      const missing = { ...window };
      delete missing[key];
      expect(() => windowCaptureScope(monitor, missing)).toThrow();
    }
  });

  it("uses the window-only driver and returns exact scope metadata without local path", async () => {
    const f = fixture();
    await f.session.inventory();
    const armed = f.session.arm({
      task: "Owned fixture",
      monitorId: monitor.id,
      windowId: window.id,
    });
    try {
      const result = await f.session.capture(armed.generation);
      expect(result).toMatchObject({
        width: 20,
        height: 30,
        captureScope: windowCaptureScope(monitor, window),
      });
      expect(JSON.stringify(result)).not.toContain("owned-fixture");
      expect(f.driver.captureWindow).toHaveBeenCalledWith(window, monitor, expect.any(AbortSignal));
      expect(f.driver.capture).not.toHaveBeenCalled();
    } finally {
      f.session.stop();
    }
  });

  it("refuses stale focus, PID, process lifetime, HWND class/title/bounds and monitor geometry", async () => {
    for (const changed of [
      { focused: false },
      { processId: 8 },
      { processStartedAt: "101" },
      { windowClass: "Other" },
      { title: "Other" },
      { bounds: { x: -89, y: -10, width: 20, height: 30 } },
    ]) {
      const f = fixture();
      await f.session.inventory();
      const armed = f.session.arm({
        task: "Owned fixture",
        monitorId: monitor.id,
        windowId: window.id,
      });
      f.driver.inventory.mockResolvedValueOnce({
        monitors: [monitor],
        windows: [{ ...window, ...changed }],
      });
      try {
        await expect(f.session.capture(armed.generation)).rejects.toThrow();
        expect(f.driver.captureWindow).not.toHaveBeenCalled();
        expect(f.driver.capture).not.toHaveBeenCalled();
      } finally {
        f.session.stop();
      }
    }
    const f = fixture();
    await f.session.inventory();
    const armed = f.session.arm({
      task: "Owned fixture",
      monitorId: monitor.id,
      windowId: window.id,
    });
    f.driver.inventory.mockResolvedValueOnce({
      monitors: [{ ...monitor, x: -99 }],
      windows: [window],
    });
    try {
      await expect(f.session.capture(armed.generation)).rejects.toThrow("changed");
      expect(f.driver.capture).not.toHaveBeenCalled();
    } finally {
      f.session.stop();
    }
  });

  it("never falls back to monitor capture if window capture is unsupported or returns wrong scope", async () => {
    const f = fixture();
    const unsupported: DesktopDriver = {
      inventory: f.driver.inventory,
      capture: f.driver.capture,
      act: f.driver.act,
      removeCapture: f.driver.removeCapture,
    };
    const session = new RuntimeDesktopSession({
      driver: unsupported,
      approve: () => Promise.resolve(false),
    });
    await session.inventory();
    const armed = session.arm({
      task: "Owned fixture",
      monitorId: monitor.id,
      windowId: window.id,
    });
    try {
      await expect(session.capture(armed.generation)).rejects.toThrow("fallback");
      expect(f.driver.capture).not.toHaveBeenCalled();
    } finally {
      session.stop();
    }
    await f.session.inventory();
    const supported = f.session.arm({
      task: "Owned fixture",
      monitorId: monitor.id,
      windowId: window.id,
    });
    f.driver.captureWindow.mockResolvedValueOnce({
      localPath: "wrong-scope",
      width: 20,
      height: 30,
      scope: { ...windowCaptureScope(monitor, window), processId: 8 },
    });
    try {
      await expect(f.session.capture(supported.generation)).rejects.toThrow("scope");
      expect(f.driver.removeCapture).toHaveBeenCalledWith(
        expect.objectContaining({ localPath: "wrong-scope" }),
      );
    } finally {
      f.session.stop();
    }
  });
});

it("Windows window capture stores only a benign owned PNG and rejects bridge identity changes", async () => {
  const one = { ...window, bounds: { x: -90, y: -10, width: 1, height: 1 } };
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhb0AAAAASUVORK5CYII=";
  const runner = vi.fn((input: string) => {
    expect(JSON.parse(input)).toMatchObject({
      operation: "capture-window",
      window: one,
      monitor,
      x: -90,
      y: -10,
      width: 1,
      height: 1,
    });
    return Promise.resolve(JSON.stringify({ png, window: one }));
  });
  const driver = new RuntimeWindowsDesktopDriver(runner);
  const image = await driver.captureWindow(one, monitor, signal());
  try {
    expect(await readFile(image.localPath)).toEqual(Buffer.from(png, "base64"));
    expect(image.scope).toEqual(windowCaptureScope(monitor, one));
  } finally {
    await driver.removeCapture(image);
  }
  await expect(access(image.localPath)).rejects.toThrow();
  const stale = new RuntimeWindowsDesktopDriver(() =>
    Promise.resolve(JSON.stringify({ png, window: { ...one, processStartedAt: "200" } })),
  );
  await expect(stale.captureWindow(one, monitor, signal())).rejects.toThrow();
  const body = WINDOWS_DESKTOP_SCRIPT.slice(
    WINDOWS_DESKTOP_SCRIPT.indexOf(" public static string CaptureWindow("),
    WINDOWS_DESKTOP_SCRIPT.indexOf(" public static void Initialize("),
  );
  expect(body).toContain("PrintWindow(");
  expect(body).not.toContain("CopyFromScreen");
  expect(body.match(/CheckWindow\(/g)).toHaveLength(2);
  expect(body.match(/CheckMonitor\(/g)).toHaveLength(2);
});
