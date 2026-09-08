import { once } from "node:events";
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { RuntimeEventStream } from "./runtime-event-stream.js";
import { RuntimeHttpServer } from "./runtime-http-server.js";

const requireReader = (response: Response): ReadableStreamDefaultReader<Uint8Array> => {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new TypeError("Expected SSE response body.");
  }
  return reader;
};

const readUntil = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> => {
  const decoder = new TextDecoder();
  let text = "";

  for (let chunkIndex = 0; chunkIndex < 20; chunkIndex += 1) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    text += decoder.decode(result.value, { stream: true });
    if (text.includes(marker)) {
      return text;
    }
  }

  throw new Error(`SSE stream ended before marker ${JSON.stringify(marker)}. Received: ${text}`);
};

describe("RuntimeHttpServer", () => {
  it("binds loopback by default and serves the runtime health endpoint", async () => {
    const server = new RuntimeHttpServer({ port: 0 });

    expect(await server.start()).toBe(true);
    expect(await server.start()).toBe(false);

    const snapshot = server.snapshot();
    expect(snapshot.state).toBe("listening");
    expect(snapshot.host).toBe("127.0.0.1");
    expect(snapshot.port).toBeGreaterThan(0);
    expect(snapshot.eventClients).toBe(0);

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

  it("returns 503 for unhealthy or failed health providers without leaking exceptions", async () => {
    const unhealthy = new RuntimeHttpServer({ port: 0 }, new RuntimeEventStream(), () => ({
      status: "unhealthy",
      service: "zet-harness-runtime",
      checks: { database: { status: "unhealthy" } },
    }));
    await unhealthy.start();

    try {
      const snapshot = unhealthy.snapshot();
      const response = await fetch(`http://${snapshot.host}:${String(snapshot.port)}/api/health`);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        status: "unhealthy",
        service: "zet-harness-runtime",
        checks: { database: { status: "unhealthy" } },
      });
    } finally {
      await unhealthy.stop();
    }

    const failed = new RuntimeHttpServer({ port: 0 }, new RuntimeEventStream(), () => {
      throw new Error("sensitive database detail");
    });
    await failed.start();

    try {
      const snapshot = failed.snapshot();
      const response = await fetch(`http://${snapshot.host}:${String(snapshot.port)}/api/health`);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).not.toContain("sensitive database detail");
      expect(JSON.parse(body)).toEqual({
        status: "unhealthy",
        service: "zet-harness-runtime",
        checks: { health: { status: "unhealthy" } },
      });
    } finally {
      await failed.stop();
    }
  });

  it("streams live SSE events and starts cursorless clients from now", async () => {
    const events = new RuntimeEventStream();
    const server = new RuntimeHttpServer({ port: 0 }, events);
    events.publish("before.connect", { ignored: true });
    await server.start();

    const snapshot = server.snapshot();
    const response = await fetch(`http://${snapshot.host}:${String(snapshot.port)}/api/events`);
    const reader = requireReader(response);

    try {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(server.snapshot().eventClients).toBe(1);

      events.publish("after.connect", { value: 2 });
      const text = await readUntil(reader, "event: after.connect");

      expect(text).toContain("id: 2\n");
      expect(text).not.toContain("event: before.connect");
      expect(text).toContain('data: {"value":2}\n\n');
    } finally {
      await reader.cancel();
      await server.stop();
    }
  });

  it("replays events after query cursor or Last-Event-ID", async () => {
    const events = new RuntimeEventStream();
    const server = new RuntimeHttpServer({ port: 0 }, events);
    events.publish("one", 1);
    events.publish("two", 2);
    events.publish("three", 3);
    await server.start();

    const snapshot = server.snapshot();
    const baseUrl = `http://${snapshot.host}:${String(snapshot.port)}`;
    const queryResponse = await fetch(`${baseUrl}/api/events?cursor=1`);
    const queryReader = requireReader(queryResponse);

    try {
      const queryText = await readUntil(queryReader, "event: three");
      expect(queryText).not.toContain("event: one");
      expect(queryText).toContain("id: 2\nevent: two\ndata: 2\n\n");
      expect(queryText).toContain("id: 3\nevent: three\ndata: 3\n\n");
    } finally {
      await queryReader.cancel();
    }

    const headerResponse = await fetch(`${baseUrl}/api/events`, {
      headers: { "Last-Event-ID": "2" },
    });
    const headerReader = requireReader(headerResponse);

    try {
      const headerText = await readUntil(headerReader, "event: three");
      expect(headerText).not.toContain("event: two");
      expect(headerText).toContain("id: 3\nevent: three\ndata: 3\n\n");
    } finally {
      await headerReader.cancel();
      await server.stop();
    }
  });

  it("rejects unavailable, future, malformed, or conflicting event cursors", async () => {
    const events = new RuntimeEventStream({ replayCapacity: 2 });
    const server = new RuntimeHttpServer({ port: 0 }, events);
    events.publish("one", 1);
    events.publish("two", 2);
    events.publish("three", 3);
    await server.start();

    try {
      const snapshot = server.snapshot();
      const baseUrl = `http://${snapshot.host}:${String(snapshot.port)}`;

      const stale = await fetch(`${baseUrl}/api/events?cursor=0`);
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toEqual({
        error: "event_cursor_unavailable",
        cursor: 0,
        oldestRetainedEventId: 2,
        latestEventId: 3,
      });

      const future = await fetch(`${baseUrl}/api/events?cursor=4`);
      expect(future.status).toBe(409);

      const malformed = await fetch(`${baseUrl}/api/events?cursor=1.5`);
      expect(malformed.status).toBe(400);

      const conflicting = await fetch(`${baseUrl}/api/events?cursor=1`, {
        headers: { "Last-Event-ID": "2" },
      });
      expect(conflicting.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("closes connected SSE clients during server shutdown", async () => {
    const events = new RuntimeEventStream();
    const server = new RuntimeHttpServer({ port: 0 }, events);
    await server.start();

    const snapshot = server.snapshot();
    const response = await fetch(`http://${snapshot.host}:${String(snapshot.port)}/api/events`);
    const reader = requireReader(response);

    expect(server.snapshot().eventClients).toBe(1);
    await readUntil(reader, ": connected");
    await server.stop();

    const result = await reader.read();
    expect(result.done).toBe(true);
    expect(events.snapshot().subscribers).toBe(0);
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

      const wrongEventMethod = await fetch(`${baseUrl}/api/events`, { method: "POST" });
      expect(wrongEventMethod.status).toBe(405);
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
        eventClients: 0,
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
