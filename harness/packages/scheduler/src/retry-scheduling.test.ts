import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import { SchedulerConcurrency } from "./concurrency.js";
import {
  NodeTimeoutError,
  PlainDagRun,
  type PlainDagRetryBackoffContext,
  type PlainDagRetryJitterContext,
} from "./plain-dag-run.js";

interface OpOptions {
  readonly timeoutMs?: number;
  readonly retry?: {
    readonly maxAttempts: number;
    readonly backoffMs?: number;
  };
}

function op(
  sourceNodeId: string,
  dependencies: readonly number[],
  options: OpOptions = {},
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
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded retry scheduling", () => {
  it("retries the same logical op up to maxAttempts and releases downstream only after success", async () => {
    const plan = ir([
      op("flaky", [], { retry: { maxAttempts: 3, backoffMs: 0 } }),
      op("child", [0]),
    ]);
    const scheduler = new SchedulerConcurrency(1);
    const calls: string[] = [];
    const run = new PlainDagRun(plan, scheduler.createRun(plan), ({ op: opIndex, attempt }) => {
      calls.push(`${String(opIndex)}:${String(attempt)}`);
      if (opIndex === 0 && attempt < 3) {
        throw new Error(`transient-${String(attempt)}`);
      }
    });

    const result = await run.execute();

    expect(calls).toEqual(["0:1", "0:2", "0:3", "1:1"]);
    expect(result.attempts).toEqual([3, 1]);
    expect(Object.isFrozen(result.attempts)).toBe(true);
    expect(result.readiness.ops.map(({ status }) => status)).toEqual(["completed", "completed"]);
    expect(result.readiness.remainingDependencies).toEqual([0, 0]);
  });

  it("fails only after the final bounded attempt and preserves the last executor error", async () => {
    const plan = ir([
      op("always-fails", [], { retry: { maxAttempts: 3, backoffMs: 0 } }),
      op("child", [0]),
    ]);
    const scheduler = new SchedulerConcurrency(1);
    const failures = [new Error("first"), new Error("second"), new Error("final")];
    const run = new PlainDagRun(plan, scheduler.createRun(plan), ({ attempt }) => {
      const failure = failures[attempt - 1];
      if (failure === undefined) {
        throw new Error(`Unexpected retry attempt ${String(attempt)}.`);
      }
      throw failure;
    });

    await expect(run.execute()).rejects.toBe(failures[2]);

    expect(run.snapshot().attempts).toEqual([3, 0]);
    expect(run.snapshot().readiness.ops).toEqual([
      { op: 0, status: "failed" },
      { op: 1, status: "pending" },
    ]);
    expect(run.snapshot().readiness.remainingDependencies).toEqual([0, 1]);
  });

  it("releases concurrency during retry wait so unrelated ready work can run", async () => {
    vi.useFakeTimers();
    const plan = ir(
      [op("retrying", [], { retry: { maxAttempts: 2, backoffMs: 100 } }), op("independent", [])],
      1,
    );
    const scheduler = new SchedulerConcurrency(1);
    const events: string[] = [];
    const independentStarted = deferred();
    const run = new PlainDagRun(plan, scheduler.createRun(plan), ({ op: opIndex, attempt }) => {
      events.push(`${String(opIndex)}:${String(attempt)}`);
      if (opIndex === 0 && attempt === 1) {
        throw new Error("retry me");
      }
      if (opIndex === 1) {
        independentStarted.resolve();
      }
    });

    const execution = run.execute();
    await independentStarted.promise;
    await flushMicrotasks();

    expect(events).toEqual(["0:1", "1:1"]);
    expect(run.snapshot().readiness.ops).toEqual([
      { op: 0, status: "retry-wait" },
      { op: 1, status: "completed" },
    ]);
    expect(run.snapshot().concurrency.run.active).toBe(0);

    const settled = expect(execution).resolves.toMatchObject({ attempts: [2, 1] });
    await vi.advanceTimersByTimeAsync(100);
    await settled;
    expect(events).toEqual(["0:1", "1:1", "0:2"]);
  });

  it("runs deterministic backoff then jitter hooks with frozen retry context", async () => {
    vi.useFakeTimers();
    const plan = ir([op("flaky", [], { retry: { maxAttempts: 2, backoffMs: 20 } })]);
    const scheduler = new SchedulerConcurrency(1);
    const backoffContexts: PlainDagRetryBackoffContext[] = [];
    const jitterContexts: PlainDagRetryJitterContext[] = [];
    const attempts: number[] = [];
    const run = new PlainDagRun(
      plan,
      scheduler.createRun(plan),
      ({ attempt }) => {
        attempts.push(attempt);
        if (attempt === 1) {
          throw new Error("transient");
        }
      },
      {
        retry: {
          backoff: (context) => {
            backoffContexts.push(context);
            return context.configuredBackoffMs * 2;
          },
          jitter: (context) => {
            jitterContexts.push(context);
            return context.backoffMs + 7;
          },
        },
      },
    );

    const execution = run.execute();
    await flushMicrotasks();

    expect(attempts).toEqual([1]);
    expect(backoffContexts).toHaveLength(1);
    expect(backoffContexts[0]).toMatchObject({
      op: 0,
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 2,
      configuredBackoffMs: 20,
    });
    expect(jitterContexts[0]).toMatchObject({ backoffMs: 40 });
    expect(Object.isFrozen(backoffContexts[0])).toBe(true);
    expect(Object.isFrozen(jitterContexts[0])).toBe(true);

    await vi.advanceTimersByTimeAsync(46);
    expect(attempts).toEqual([1]);

    const settled = expect(execution).resolves.toMatchObject({ attempts: [2] });
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(attempts).toEqual([1, 2]);
  });

  it("cancels retry-wait promptly and never starts another attempt", async () => {
    vi.useFakeTimers();
    const plan = ir([op("flaky", [], { retry: { maxAttempts: 3, backoffMs: 10_000 } })]);
    const scheduler = new SchedulerConcurrency(1);
    const attempts: number[] = [];
    const run = new PlainDagRun(plan, scheduler.createRun(plan), ({ attempt }) => {
      attempts.push(attempt);
      throw new Error("transient");
    });

    const execution = run.execute();
    await flushMicrotasks();
    expect(run.snapshot().readiness.ops).toEqual([{ op: 0, status: "retry-wait" }]);

    const reason = new Error("cancel during backoff");
    const rejected = expect(execution).rejects.toBe(reason);
    expect(run.cancel(reason)).toBe(true);
    await rejected;

    await vi.advanceTimersByTimeAsync(20_000);
    expect(attempts).toEqual([1]);
    expect(run.snapshot().readiness.ops).toEqual([{ op: 0, status: "cancelled" }]);
  });

  it("does not overlap a retry with an uncooperative timed-out prior attempt", async () => {
    vi.useFakeTimers();
    const plan = ir(
      [op("slow", [], { timeoutMs: 10, retry: { maxAttempts: 2, backoffMs: 0 } })],
      2,
    );
    const scheduler = new SchedulerConcurrency(2);
    const firstStarted = deferred();
    const firstAttemptGate = deferred();
    const attempts: number[] = [];
    const run = new PlainDagRun(plan, scheduler.createRun(plan), async ({ attempt }) => {
      attempts.push(attempt);
      if (attempt === 1) {
        firstStarted.resolve();
        await firstAttemptGate.promise;
      }
    });

    const execution = run.execute();
    await firstStarted.promise;
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();

    expect(attempts).toEqual([1]);
    expect(run.snapshot().readiness.ops).toEqual([{ op: 0, status: "retry-wait" }]);
    expect(run.snapshot().concurrency.run.active).toBe(1);
    expect(run.snapshot().concurrency.global.active).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toEqual([1]);

    firstAttemptGate.resolve();
    const settled = expect(execution).resolves.toMatchObject({ attempts: [2] });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await settled;

    expect(attempts).toEqual([1, 2]);
    expect(run.snapshot().concurrency.run.active).toBe(0);
    expect(run.snapshot().concurrency.global.active).toBe(0);
  });

  it("retries NodeTimeoutError like any other scheduler-visible attempt failure", async () => {
    vi.useFakeTimers();
    const plan = ir([op("slow", [], { timeoutMs: 5, retry: { maxAttempts: 2 } })]);
    const scheduler = new SchedulerConcurrency(1);
    const attempts: number[] = [];
    const run = new PlainDagRun(plan, scheduler.createRun(plan), async ({ attempt, signal }) => {
      attempts.push(attempt);
      if (attempt === 1) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
            { once: true },
          );
        });
      }
    });

    const execution = run.execute();
    await flushMicrotasks();
    const settled = expect(execution).resolves.toMatchObject({ attempts: [2] });
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(0);
    await settled;

    expect(attempts).toEqual([1, 2]);
    expect(run.signal.aborted).toBe(false);
  });

  it("treats invalid retry-hook delays as scheduler failures instead of starting another attempt", async () => {
    const plan = ir([op("flaky", [], { retry: { maxAttempts: 2, backoffMs: 1 } })]);
    const scheduler = new SchedulerConcurrency(1);
    const run = new PlainDagRun(
      plan,
      scheduler.createRun(plan),
      () => {
        throw new Error("transient");
      },
      { retry: { backoff: () => -1 } },
    );

    await expect(run.execute()).rejects.toThrow(
      "Run op 0 retry backoff hook result must be a non-negative safe integer.",
    );
    expect(run.snapshot().attempts).toEqual([1]);
    expect(run.snapshot().readiness.ops).toEqual([{ op: 0, status: "failed" }]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects malformed runtime retry.maxAttempts %s even when IR bypasses the compiler",
    (maxAttempts) => {
      const plan = ir([op("bad-retry", [], { retry: { maxAttempts } })]);
      const scheduler = new SchedulerConcurrency(1);

      expect(() => new PlainDagRun(plan, scheduler.createRun(plan), () => undefined)).toThrow(
        "Run op 0 retry.maxAttempts must be a positive safe integer.",
      );
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects malformed runtime retry.backoffMs %s even when IR bypasses the compiler",
    (backoffMs) => {
      const plan = ir([op("bad-backoff", [], { retry: { maxAttempts: 2, backoffMs } })]);
      const scheduler = new SchedulerConcurrency(1);

      expect(() => new PlainDagRun(plan, scheduler.createRun(plan), () => undefined)).toThrow(
        "Run op 0 retry.backoffMs must be a non-negative safe integer.",
      );
    },
  );

  it("preserves NodeTimeoutError identity when a timeout exhausts its final attempt", async () => {
    vi.useFakeTimers();
    const plan = ir([op("slow", [], { timeoutMs: 5, retry: { maxAttempts: 1 } })]);
    const scheduler = new SchedulerConcurrency(1);
    const run = new PlainDagRun(plan, scheduler.createRun(plan), async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
          { once: true },
        );
      });
    });

    const execution = run.execute();
    const rejected = expect(execution).rejects.toBeInstanceOf(NodeTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    await rejected;
    expect(run.snapshot().attempts).toEqual([1]);
  });
});
