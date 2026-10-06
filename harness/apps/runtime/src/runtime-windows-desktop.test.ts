import type { WindowsDesktopRunner } from "./runtime-windows-desktop.js";
import { readFile, access } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  RuntimeWindowsDesktopDriver,
  WINDOWS_DESKTOP_SCRIPT,
  validateWindowsDesktopBridge,
} from "./runtime-windows-desktop.js";
import type { DesktopAction, DesktopMonitor } from "./runtime-desktop-session.js";
const signal = () => new AbortController().signal;
const monitor: DesktopMonitor = {
  id: "virtual-desktop",
  x: -1920,
  y: -200,
  width: 3840,
  height: 1280,
  scale: 1,
};
function png(width: number, height: number): string {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}
it("default driver fails closed outside Windows without spawning", async () => {
  if (process.platform === "win32") return; // Real PC access is never exercised by this suite.
  await expect(new RuntimeWindowsDesktopDriver().inventory(signal())).rejects.toThrow(
    "unavailable",
  );
});
it("preserves full desktop negative origins and physical monitor DPI metadata (mock bridge)", async () => {
  const runner = vi.fn<WindowsDesktopRunner>(() =>
    Promise.resolve(
      JSON.stringify({
        monitors: [
          monitor,
          { id: "monitor-0", x: -1920, y: -200, width: 1920, height: 1080, scale: 1.5 },
        ],
        windows: [{ id: "123", title: "Editor" }],
      }),
    ),
  );
  const driver = new RuntimeWindowsDesktopDriver(runner);
  expect((await driver.inventory(signal())).monitors[0]).toEqual(monitor);
  expect(JSON.parse(runner.mock.calls[0]![0])).toEqual({ operation: "inventory" });
  expect(WINDOWS_DESKTOP_SCRIPT).toContain("SystemInformation.VirtualScreen");
  expect(WINDOWS_DESKTOP_SCRIPT).toContain("SetProcessDpiAwarenessContext");
});
it("captures OS screen rectangle into only an owned local temp file and removes it (mock PNG)", async () => {
  const runner = vi.fn<WindowsDesktopRunner>((input: string) => {
    expect(JSON.parse(input)).toEqual({
      operation: "capture",
      x: -1920,
      y: -200,
      width: 3840,
      height: 1280,
    });
    return Promise.resolve(JSON.stringify({ png: png(monitor.width, monitor.height) }));
  });
  const driver = new RuntimeWindowsDesktopDriver(runner);
  const capture = await driver.capture(monitor, signal());
  expect(capture.localPath).toMatch(/zet-desktop-/u);
  expect((await readFile(capture.localPath)).subarray(0, 8).toString("hex")).toBe(
    "89504e470d0a1a0a",
  );
  await driver.removeCapture({ localPath: "/unowned/file", width: 1, height: 1 });
  await driver.removeCapture(capture);
  await expect(access(capture.localPath)).rejects.toThrow();
});
it("refuses malformed bridge data and oversized screen capture", async () => {
  const driver = new RuntimeWindowsDesktopDriver(() =>
    Promise.resolve('{"monitors":[null],"windows":[]}'),
  );
  await expect(driver.inventory(signal())).rejects.toThrow("failed");
  await expect(driver.capture({ ...monitor, width: 20000 }, signal())).rejects.toThrow("failed");
  const pngDriver = new RuntimeWindowsDesktopDriver(() =>
    Promise.resolve(JSON.stringify({ png: png(1, 1) })),
  );
  await expect(pngDriver.capture(monitor, signal())).rejects.toThrow("failed");
});
it("sends secret text only through typed JSON bridge and sanitizes failures", async () => {
  const secret = "private credential text";
  const runner = vi.fn<WindowsDesktopRunner>((input: string) => {
    expect(JSON.parse(input)).toEqual({ kind: "text", text: secret, operation: "act" });
    return Promise.reject(new Error(secret));
  });
  const driver = new RuntimeWindowsDesktopDriver(runner);
  await expect(driver.act({ kind: "text", text: secret }, signal())).rejects.toThrow(
    "Windows desktop operation failed",
  );
  expect(WINDOWS_DESKTOP_SCRIPT).not.toContain(secret);
});
it("focuses selected HWND and binds subsequent input to its foreground check", async () => {
  const runner = vi.fn<WindowsDesktopRunner>(() => Promise.resolve('{"ok":true}'));
  const driver = new RuntimeWindowsDesktopDriver(runner);
  await driver.act({ kind: "focus", windowId: "123" }, signal());
  await driver.act({ kind: "key", key: "Enter" }, signal());
  expect(JSON.parse(runner.mock.calls[1]![0])).toEqual({
    kind: "key",
    key: "Enter",
    operation: "act",
    selectedWindow: "123",
  });
  expect(WINDOWS_DESKTOP_SCRIPT).toContain("GetForegroundWindow()!=new IntPtr(Int64.Parse(id))");
});
it("rejects control text, unsupported keys and invalid handles before bridge execution", async () => {
  const runner = vi.fn<WindowsDesktopRunner>(() => Promise.resolve('{"ok":true}'));
  const driver = new RuntimeWindowsDesktopDriver(runner);
  for (const action of [
    { kind: "text", text: "line\n" },
    { kind: "text", text: "x".repeat(2001) },
    { kind: "key", key: "RunCode" },
    { kind: "focus", windowId: "-1" },
    { kind: "focus", windowId: "9223372036854775808" },
    { kind: "move", x: NaN, y: 0 },
  ])
    await expect(driver.act(action as DesktopAction, signal())).rejects.toThrow("failed");
  expect(runner).not.toHaveBeenCalled();
});
it("does not allow extra caller fields to change bridge operations", async () => {
  const runner = vi.fn<WindowsDesktopRunner>(() => Promise.resolve('{"ok":true}'));
  const driver = new RuntimeWindowsDesktopDriver(runner);
  await driver.act(
    { kind: "key", key: "Tab", operation: "capture", savePath: "private" } as DesktopAction,
    signal(),
  );
  expect(JSON.parse(runner.mock.calls[0]![0])).toEqual({
    kind: "key",
    key: "Tab",
    operation: "act",
  });
});
it("cancellation prevents bridge input and discards late results", async () => {
  const controller = new AbortController();
  controller.abort();
  const runner = vi.fn<WindowsDesktopRunner>(() => Promise.resolve('{"ok":true}'));
  const driver = new RuntimeWindowsDesktopDriver(runner);
  await expect(driver.act({ kind: "key", key: "Escape" }, controller.signal)).rejects.toThrow();
  expect(runner).not.toHaveBeenCalled();
  const lateController = new AbortController();
  const late = new RuntimeWindowsDesktopDriver(() => {
    lateController.abort();
    return Promise.resolve('{"ok":true}');
  });
  await expect(late.act({ kind: "key", key: "Escape" }, lateController.signal)).rejects.toThrow();
});

it.skipIf(process.platform !== "win32")(
  "compiles the real Windows C# bridge without desktop access (Windows CI only)",
  async () => {
    await expect(
      validateWindowsDesktopBridge(AbortSignal.timeout(70_000)),
    ).resolves.toBeUndefined();
  },
  75_000,
);
it("keeps compile-only validation before any native desktop initialization", () => {
  const validation = WINDOWS_DESKTOP_SCRIPT.indexOf("if ($data.operation -eq 'validate')");
  const initialization = WINDOWS_DESKTOP_SCRIPT.indexOf("[ZetDesktop]::Initialize()");
  expect(validation).toBeGreaterThan(0);
  expect(validation).toBeLessThan(initialization);
});
