import { describe, expect, it } from "vitest";

import { RuntimeDaemon } from "./runtime-daemon.js";

describe("RuntimeDaemon", () => {
  it("starts once and remains idempotently running", () => {
    const daemon = new RuntimeDaemon();

    expect(daemon.snapshot()).toEqual({ state: "idle" });
    expect(daemon.start()).toBe(true);
    expect(daemon.start()).toBe(false);
    expect(daemon.snapshot()).toEqual({ state: "running" });

    daemon.stop();
  });

  it("stops once, releases waiters, and cannot restart", async () => {
    const daemon = new RuntimeDaemon();
    daemon.start();

    const stopped = daemon.waitUntilStopped();
    expect(daemon.stop()).toBe(true);
    await stopped;

    expect(daemon.stop()).toBe(false);
    expect(daemon.snapshot()).toEqual({ state: "stopped" });
    expect(() => daemon.start()).toThrow("Runtime daemon cannot restart after it has stopped.");
  });

  it("may be stopped before start without leaving a live lifecycle", async () => {
    const daemon = new RuntimeDaemon();

    expect(daemon.stop()).toBe(true);
    await daemon.waitUntilStopped();

    expect(daemon.snapshot()).toEqual({ state: "stopped" });
    expect(() => daemon.start()).toThrow(TypeError);
  });
});
