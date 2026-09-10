import { describe, expect, it, vi } from "vitest";

import { SchedulerConcurrency } from "./concurrency.js";
import {
  PlainDagRun,
  type PlainDagRestoreState,
  type PlainDagRunOptions,
} from "./plain-dag-run.js";
import { createMockExecutionIr, createMockExecutionOp } from "./testing.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function gatePlan() {
  return createMockExecutionIr([
    createMockExecutionOp("human", [], {
      behavior: { primitiveFamily: "interrupt", effect: "none" },
    }),
    createMockExecutionOp("effect", [0]),
  ]);
}

describe("durable scheduler lifecycle", () => {
  it("does not invoke an executor cancelled during asynchronous durable admission", async () => {
    const ir = createMockExecutionIr([createMockExecutionOp("cancelled-admission", [])]);
    const scheduler = new SchedulerConcurrency(1);
    const admitted = deferred();
    const release = deferred();
    const executor = vi.fn();
    const run = new PlainDagRun(ir, scheduler.createRun(ir), executor, {
      durability: {
        beforeAttempt: async () => {
          admitted.resolve();
          await release.promise;
        },
      },
    });
    const execution = run.execute();
    await admitted.promise;
    const reason = new Error("user cancellation");
    run.cancel(reason);
    release.resolve();
    await expect(execution).rejects.toBe(reason);
    expect(executor).not.toHaveBeenCalled();
    expect(run.snapshot().readiness.ops[0]?.status).toBe("cancelled");
  });

  it.each([false, true])(
    "preserves cancellation during an in-flight approval commit (rejects=%s)",
    async (rejectCommit) => {
      const ir = gatePlan();
      const scheduler = new SchedulerConcurrency(1);
      const entered = deferred();
      const release = deferred();
      const executor = vi.fn();
      const run = new PlainDagRun(ir, scheduler.createRun(ir), executor, {
        durability: {
          suspend: async () => {
            entered.resolve();
            await release.promise;
            if (rejectCommit) throw new Error("late checkpoint failure");
          },
        },
      });
      const work = run.execute();
      await entered.promise;
      const reason = new Error("user cancelled while committing approval");
      run.cancel(reason);
      release.resolve();
      await expect(work).rejects.toBe(reason);
      expect(run.snapshot().readiness.ops.map((op) => op.status)).toEqual([
        "cancelled",
        "cancelled",
      ]);
      expect(run.snapshot().attempts).toEqual([0, 0]);
      expect(executor).not.toHaveBeenCalled();
    },
  );

  it("requires a host handler instead of invoking interrupt plugin code", () => {
    const ir = gatePlan();
    const scheduler = new SchedulerConcurrency(1);
    expect(() => new PlainDagRun(ir, scheduler.createRun(ir), vi.fn())).toThrow(
      "suspension handler",
    );
  });

  it("persists suspension before publishing waiting, without consuming an attempt", async () => {
    const ir = gatePlan();
    const scheduler = new SchedulerConcurrency(1);
    const entered = deferred();
    const commit = deferred();
    const executor = vi.fn();
    const run = new PlainDagRun(ir, scheduler.createRun(ir), executor, {
      durability: {
        suspend: async () => {
          entered.resolve();
          await commit.promise;
        },
      },
    });
    const work = run.execute();
    await entered.promise;
    expect(run.snapshot().readiness.ops[0]?.status).toBe("ready");
    commit.resolve();
    const snapshot = await work;
    expect(snapshot.suspended).toBe(true);
    expect(snapshot.attempts).toEqual([0, 0]);
    expect(snapshot.readiness.ops.map((op) => op.status)).toEqual(["waiting", "pending"]);
    expect(snapshot.concurrency.run.active).toBe(0);
    expect(executor).not.toHaveBeenCalled();
  });

  it("keeps failed suspension terminal with no dependency release", async () => {
    const ir = gatePlan();
    const scheduler = new SchedulerConcurrency(1);
    const executor = vi.fn();
    const failure = new Error("commit failure");
    const run = new PlainDagRun(ir, scheduler.createRun(ir), executor, {
      durability: {
        suspend: () => {
          throw failure;
        },
      },
    });
    await expect(run.execute()).rejects.toBe(failure);
    expect(run.snapshot().settled).toBe(true);
    expect(run.snapshot().readiness.remainingDependencies).toEqual([0, 1]);
    expect(executor).not.toHaveBeenCalled();
  });

  it("restores committed work and preserves indexes without invoking completed ops", async () => {
    const ir = gatePlan();
    const scheduler = new SchedulerConcurrency(1);
    const executor = vi.fn();
    const restored: PlainDagRestoreState = {
      readiness: {
        ops: [
          { op: 0, status: "completed" },
          { op: 1, status: "ready" },
        ],
        remainingDependencies: [0, 0],
        readyQueue: [1],
      },
      attempts: [1, 0],
      attemptBudgetUsed: [1, 0],
      retryDelaysMs: [null, null],
    };
    const run = new PlainDagRun(ir, scheduler.createRun(ir), executor, {
      restored,
      durability: { suspend: vi.fn() },
    });
    expect((await run.execute()).attempts).toEqual([1, 1]);
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]?.[0]).toMatchObject({ op: 1, attempt: 1 });
  });

  it("rejects a restored frontier that releases an unfinished dependency", () => {
    const ir = gatePlan();
    const scheduler = new SchedulerConcurrency(1);
    const restored: PlainDagRestoreState = {
      readiness: {
        ops: [
          { op: 0, status: "waiting" },
          { op: 1, status: "ready" },
        ],
        remainingDependencies: [0, 0],
        readyQueue: [1],
      },
      attempts: [0, 0],
      attemptBudgetUsed: [0, 0],
      retryDelaysMs: [null, null],
    };
    expect(
      () =>
        new PlainDagRun(ir, scheduler.createRun(ir), vi.fn(), {
          restored,
          durability: { suspend: vi.fn() },
        }),
    ).toThrow("dependency state");
  });

  it("does not retry an executor when the durable start barrier fails", async () => {
    const ir = createMockExecutionIr([
      createMockExecutionOp("op", [], { behavior: { retry: { maxAttempts: 3 } } }),
    ]);
    const scheduler = new SchedulerConcurrency(1);
    const executor = vi.fn();
    const failed = vi.fn();
    const run = new PlainDagRun(ir, scheduler.createRun(ir), executor, {
      durability: {
        beforeAttempt: () => {
          throw new Error("disk failure");
        },
        attemptFailed: failed,
      },
    });
    await expect(run.execute()).rejects.toThrow("disk failure");
    expect(executor).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it("rechecks revocation after async admission without retrying the permission denial", async () => {
    const ir = createMockExecutionIr([
      createMockExecutionOp("privileged", [], {
        behavior: { requiredCapabilities: ["fs:write"], retry: { maxAttempts: 3 } },
      }),
    ]);
    const scheduler = new SchedulerConcurrency(1);
    const executor = vi.fn();
    const failed = vi.fn();
    let granted = true;
    const options: PlainDagRunOptions = {
      capabilityAuthority: { evaluate: () => ({ decision: granted ? "allow" : "deny" }) },
      durability: {
        beforeAttempt: async () => {
          await Promise.resolve();
          granted = false;
        },
        attemptFailed: failed,
      },
    };
    const run = new PlainDagRun(ir, scheduler.createRun(ir), executor, options);
    await expect(run.execute()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(executor).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0]?.[0]).toMatchObject({ retryDelayMs: null });
  });

  it("pauses a retry timer without cancelling the run or resetting the budget", async () => {
    const ir = createMockExecutionIr([
      createMockExecutionOp("retry", [], {
        behavior: { retry: { maxAttempts: 2, backoffMs: 100000 } },
      }),
    ]);
    const scheduler = new SchedulerConcurrency(1);
    const failed = deferred();
    const executor = vi.fn(() => {
      throw new Error("transient");
    });
    const run = new PlainDagRun(ir, scheduler.createRun(ir), executor, {
      durability: {
        attemptFailed: () => {
          failed.resolve();
        },
      },
    });
    const work = run.execute();
    await failed.promise;
    run.pause();
    const snapshot = await work;
    expect(snapshot).toMatchObject({
      suspended: true,
      cancelled: false,
      attempts: [1],
      attemptBudgetUsed: [1],
    });
    expect(snapshot.readiness.ops[0]?.status).toBe("retry-wait");
    expect(executor).toHaveBeenCalledOnce();
  });
});
