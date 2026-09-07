import { describe, expect, it } from "vitest";

import { TypedRuntimeEventEmitter } from "./runtime-event-emitter.js";

type TestRuntimeEvent =
  | { readonly type: "run.started"; readonly runId: string }
  | { readonly type: "op.started"; readonly op: number }
  | { readonly type: "op.progress"; readonly op: number; readonly progress: number };

describe("TypedRuntimeEventEmitter", () => {
  it("routes typed and catch-all listeners in global subscription order", () => {
    const emitter = new TypedRuntimeEventEmitter<TestRuntimeEvent>();
    const deliveries: string[] = [];

    emitter.onAny((event) => {
      deliveries.push(`any-1:${event.type}`);
    });
    emitter.on("op.started", (event) => {
      deliveries.push(`op:${String(event.op)}`);
    });
    emitter.onAny((event) => {
      deliveries.push(`any-2:${event.type}`);
    });
    emitter.on("run.started", (event) => {
      deliveries.push(`run:${event.runId}`);
    });

    emitter.emit({ type: "op.started", op: 7 });

    expect(deliveries).toEqual(["any-1:op.started", "op:7", "any-2:op.started"]);
  });

  it("returns an idempotent unsubscribe handle", () => {
    const emitter = new TypedRuntimeEventEmitter<TestRuntimeEvent>();
    const deliveries: number[] = [];
    const unsubscribe = emitter.on("op.started", (event) => {
      deliveries.push(event.op);
    });

    emitter.emit({ type: "op.started", op: 1 });
    unsubscribe();
    unsubscribe();
    emitter.emit({ type: "op.started", op: 2 });

    expect(deliveries).toEqual([1]);
  });

  it("snapshots subscriptions so mutations during emit affect only later events", () => {
    const emitter = new TypedRuntimeEventEmitter<TestRuntimeEvent>();
    const deliveries: string[] = [];
    let unsubscribeSecond = (): void => undefined;
    let addedThird = false;

    emitter.on("op.progress", () => {
      deliveries.push("first");
      unsubscribeSecond();
      if (!addedThird) {
        addedThird = true;
        emitter.on("op.progress", () => {
          deliveries.push("third");
        });
      }
    });
    unsubscribeSecond = emitter.on("op.progress", () => {
      deliveries.push("second");
    });

    emitter.emit({ type: "op.progress", op: 1, progress: 0.5 });
    emitter.emit({ type: "op.progress", op: 1, progress: 1 });

    expect(deliveries).toEqual(["first", "second", "first", "third"]);
  });

  it("treats duplicate subscriptions as independent registrations", () => {
    const emitter = new TypedRuntimeEventEmitter<TestRuntimeEvent>();
    let calls = 0;
    const listener = (): void => {
      calls += 1;
    };

    const unsubscribeFirst = emitter.on("run.started", listener);
    emitter.on("run.started", listener);

    emitter.emit({ type: "run.started", runId: "run-1" });
    unsubscribeFirst();
    emitter.emit({ type: "run.started", runId: "run-2" });

    expect(calls).toBe(3);
  });

  it("does not swallow listener exceptions", () => {
    const emitter = new TypedRuntimeEventEmitter<TestRuntimeEvent>();
    const error = new Error("listener failure");
    let laterListenerCalled = false;

    emitter.on("run.started", () => {
      throw error;
    });
    emitter.on("run.started", () => {
      laterListenerCalled = true;
    });

    expect(() => emitter.emit({ type: "run.started", runId: "run-1" })).toThrow(error);
    expect(laterListenerCalled).toBe(false);
  });

  it("keeps event names and listener payloads statically narrowed", () => {
    const emitter = new TypedRuntimeEventEmitter<TestRuntimeEvent>();

    emitter.on("op.started", (event) => {
      expect(event.op).toBe(3);
    });
    emitter.emit({ type: "op.started", op: 3 });

    if (false) {
      // @ts-expect-error unknown event names are rejected.
      emitter.on("op.missing", () => undefined);
      emitter.on("run.started", (event) => {
        // @ts-expect-error a run event does not carry an op index.
        void event.op;
      });
      // @ts-expect-error op.started requires an op index.
      emitter.emit({ type: "op.started" });
    }
  });
});
