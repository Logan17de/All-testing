import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import { SchedulerConcurrency } from "./concurrency.js";
import { NodeTimeoutError, PlainDagRun } from "./plain-dag-run.js";

function op(
  sourceNodeId: string,
  dependencies: readonly number[],
  timeoutMs?: number,
): ExecutionIrOpV1 {
  return {
    sourceNodeId,
    type: "test.node",
    version: "1",
    config: {},
    inputs: [],
    dependencies,
    behavior: {
      primitiveFamily: "pure",
      determinism: "deterministic",
      effect: "none",
      idempotency: "not-applicable",
      recovery: "rerun",
      executionMode: "in-process",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      requiredCapabilities: [],
    },
  };
}

function ir(ops: readonly ExecutionIrOpV1[], maxParallelism = 1): ExecutionIrV1 {
  return {
    format: "harness.ir/v1",
    graphInputs: [],
    graphOutputs: [],
    ops,
    controlEdges: [],
    entrypoints: [],
    policies: {
      maxParallelism,
      capabilities: { required: [], optional: [], deny: [] },
    },
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }

  return new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("node timeouts", () => {
  it("aborts only the timed op, marks it failed, and releases no downstream dependency", async () => {
    vi.useFakeTimers();
    const plan = ir([op("slow", [], 25), op("child", [0])]);
    const scheduler = new SchedulerConcurrency(1);
    const started = deferred();
    let executorSignal: AbortSignal | undefined;

    const run = new PlainDagRun(plan, scheduler.createRun(plan), async ({ signal }) => {
      executorSignal = signal;
      started.resolve();
      await waitForAbort(signal);
    });

    const execution = run.execute();
    const rejection = expect(execution).rejects.toMatchObject({
      name: "NodeTimeoutError",
      code: "NODE_TIMEOUT",
      op: 0,
      timeoutMs: 25,
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    expect(executorSignal?.aborted).toBe(true);
    expect(executorSignal?.reason).toBeInstanceOf(NodeTimeoutError);
    expect(run.signal.aborted).toBe(false);
    expect(run.snapshot().readiness.ops).toEqual([
      { op: 0, status: "failed" },
      { op: 1, status: "pending" },
    ]);
    expect(run.snapshot().readiness.remainingDependencies).toEqual([0, 1]);
  });

  it("passes the exact run signal through when an op has no timeout", async () => {
    const plan = ir([op("fast", [])]);
    const scheduler = new SchedulerConcurrency(1);
    let executorSignal: AbortSignal | undefined;
    const run = new PlainDagRun(plan, scheduler.createRun(plan), ({ signal }) => {
      executorSignal = signal;
    });

    await run.execute();

    expect(executorSignal).toBe(run.signal);
    expect(executorSignal?.aborted).toBe(false);
    expect(run.snapshot().readiness.ops).toEqual([{ op: 0, status: "completed" }]);
  });

  it("clears the timeout after fast completion so the executor signal never aborts later", async () => {
    vi.useFakeTimers();
    const plan = ir([op("fast", [], 50)]);
    const scheduler = new SchedulerConcurrency(1);
    let executorSignal: AbortSignal | undefined;
    const run = new PlainDagRun(plan, scheduler.createRun(plan), ({ signal }) => {
      executorSignal = signal;
    });

    await run.execute();
    await vi.advanceTimersByTimeAsync(500);

    expect(executorSignal?.aborted).toBe(false);
    expect(run.snapshot().readiness.ops).toEqual([{ op: 0, status: "completed" }]);
  });

  it("lets earlier run cancellation win instead of relabeling it as a timeout", async () => {
    vi.useFakeTimers();
    const plan = ir([op("slow", [], 1_000)]);
    const scheduler = new SchedulerConcurrency(1);
    const started = deferred();
    const run = new PlainDagRun(plan, scheduler.createRun(plan), async ({ signal }) => {
      started.resolve();
      await waitForAbort(signal);
    });

    const execution = run.execute();
    await started.promise;
    const reason = new Error("user cancelled");
    expect(run.cancel(reason)).toBe(true);

    await expect(execution).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.snapshot().readiness.ops).toEqual([{ op: 0, status: "cancelled" }]);
  });

  it("keeps an uncooperative timed-out executor charged against concurrency until it settles", async () => {
    vi.useFakeTimers();
    const plan = ir([op("ignores-abort", [], 10)]);
    const scheduler = new SchedulerConcurrency(1);
    const started = deferred();
    const executorGate = deferred();
    const run = new PlainDagRun(plan, scheduler.createRun(plan), async () => {
      started.resolve();
      await executorGate.promise;
    });

    const execution = run.execute();
    const rejection = expect(execution).rejects.toBeInstanceOf(NodeTimeoutError);
    await started.promise;
    await vi.advanceTimersByTimeAsync(10);
    await rejection;

    expect(run.snapshot().settled).toBe(true);
    expect(run.snapshot().concurrency.run.active).toBe(1);
    expect(run.snapshot().concurrency.global.active).toBe(1);

    executorGate.resolve();
    await flushMicrotasks();
    expect(run.snapshot().concurrency.run.active).toBe(0);
    expect(run.snapshot().concurrency.global.active).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects malformed runtime timeout %s even when IR bypasses the compiler",
    (timeoutMs) => {
      const plan = ir([op("bad-timeout", [], timeoutMs)]);
      const scheduler = new SchedulerConcurrency(1);

      expect(() => new PlainDagRun(plan, scheduler.createRun(plan), () => undefined)).toThrow(
        "Run op 0 timeoutMs must be a positive safe integer.",
      );
    },
  );
});
