import { describe, expect, it } from "vitest";

import { AsyncSemaphore, SchedulerConcurrency } from "./concurrency.js";

function policies(maxParallelism?: number) {
  return {
    policies: {
      ...(maxParallelism === undefined ? {} : { maxParallelism }),
      capabilities: { required: [], optional: [], deny: [] },
    },
  };
}

describe("AsyncSemaphore", () => {
  it("admits up to the limit and resumes queued waiters in FIFO order", async () => {
    const semaphore = new AsyncSemaphore(2);
    const first = await semaphore.acquire();
    const second = await semaphore.acquire();
    const order: number[] = [];

    const thirdPromise = semaphore.acquire().then((permit) => {
      order.push(3);
      return permit;
    });
    const fourthPromise = semaphore.acquire().then((permit) => {
      order.push(4);
      return permit;
    });

    expect(semaphore.snapshot()).toEqual({ limit: 2, active: 2, waiting: 2, available: 0 });

    first.release();
    const third = await thirdPromise;
    expect(order).toEqual([3]);
    expect(semaphore.snapshot()).toEqual({ limit: 2, active: 2, waiting: 1, available: 0 });

    second.release();
    const fourth = await fourthPromise;
    expect(order).toEqual([3, 4]);

    third.release();
    fourth.release();
    expect(semaphore.snapshot()).toEqual({ limit: 2, active: 0, waiting: 0, available: 2 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid limit %s",
    (limit) => {
      expect(() => new AsyncSemaphore(limit)).toThrow(RangeError);
    },
  );

  it("rejects duplicate permit release before counts can underflow", async () => {
    const semaphore = new AsyncSemaphore(1);
    const permit = await semaphore.acquire();

    permit.release();
    expect(() => permit.release()).toThrow("Concurrency permit was already released.");
    expect(semaphore.activeCount).toBe(0);
  });

  it("returns runtime-frozen snapshots and permits", async () => {
    const semaphore = new AsyncSemaphore(1);
    const permit = await semaphore.acquire();
    const snapshot = semaphore.snapshot();

    expect(Object.isFrozen(permit)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    permit.release();
  });
});

describe("SchedulerConcurrency", () => {
  it("enforces one hard global ceiling across separate runs", async () => {
    const scheduler = new SchedulerConcurrency(2);
    const runA = scheduler.createRun(policies(2));
    const runB = scheduler.createRun(policies(2));

    const a1 = await runA.acquire();
    const a2 = await runA.acquire();
    let bStarted = false;
    const b1Promise = runB.acquire().then((permit) => {
      bStarted = true;
      return permit;
    });

    await Promise.resolve();
    expect(bStarted).toBe(false);
    expect(scheduler.snapshot()).toEqual({ limit: 2, active: 2, waiting: 1, available: 0 });

    a1.release();
    const b1 = await b1Promise;
    expect(bStarted).toBe(true);
    expect(scheduler.snapshot().active).toBe(2);

    a2.release();
    b1.release();
    expect(scheduler.snapshot().active).toBe(0);
  });

  it("does not let a run blocked by its local ceiling consume global capacity", async () => {
    const scheduler = new SchedulerConcurrency(2);
    const runA = scheduler.createRun(policies(1));
    const runB = scheduler.createRun(policies(2));

    const a1 = await runA.acquire();
    let a2Started = false;
    const a2Promise = runA.acquire().then((permit) => {
      a2Started = true;
      return permit;
    });

    await Promise.resolve();
    expect(a2Started).toBe(false);
    expect(runA.snapshot().run).toEqual({ limit: 1, active: 1, waiting: 1, available: 0 });
    expect(scheduler.snapshot()).toEqual({ limit: 2, active: 1, waiting: 0, available: 1 });

    const b1 = await runB.acquire();
    expect(scheduler.snapshot().active).toBe(2);

    a1.release();
    const a2 = await a2Promise;
    expect(a2Started).toBe(true);

    b1.release();
    a2.release();
  });

  it("inherits the global limit when graph maxParallelism is omitted", () => {
    const scheduler = new SchedulerConcurrency(4);
    const run = scheduler.createRun(policies());

    expect(run.limit).toBe(4);
  });

  it("keeps per-run limits independent even when they share the same global gate", async () => {
    const scheduler = new SchedulerConcurrency(4);
    const runA = scheduler.createRun(policies(1));
    const runB = scheduler.createRun(policies(3));

    const a = await runA.acquire();
    const b1 = await runB.acquire();
    const b2 = await runB.acquire();
    const b3 = await runB.acquire();

    expect(runA.activeCount).toBe(1);
    expect(runB.activeCount).toBe(3);
    expect(scheduler.snapshot().active).toBe(4);

    a.release();
    b1.release();
    b2.release();
    b3.release();
  });

  it("rejects duplicate combined permit release without over-releasing either gate", async () => {
    const scheduler = new SchedulerConcurrency(1);
    const run = scheduler.createRun(policies(1));
    const permit = await run.acquire();

    permit.release();
    expect(() => permit.release()).toThrow("Run concurrency permit was already released.");
    expect(run.snapshot()).toEqual({
      global: { limit: 1, active: 0, waiting: 0, available: 1 },
      run: { limit: 1, active: 0, waiting: 0, available: 1 },
    });
  });
});
