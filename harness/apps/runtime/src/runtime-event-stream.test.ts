import { describe, expect, it } from "vitest";

import { RuntimeEventCursorError, RuntimeEventStream } from "./runtime-event-stream.js";

describe("RuntimeEventStream", () => {
  it("assigns monotonic process-local IDs and replays strictly after a cursor", () => {
    const stream = new RuntimeEventStream({ replayCapacity: 4 });

    expect(stream.publish("run.started", { runId: "r1" })).toEqual({
      id: 1,
      type: "run.started",
      data: '{"runId":"r1"}',
    });
    stream.publish("op.started", { op: 0 });
    stream.publish("op.completed", { op: 0 });

    expect(stream.replayAfter(1).map((event) => event.id)).toEqual([2, 3]);
    expect(stream.replayAfter(3)).toEqual([]);
    expect(stream.snapshot()).toEqual({
      latestEventId: 3,
      oldestRetainedEventId: 1,
      retainedEvents: 3,
      subscribers: 0,
    });
  });

  it("rejects cursors older than the bounded replay window", () => {
    const stream = new RuntimeEventStream({ replayCapacity: 2 });
    stream.publish("one", 1);
    stream.publish("two", 2);
    stream.publish("three", 3);

    expect(stream.replayAfter(1).map((event) => event.id)).toEqual([2, 3]);
    expect(() => stream.replayAfter(0)).toThrow(RuntimeEventCursorError);
    expect(() => stream.replayAfter(4)).toThrow(RuntimeEventCursorError);
  });

  it("delivers live events in publish order and unsubscribes idempotently", () => {
    const stream = new RuntimeEventStream();
    const seen: number[] = [];
    const unsubscribe = stream.subscribe((event) => {
      seen.push(event.id);
    });

    expect(stream.snapshot().subscribers).toBe(1);
    stream.publish("one", null);
    stream.publish("two", null);
    unsubscribe();
    unsubscribe();
    stream.publish("three", null);

    expect(seen).toEqual([1, 2]);
    expect(stream.snapshot().subscribers).toBe(0);
  });

  it("does not consume an event ID when validation or serialization fails", () => {
    const stream = new RuntimeEventStream();
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() => stream.publish("", {})).toThrow(TypeError);
    expect(() => stream.publish("bad\nname", {})).toThrow(TypeError);
    expect(() => stream.publish("undefined", undefined)).toThrow(TypeError);
    expect(() => stream.publish("circular", circular)).toThrow(TypeError);

    expect(stream.publish("valid", { ok: true }).id).toBe(1);
  });

  it("validates replay capacity and cursor shape", () => {
    for (const replayCapacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new RuntimeEventStream({ replayCapacity })).toThrow(TypeError);
    }

    const stream = new RuntimeEventStream();
    for (const cursor of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => stream.replayAfter(cursor)).toThrow(TypeError);
    }
  });
});
