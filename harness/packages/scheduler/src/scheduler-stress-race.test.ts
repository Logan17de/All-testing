import { describe, expect, it } from "vitest";

import { AsyncSemaphore, SchedulerConcurrency } from "./concurrency.js";
import { PlainDagRun } from "./plain-dag-run.js";
import {
  createDeterministicMockGate,
  createMockExecutionIr,
  createMockExecutionOp,
} from "./testing.js";

async function waitFor(
  predicate: () => boolean,
  message: string,
  turns = 200,
): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(message);
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function createSeededDag(opCount: number, rootCount: number, seed: number) {
  const random = createSeededRandom(seed);
  return Array.from({ length: opCount }, (_, op) => {
    if (op < rootCount) {
      return createMockExecutionOp(`op-${String(op)}`);
    }

    const dependencyCount = 1 + Math.floor(random() * Math.min(3, op));
    const dependencies = new Set<number>();
    while (dependencies.size < dependencyCount) {
      dependencies.add(Math.floor(random() * op));
    }

    return createMockExecutionOp(
      `op-${String(op)}`,
      [...dependencies].sort((left, right) => left - right),
    );
  });
}

describe("scheduler stress and race coverage", () => {
  it("executes a 256-op seeded DAG exactly once under bounded concurrency", async () => {
    const opCount = 256;
    const runLimit = 8;
    const plan = createMockExecutionIr(createSeededDag(opCount, 16, 0x5eed1234), runLimit);
    const scheduler = new SchedulerConcurrency(runLimit);
    const invocationCounts = Array.from({ length: opCount }, () => 0);
    let active = 0;
    let maxActive = 0;

    const run = new PlainDagRun(plan, scheduler.createRun(plan), async ({ op }) => {
      invocationCounts[op] = (invocationCounts[op] ?? 0) + 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await Promise.resolve();
      } finally {
        active -= 1;
      }
    });

    const result = await run.execute();

    expect(invocationCounts).toEqual(Array.from({ length: opCount }, () => 1));
    expect(result.attempts).toEqual(Array.from({ length: opCount }, () => 1));
    expect(result.readiness.ops.every(({ status }) => status === "completed")).toBe(true);
    expect(maxActive).toBe(runLimit);
    expect(result.concurrency.run.active).toBe(0);
    expect(result.concurrency.run.waiting).toBe(0);
    expect(result.concurrency.global.active).toBe(0);
    expect(result.concurrency.global.waiting).toBe(0);
  });

  it("survives a 64-op concurrent retry storm without exceeding the run limit", async () => {
    const opCount = 64;
    const runLimit = 12;
    const plan = createMockExecutionIr(
      Array.from({ length: opCount }, (_, op) =>
        createMockExecutionOp(`retry-${String(op)}`, [], {
          behavior: { retry: { maxAttempts: 3, backoffMs: 0 } },
        }),
      ),
      runLimit,
    );
    const scheduler = new SchedulerConcurrency(runLimit);
    const invocationCounts = Array.from({ length: opCount }, () => 0);
    let active = 0;
    let maxActive = 0;

    const run = new PlainDagRun(
      plan,
      scheduler.createRun(plan),
      async ({ op, attempt }) => {
        invocationCounts[op] = (invocationCounts[op] ?? 0) + 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await Promise.resolve();
          if (attempt < 3) {
            throw new Error(`retry-${String(op)}-${String(attempt)}`);
          }
        } finally {
          active -= 1;
        }
      },
    );

    const result = await run.execute();

    expect(invocationCounts).toEqual(Array.from({ length: opCount }, () => 3));
    expect(result.attempts).toEqual(Array.from({ length: opCount }, () => 3));
    expect(result.attemptBudgetUsed).toEqual(Array.from({ length: opCount }, () => 3));
    expect(result.readiness.ops.every(({ status }) => status === "completed")).toBe(true);
    expect(maxActive).toBe(runLimit);
  });

  it("preserves FIFO admission while bulk-aborting semaphore waiters", async () => {
    const semaphore = new AsyncSemaphore(1);
    const holder = await semaphore.acquire();
    const waiterCount = 120;
    const controllers = Array.from({ length: waiterCount }, () => new AbortController());
    const abortReasons = controllers.map((_, index) => new Error(`abort-${String(index)}`));
    const expectedAdmissionOrder: number[] = [];

    const waiters = controllers.map((controller, index) =>
      semaphore.acquire(controller.signal).then(
        (permit) => ({ kind: "permit" as const, index, permit }),
        (error: unknown) => ({ kind: "error" as const, index, error }),
      ),
    );

    for (let index = 0; index < waiterCount; index += 1) {
      if (index % 3 === 0 || index % 7 === 0) {
        controllers[index]?.abort(abortReasons[index]);
      } else {
        expectedAdmissionOrder.push(index);
      }
    }

    holder.release();

    const actualAdmissionOrder: number[] = [];
    for (let index = 0; index < waiterCount; index += 1) {
      const result = await waiters[index];
      if (result?.kind === "error") {
        expect(result.error).toBe(abortReasons[index]);
        continue;
      }
      if (result?.kind !== "permit") {
        throw new Error(`Missing semaphore result for waiter ${String(index)}.`);
      }
      actualAdmissionOrder.push(result.index);
      result.permit.release();
    }

    expect(actualAdmissionOrder).toEqual(expectedAdmissionOrder);
    expect(semaphore.snapshot()).toEqual({
      limit: 1,
      active: 0,
      waiting: 0,
      available: 1,
    });
  });

  it("does not start globally queued sibling work after the run has failed", async () => {
    const scheduler = new SchedulerConcurrency(1);
    const plan = createMockExecutionIr(
      [
        createMockExecutionOp("failing"),
        createMockExecutionOp("queued-1"),
        createMockExecutionOp("queued-2"),
      ],
      3,
    );
    const failureGate = createDeterministicMockGate();
    const failure = new Error("first admitted op failed");
    const started: number[] = [];
    const run = new PlainDagRun(plan, scheduler.createRun(plan), async ({ op }) => {
      started.push(op);
      if (op === 0) {
        await failureGate.promise;
        throw failure;
      }
    });

    const execution = run.execute();
    const rejection = expect(execution).rejects.toBe(failure);

    await waitFor(
      () => started.length === 1 && scheduler.snapshot().waiting === 2,
      "Expected two globally queued sibling admissions before releasing the failure.",
    );
    failureGate.release();
    await rejection;

    expect(started).toEqual([0]);
    expect(run.snapshot().readiness.ops).toEqual([
      { op: 0, status: "failed" },
      { op: 1, status: "ready" },
      { op: 2, status: "ready" },
    ]);
    expect(run.snapshot().concurrency.run.active).toBe(0);
    expect(run.snapshot().concurrency.run.waiting).toBe(0);
    expect(scheduler.snapshot()).toEqual({
      limit: 1,
      active: 0,
      waiting: 0,
      available: 1,
    });
  });

  it("cancels a saturated run without leaking active or waiting permits", async () => {
    const opCount = 32;
    const scheduler = new SchedulerConcurrency(2);
    const plan = createMockExecutionIr(
      Array.from({ length: opCount }, (_, op) => createMockExecutionOp(`cancel-${String(op)}`)),
      8,
    );
    const started: number[] = [];
    const run = new PlainDagRun(plan, scheduler.createRun(plan), ({ op, signal }) => {
      started.push(op);
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const reason =
              signal.reason instanceof Error
                ? signal.reason
                : new Error(`Stress cancellation: ${String(signal.reason)}`);
            reject(reason);
          },
          { once: true },
        );
      });
    });

    const execution = run.execute();
    await waitFor(
      () => started.length === 2 && scheduler.snapshot().waiting === 6,
      "Expected a saturated run with six global waiters before cancellation.",
    );

    const reason = new Error("stress cancellation");
    const rejection = expect(execution).rejects.toBe(reason);
    expect(run.cancel(reason)).toBe(true);
    await rejection;

    expect(started).toEqual([0, 1]);
    expect(run.snapshot().readiness.ops.every(({ status }) => status === "cancelled")).toBe(true);
    expect(run.snapshot().concurrency.run.active).toBe(0);
    expect(run.snapshot().concurrency.run.waiting).toBe(0);
    expect(scheduler.snapshot()).toEqual({
      limit: 2,
      active: 0,
      waiting: 0,
      available: 2,
    });
  });

  it("shares one hard global ceiling across two concurrently executing runs", async () => {
    const globalLimit = 4;
    const perRunLimit = 4;
    const scheduler = new SchedulerConcurrency(globalLimit);
    const leftPlan = createMockExecutionIr(
      Array.from({ length: 24 }, (_, op) => createMockExecutionOp(`left-${String(op)}`)),
      perRunLimit,
    );
    const rightPlan = createMockExecutionIr(
      Array.from({ length: 24 }, (_, op) => createMockExecutionOp(`right-${String(op)}`)),
      perRunLimit,
    );
    let active = 0;
    let maxActive = 0;
    let invocations = 0;

    const executor = async (): Promise<void> => {
      invocations += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await Promise.resolve();
      } finally {
        active -= 1;
      }
    };
    const left = new PlainDagRun(leftPlan, scheduler.createRun(leftPlan), executor);
    const right = new PlainDagRun(rightPlan, scheduler.createRun(rightPlan), executor);

    const [leftResult, rightResult] = await Promise.all([left.execute(), right.execute()]);

    expect(invocations).toBe(48);
    expect(maxActive).toBe(globalLimit);
    expect(leftResult.readiness.ops.every(({ status }) => status === "completed")).toBe(true);
    expect(rightResult.readiness.ops.every(({ status }) => status === "completed")).toBe(true);
    expect(scheduler.snapshot()).toEqual({
      limit: globalLimit,
      active: 0,
      waiting: 0,
      available: globalLimit,
    });
  });
});
