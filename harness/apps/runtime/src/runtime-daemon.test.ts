import { once } from "node:events";
import { createServer } from "node:http";

import { SQLITE_MEMORY_PATH } from "@zet-harness/db";
import { describe, expect, it } from "vitest";

import { RuntimeDaemon } from "./runtime-daemon.js";

const createDaemon = (): RuntimeDaemon =>
  new RuntimeDaemon({
    api: { port: 0 },
    database: { path: SQLITE_MEMORY_PATH },
  });

describe("RuntimeDaemon", () => {
  it("becomes running only after SQLite and the loopback API are ready", async () => {
    const daemon = createDaemon();

    expect(daemon.snapshot()).toEqual({
      state: "idle",
      api: { state: "idle", host: "127.0.0.1", port: null, eventClients: 0 },
      database: { state: "closed", path: SQLITE_MEMORY_PATH, inMemory: true },
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
    expect(snapshot.database).toEqual({
      state: "open",
      path: SQLITE_MEMORY_PATH,
      inMemory: true,
    });

    expect(daemon.publishEvent("runtime.test", { ok: true })).toEqual({
      id: 1,
      type: "runtime.test",
      data: '{"ok":true}',
    });

    await daemon.stop();
  });

  it("closes SQLite again when the HTTP listener cannot bind", async () => {
    const blocker = createServer();
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");

    const address = blocker.address();
    if (address === null || typeof address === "string") {
      blocker.close();
      throw new TypeError("Test blocker did not expose a TCP address.");
    }

    const daemon = new RuntimeDaemon({
      api: { port: address.port },
      database: { path: SQLITE_MEMORY_PATH },
    });

    try {
      await expect(daemon.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(daemon.snapshot()).toEqual({
        state: "idle",
        api: { state: "idle", host: "127.0.0.1", port: null, eventClients: 0 },
        database: { state: "closed", path: SQLITE_MEMORY_PATH, inMemory: true },
      });
    } finally {
      await daemon.stop();
      blocker.close();
      await once(blocker, "close");
    }
  });

  it("rejects stream publication outside the running lifecycle", async () => {
    const daemon = createDaemon();

    expect(() => daemon.publishEvent("runtime.test", null)).toThrow(
      "Runtime daemon must be running before publishing stream events.",
    );

    await daemon.stop();

    expect(() => daemon.publishEvent("runtime.test", null)).toThrow(TypeError);
  });

  it("stops once, closes SQLite, releases waiters, and cannot restart", async () => {
    const daemon = createDaemon();
    await daemon.start();

    const stopped = daemon.waitUntilStopped();
    expect(await daemon.stop()).toBe(true);
    await stopped;

    expect(await daemon.stop()).toBe(false);
    expect(daemon.snapshot()).toEqual({
      state: "stopped",
      api: { state: "stopped", host: "127.0.0.1", port: null, eventClients: 0 },
      database: { state: "closed", path: SQLITE_MEMORY_PATH, inMemory: true },
    });
    await expect(daemon.start()).rejects.toThrow(
      "Runtime daemon cannot restart after it has stopped.",
    );
  });

  it("coalesces concurrent stop requests", async () => {
    const daemon = createDaemon();
    await daemon.start();

    const [first, second] = await Promise.all([daemon.stop(), daemon.stop()]);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(daemon.snapshot().state).toBe("stopped");
    expect(daemon.snapshot().database.state).toBe("closed");
  });

  it("may be stopped before start without leaving live runtime resources", async () => {
    const daemon = createDaemon();

    expect(await daemon.stop()).toBe(true);
    await daemon.waitUntilStopped();

    expect(daemon.snapshot().state).toBe("stopped");
    expect(daemon.snapshot().database.state).toBe("closed");
    await expect(daemon.start()).rejects.toThrow(TypeError);
  });
});
