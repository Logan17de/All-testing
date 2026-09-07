import { describe, expect, it } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import { AsyncSemaphore, SchedulerConcurrency } from "./concurrency.js";
import { PlainDagRun } from "./plain-dag-run.js";
import { RunReadiness } from "./run-readiness.js";

function op(sourceNodeId: string, dependencies: readonly number[]): ExecutionIrOpV1 {
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

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("run cancellation", () => {
  it("aborts a running executor, cancels downstream work, and rejects with the exact reason", async () => {
    const plan = ir([op("root", []), op("child", [0])]);
    const scheduler = new SchedulerConcurrency(1);
    const started = deferred();
    let receivedSignal: AbortSignal | undefined;

    const run = new PlainDagRun(plan, scheduler.createRun(plan), async ({ signal }) => {
      receivedSignal = signal;
      started.resolve();
      await waitForAbort(signal);
    });

    const execution = run.execute();
    await started.promise;

    const reason = new Error("stop this run");
    expect(run.cancel(reason)).toBe(true);
    await expect(execution).rejects.toBe(reason);

    expect(receivedSignal).toBe(run.signal);
    expect(run.signal.aborted).toBe(true);
    expect(run.signal.reason).toBe(reason);
    expect(run.cancel(new Error("second request"))).toBe(false);
    expect(run.snapshot()).toMatchObject({
      started: true,
      settled: true,
      cancelled: true,
      readiness: {
        ops: [
          { op: 0, status: "cancelled" },
          { op: 1, status: "cancelled" },
        ],
        readyQueue: [],
      },
      concurrency: {
        run: { active: 0, waiting: 0 },
        global: { active: 0, waiting: 0 },
      },
    });
  });

  it("supports cancellation before execution without invoking an executor", async () => {
    const plan = ir([op("root", [])]);
    const scheduler = new SchedulerConcurrency(1);
    let calls = 0;
    const run = new PlainDagRun(plan, scheduler.createRun(plan), () => {
      calls += 1;
    });
    const reason = new Error("cancel before start");

    expect(run.cancel(reason)).toBe(true);
    expect(run.snapshot().readiness.ops).toEqual([{ op: 0, status: "cancelled" }]);
    await expect(run.execute()).rejects.toBe(reason);
    expect(calls).toBe(0);
    expect(run.snapshot().settled).toBe(true);
  });

  it("preserves completed work while cancelling only unfinished ops", async () => {
    const plan = ir([op("root", []), op("child", [0])]);
    const scheduler = new SchedulerConcurrency(1);
    const childStarted = deferred();

    const run = new PlainDagRun(
      plan,
      scheduler.createRun(plan),
      async ({ op: opIndex, signal }) => {
        if (opIndex === 1) {
          childStarted.resolve();
          await waitForAbort(signal);
        }
      },
    );

    const execution = run.execute();
    await childStarted.promise;
    const reason = new Error("stop after root");
    run.cancel(reason);
    await expect(execution).rejects.toBe(reason);

    expect(run.snapshot().readiness.ops).toEqual([
      { op: 0, status: "completed" },
      { op: 1, status: "cancelled" },
    ]);
  });

  it("removes an aborted semaphore waiter without disturbing the next FIFO admission", async () => {
    const semaphore = new AsyncSemaphore(1);
    const first = await semaphore.acquire();
    const controller = new AbortController();
    const reason = new Error("leave queue");
    const waiting = semaphore.acquire(controller.signal);

    expect(semaphore.waitingCount).toBe(1);
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(semaphore.snapshot()).toEqual({ limit: 1, active: 1, waiting: 0, available: 0 });

    const next = semaphore.acquire();
    first.release();
    const permit = await next;
    permit.release();
    expect(semaphore.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0, available: 1 });
  });

  it("releases a run-local permit when cancellation aborts a global-capacity waiter", async () => {
    const scheduler = new SchedulerConcurrency(1);
    const blocker = scheduler.createRun(ir([op("blocker", [])]));
    const blockedRun = scheduler.createRun(ir([op("blocked", [])]));
    const blockerPermit = await blocker.acquire();
    const controller = new AbortController();
    const reason = new Error("cancel global waiter");
    const waiting = blockedRun.acquire(controller.signal);

    await flushMicrotasks();
    expect(blockedRun.snapshot().run).toMatchObject({ active: 1, waiting: 0 });
    expect(scheduler.snapshot()).toMatchObject({ active: 1, waiting: 1 });

    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(blockedRun.snapshot().run).toMatchObject({ active: 0, waiting: 0 });
    expect(scheduler.snapshot()).toMatchObject({ active: 1, waiting: 0 });

    blockerPermit.release();
    expect(scheduler.snapshot().active).toBe(0);
  });

  it("clears queued and reserved readiness atomically and remains idempotent", () => {
    const readiness = new RunReadiness(
      ir([op("running", []), op("pending", [0]), op("ready", [])], 2),
    );

    expect(readiness.dequeueReadyOp()).toBe(0);
    readiness.startReservedReadyOp(0);
    expect(readiness.dequeueReadyOp()).toBe(2);

    expect(readiness.cancelNonTerminalOps()).toEqual([0, 1, 2]);
    expect(readiness.cancelNonTerminalOps()).toEqual([]);
    expect(readiness.getReadyQueue()).toEqual([]);
    expect(readiness.isReadyOpReserved(2)).toBe(false);
    expect(readiness.snapshot().ops).toEqual([
      { op: 0, status: "cancelled" },
      { op: 1, status: "cancelled" },
      { op: 2, status: "cancelled" },
    ]);
  });
});
