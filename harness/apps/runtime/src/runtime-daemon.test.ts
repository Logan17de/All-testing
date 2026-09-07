import { describe, expect, it } from "vitest";

import { RuntimeDaemon } from "./runtime-daemon.js";

describe("RuntimeDaemon", () => {
  it("becomes running only after its loopback API is listening", async () => {
    const daemon = new RuntimeDaemon({ api: { port: 0 } });

    expect(daemon.snapshot()).toEqual({
      state: "idle",
      api: { state: "idle", host: "127.0.0.1", port: null, eventClients: 0 },
    });

    expect(await daemon.start()).toBe(true);
    expect(await daemon.start()).toBe(false);

    const snapshot = daemon.snapshot();
    expect(snapshot.state).toBe("running");
    expect(snapshot.api.state).toBe("listening");
    expect(snapshot.api.host).toBe("127.0.0.1");
    expect(snapshot.api.port).toEqual(expect.any(Number));
    expect(snapshot.api.port).toBeGreaterThan(0);
    expect(snapshot.api.eventClients).toBe(0);

    expect(daemon.publishEvent("runtime.test", { ok: true })).toEqual({
      id: 1,
      type: "runtime.test",
      data: '{"ok":true}',
    });

    await daemon.stop();
  });

  it("rejects stream publication outside the running lifecycle", async () => {
    const daemon = new RuntimeDaemon({ api: { port: 0 } });

    expect(() => daemon.publishEvent("runtime.test", null)).toThrow(
      "Runtime daemon must be running before publishing stream events.",
    );

    await daemon.stop();

    expect(() => daemon.publishEvent("runtime.test", null)).toThrow(TypeError);
  });

  it("stops once, releases waiters, and cannot restart", async () => {
    const daemon = new RuntimeDaemon({ api: { port: 0 } });
    await daemon.start();

    const stopped = daemon.waitUntilStopped();
    expect(await daemon.stop()).toBe(true);
    await stopped;

    expect(await daemon.stop()).toBe(false);
    expect(daemon.snapshot()).toEqual({
      state: "stopped",
      api: { state: "stopped", host: "127.0.0.1", port: null, eventClients: 0 },
    });
    await expect(daemon.start()).rejects.toThrow(
      "Runtime daemon cannot restart after it has stopped.",
    );
  });

  it("coalesces concurrent stop requests", async () => {
    const daemon = new RuntimeDaemon({ api: { port: 0 } });
    await daemon.start();

    const [first, second] = await Promise.all([daemon.stop(), daemon.stop()]);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(daemon.snapshot().state).toBe("stopped");
  });

  it("may be stopped before start without leaving a live lifecycle", async () => {
    const daemon = new RuntimeDaemon({ api: { port: 0 } });

    expect(await daemon.stop()).toBe(true);
    await daemon.waitUntilStopped();

    expect(daemon.snapshot().state).toBe("stopped");
    await expect(daemon.start()).rejects.toThrow(TypeError);
  });
});
