import { describe, expect, it } from "vitest";

import {
  RuntimeEventChannels,
  isDurableRuntimeEvent,
  isTransientRuntimeEvent,
  type ClassifiedRuntimeEventLike,
} from "./runtime-event-channels.js";

type TestRuntimeEvent =
  | {
      readonly type: "model.delta";
      readonly persistence: "transient";
      readonly text: string;
    }
  | {
      readonly type: "op.progress";
      readonly persistence: "transient";
      readonly op: number;
      readonly progress: number;
    }
  | {
      readonly type: "op.completed";
      readonly persistence: "durable";
      readonly op: number;
    }
  | {
      readonly type: "run.failed";
      readonly persistence: "durable";
      readonly message: string;
    };

describe("RuntimeEventChannels", () => {
  it("routes transient events only to transient listeners", () => {
    const channels = new RuntimeEventChannels<TestRuntimeEvent>();
    const transient: string[] = [];
    const durable: string[] = [];

    channels.onTransientAny((event) => transient.push(event.type));
    channels.onDurableAny((event) => durable.push(event.type));

    channels.emit({ type: "model.delta", persistence: "transient", text: "hel" });
    channels.emit({ type: "op.progress", persistence: "transient", op: 2, progress: 0.5 });

    expect(transient).toEqual(["model.delta", "op.progress"]);
    expect(durable).toEqual([]);
  });

  it("routes durable events only to persistence-eligible listeners", () => {
    const channels = new RuntimeEventChannels<TestRuntimeEvent>();
    const transient: string[] = [];
    const durable: string[] = [];

    channels.onTransientAny((event) => transient.push(event.type));
    channels.onDurableAny((event) => durable.push(event.type));

    channels.emit({ type: "op.completed", persistence: "durable", op: 4 });
    channels.emit({ type: "run.failed", persistence: "durable", message: "boom" });

    expect(transient).toEqual([]);
    expect(durable).toEqual(["op.completed", "run.failed"]);
  });

  it("preserves the original event object and per-channel subscription order", () => {
    const channels = new RuntimeEventChannels<TestRuntimeEvent>();
    const deliveries: Array<{ readonly listener: string; readonly event: TestRuntimeEvent }> = [];
    const event = {
      type: "op.completed",
      persistence: "durable",
      op: 9,
    } as const;

    channels.onDurableAny((received) => deliveries.push({ listener: "any-1", event: received }));
    channels.onDurable("op.completed", (received) =>
      deliveries.push({ listener: "typed", event: received }),
    );
    channels.onDurableAny((received) => deliveries.push({ listener: "any-2", event: received }));

    channels.emit(event);

    expect(deliveries.map(({ listener }) => listener)).toEqual(["any-1", "typed", "any-2"]);
    expect(deliveries.every(({ event: received }) => received === event)).toBe(true);
  });

  it("exposes classification type guards", () => {
    const transient: TestRuntimeEvent = {
      type: "model.delta",
      persistence: "transient",
      text: "x",
    };
    const durable: TestRuntimeEvent = {
      type: "op.completed",
      persistence: "durable",
      op: 1,
    };

    expect(isTransientRuntimeEvent(transient)).toBe(true);
    expect(isDurableRuntimeEvent(transient)).toBe(false);
    expect(isTransientRuntimeEvent(durable)).toBe(false);
    expect(isDurableRuntimeEvent(durable)).toBe(true);
  });

  it("rejects malformed runtime persistence classifications defensively", () => {
    const channels = new RuntimeEventChannels<TestRuntimeEvent>();
    const malformed = {
      type: "model.delta",
      persistence: "unknown",
      text: "x",
    } as unknown as TestRuntimeEvent;

    expect(() => channels.emit(malformed)).toThrow(
      "Unknown runtime event persistence classification 'unknown'.",
    );
  });

  it("keeps transient and durable listener APIs statically disjoint", () => {
    const channels = new RuntimeEventChannels<TestRuntimeEvent>();

    channels.onTransient("model.delta", (event) => {
      expect(event.text).toBe("x");
    });
    channels.onDurable("op.completed", (event) => {
      expect(event.op).toBe(3);
    });

    channels.emit({ type: "model.delta", persistence: "transient", text: "x" });
    channels.emit({ type: "op.completed", persistence: "durable", op: 3 });

    if (false) {
      // @ts-expect-error durable event names cannot subscribe through the transient channel.
      channels.onTransient("op.completed", () => undefined);
      // @ts-expect-error transient event names cannot subscribe through the durable channel.
      channels.onDurable("model.delta", () => undefined);
    }
  });

  it("requires every classified event to declare persistence intent", () => {
    type Valid = TestRuntimeEvent extends ClassifiedRuntimeEventLike ? true : false;
    const valid: Valid = true;
    expect(valid).toBe(true);

    if (false) {
      type MissingPersistence = { readonly type: "missing" };
      // @ts-expect-error every routed runtime event must declare its persistence class.
      void new RuntimeEventChannels<MissingPersistence>();
    }
  });
});
