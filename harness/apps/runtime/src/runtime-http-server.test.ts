import { once } from "node:events";
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { RuntimeHttpServer } from "./runtime-http-server.js";

describe("RuntimeHttpServer", () => {
  it("binds loopback by default and serves the runtime health endpoint", async () => {
    const server = new RuntimeHttpServer({ port: 0 });

    expect(await server.start()).toBe(true);
    expect(await server.start()).toBe(false);

    const snapshot = server.snapshot();
    expect(snapshot.state).toBe("listening");
    expect(snapshot.host).toBe("127.0.0.1");
    expect(snapshot.port).toBeGreaterThan(0);

    const response = await fetch(`http://${snapshot.host}:${String(snapshot.port)}/api/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "zet-harness-runtime",
    });

    expect(await server.stop()).toBe(true);
    expect(await server.stop()).toBe(false);
  });

  it("returns small JSON errors for unsupported routes and methods", async () => {
    const server = new RuntimeHttpServer({ port: 0 });
    await server.start();

    try {
      const snapshot = server.snapshot();
      const baseUrl = `http://${snapshot.host}:${String(snapshot.port)}`;

      const missing = await fetch(`${baseUrl}/missing`);
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toEqual({ error: "not_found" });

      const wrongMethod = await fetch(`${baseUrl}/api/health`, { method: "POST" });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("GET");
      await expect(wrongMethod.json()).resolves.toEqual({
        error: "method_not_allowed",
        allowed: ["GET"],
      });
    } finally {
      await server.stop();
    }
  });

  it("does not report listening when the requested port cannot be bound", async () => {
    const blocker = createServer();
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");

    const address = blocker.address();
    if (address === null || typeof address === "string") {
      blocker.close();
      throw new TypeError("Test blocker did not expose a TCP address.");
    }

    const server = new RuntimeHttpServer({ port: address.port });

    try {
      await expect(server.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(server.snapshot()).toEqual({
        state: "idle",
        host: "127.0.0.1",
        port: null,
      });
    } finally {
      await server.stop();
      blocker.close();
      await once(blocker, "close");
    }
  });

  it("rejects invalid ports before creating a listener", () => {
    for (const port of [-1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new RuntimeHttpServer({ port })).toThrow(
        "Runtime HTTP port must be a safe integer from 0 through 65535.",
      );
    }
  });
});
