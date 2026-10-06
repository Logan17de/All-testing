import { expect, it, vi } from "vitest";
import { RuntimeDesktopSession } from "./runtime-desktop-session.js";
import type { DesktopDriver, DesktopMonitor } from "./runtime-desktop-session.js";
function fixture() {
  const driver = {
    inventory: vi.fn(() =>
      Promise.resolve({
        monitors: [
          { id: "left", x: -1920, y: 0, width: 1920, height: 1080, scale: 1.5 },
          { id: "right", x: 0, y: 0, width: 2560, height: 1440, scale: 1 },
        ],
        windows: [{ id: "123", title: "Fixture" }],
      }),
    ),
    capture: vi.fn((monitor: DesktopMonitor) =>
      Promise.resolve({
        localPath: "private-fixture-path",
        width: monitor.width,
        height: monitor.height,
      }),
    ),
    act: vi.fn(() => Promise.resolve()),
    removeCapture: vi.fn(() => Promise.resolve()),
  } satisfies DesktopDriver;
  const approve = vi.fn(() => Promise.resolve(true));
  const session = new RuntimeDesktopSession({ driver, approve });
  return { driver, approve, session };
}
it("is disabled by default and never initializes OS access", async () => {
  const session = new RuntimeDesktopSession({ approve: () => Promise.resolve(false) });
  expect(session.status().state).toBe("disabled");
  await expect(session.inventory()).rejects.toThrow("disabled");
  expect(() => session.arm({ task: "Review", monitorId: "left" })).toThrow("disabled");
});
it("captures complete selected monitor locally and requires separate one-use transmission consent", async () => {
  const { session, approve, driver } = fixture();
  await session.inventory();
  const armed = session.arm({ task: "Inspect screen", monitorId: "left", windowId: "123" });
  try {
    const capture = await session.capture(armed.generation);
    expect(typeof capture.artifactId).toBe("string");
    expect(capture.width).toBe(1920);
    expect(capture.height).toBe(1080);
    expect(JSON.stringify(capture)).not.toContain("private-fixture-path");
    expect(approve).not.toHaveBeenCalled();
    expect(session.previewArtifact(armed.generation, capture.artifactId).localPath).toBe(
      "private-fixture-path",
    );
    await expect(
      session.approveTransmission(armed.generation, capture.artifactId, false, {
        runId: "run",
        sessionId: "session",
        modelId: "model",
        accountId: null,
        maxUses: 2,
        expiresAtMs: armed.expiresAt!,
      }),
    ).rejects.toThrow("consent");
    await session.approveTransmission(armed.generation, capture.artifactId, true, {
      runId: "run",
      sessionId: "session",
      modelId: "model",
      accountId: null,
      maxUses: 2,
      expiresAtMs: armed.expiresAt!,
    });
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "transmission", task: "Inspect screen" }),
      expect.any(AbortSignal),
    );
    await expect(
      session.approveTransmission(armed.generation, capture.artifactId, true, {
        runId: "run",
        sessionId: "session",
        modelId: "model",
        accountId: null,
        maxUses: 2,
        expiresAtMs: armed.expiresAt!,
      }),
    ).rejects.toThrow("consent");
  } finally {
    session.stop();
  }
  expect(driver.removeCapture).toHaveBeenCalledTimes(1);
});
it("honors negative physical coordinates, selected window and explicit per-input refusal", async () => {
  const { session, driver, approve } = fixture();
  await session.inventory();
  const { generation } = session.arm({ task: "Type fixture", monitorId: "left", windowId: "123" });
  try {
    await expect(session.act(generation, { kind: "click", x: 0, y: 10 })).rejects.toThrow(
      "outside",
    );
    await expect(session.act(generation, { kind: "focus", windowId: "456" })).rejects.toThrow(
      "selected",
    );
    approve.mockResolvedValueOnce(false);
    await expect(session.act(generation, { kind: "click", x: -100, y: 10 })).rejects.toThrow(
      "declined",
    );
    expect(driver.act).not.toHaveBeenCalled();
    await session.act(generation, { kind: "text", text: "Fixture" });
    expect(driver.act).toHaveBeenNthCalledWith(
      1,
      { kind: "focus", windowId: "123" },
      expect.any(AbortSignal),
    );
    expect(driver.act).toHaveBeenNthCalledWith(
      2,
      { kind: "text", text: "Fixture" },
      expect.any(AbortSignal),
    );
  } finally {
    session.stop();
  }
});
it("stop revokes pending input, old generation and deadline", async () => {
  vi.useFakeTimers();
  const { session, driver, approve } = fixture();
  try {
    await session.inventory();
    const { generation } = session.arm({ task: "Review", monitorId: "left" });
    approve.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
    const work = session.act(generation, { kind: "click", x: -1, y: 1 });
    const assertion = expect(work).rejects.toThrow("cancelled");
    session.stop();
    await assertion;
    expect(driver.act).not.toHaveBeenCalled();
    await expect(session.capture(generation)).rejects.toThrow("inactive");
    session.arm({ task: "Review", monitorId: "left" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(session.status().state).toBe("idle");
  } finally {
    session.stop();
    vi.useRealTimers();
  }
});
it("cleans a late screenshot after stop and keeps audit free of typed content", async () => {
  const { session, driver } = fixture();
  await session.inventory();
  const { generation } = session.arm({ task: "Review", monitorId: "left", windowId: "123" });
  await session.act(generation, { kind: "text", text: "private fixture input" });
  expect(JSON.stringify(session.status().audit)).not.toContain("private fixture input");
  let complete: ((value: { localPath: string; width: number; height: number }) => void) | undefined;
  driver.capture.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const work = session.capture(generation);
  const rejected = expect(work).rejects.toThrow("cancelled");
  session.stop();
  await rejected;
  complete?.({ localPath: "late-private-path", width: 1920, height: 1080 });
  await Promise.resolve();
  await Promise.resolve();
  expect(driver.removeCapture).toHaveBeenCalledWith({
    localPath: "late-private-path",
    width: 1920,
    height: 1080,
  });
});
