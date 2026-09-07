import { describe, expect, it } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import { SchedulerConcurrency } from "./concurrency.js";
import {
  PlainDagRun,
  type PlainDagRetryBackoffContext,
  type PlainDagRetryBudget,
} from "./plain-dag-run.js";

function op(maxAttempts?: number): ExecutionIrOpV1 {
  return {
    sourceNodeId: "work",
    type: "test.node",
    version: "1",
    config: {},
    inputs: [],
    dependencies: [],
    behavior: {
      primitiveFamily: "pure",
      determinism: "deterministic",
      effect: "none",
      idempotency: "not-applicable",
      recovery: "rerun",
      executionMode: "in-process",
      ...(maxAttempts === undefined ? {} : { retry: { maxAttempts, backoffMs: 0 } }),
      requiredCapabilities: [],
    },
  };
}

function ir(operation: ExecutionIrOpV1): ExecutionIrV1 {
  return {
    format: "harness.ir/v1",
    graphInputs: [],
    graphOutputs: [],
    ops: [operation],
    controlEdges: [],
    entrypoints: [],
    policies: {
      maxParallelism: 1,
      capabilities: { required: [], optional: [], deny: [] },
    },
  };
}

describe("adapter/internal retry accounting", () => {
  it("shares maxAttempts between reported internal retries and outer scheduler attempts", async () => {
    const plan = ir(op(3));
    const scheduler = new SchedulerConcurrency(1);
    const firstFailure = new Error("first outer failure");
    const finalFailure = new Error("final outer failure");
    const observations: Array<{
      readonly attempt: number;
      readonly used: number;
      readonly remaining: number;
    }> = [];

    const run = new PlainDagRun(plan, scheduler.createRun(plan), ({ attempt, retryBudget }) => {
      observations.push({
        attempt,
        used: retryBudget.usedAttempts,
        remaining: retryBudget.remainingAttempts,
      });

      if (attempt === 1) {
        expect(Object.isFrozen(retryBudget)).toBe(true);
        expect(retryBudget.reportInternalRetries()).toBe(2);
        expect(retryBudget.usedAttempts).toBe(2);
        expect(retryBudget.remainingAttempts).toBe(1);
        throw firstFailure;
      }

      throw finalFailure;
    });

    await expect(run.execute()).rejects.toBe(finalFailure);

    expect(observations).toEqual([
      { attempt: 1, used: 1, remaining: 2 },
      { attempt: 2, used: 3, remaining: 0 },
    ]);
    expect(run.snapshot().attempts).toEqual([2]);
    expect(run.snapshot().attemptBudgetUsed).toEqual([3]);
    expect(Object.isFrozen(run.snapshot().attemptBudgetUsed)).toBe(true);
  });

  it("does not add an outer retry after internal retries consume the whole budget", async () => {
    const plan = ir(op(3));
    const scheduler = new SchedulerConcurrency(1);
    const failure = new Error("adapter exhausted shared budget");
    let outerCalls = 0;

    const run = new PlainDagRun(plan, scheduler.createRun(plan), ({ retryBudget }) => {
      outerCalls += 1;
      retryBudget.reportInternalRetries(2);
      throw failure;
    });

    await expect(run.execute()).rejects.toBe(failure);

    expect(outerCalls).toBe(1);
    expect(run.snapshot().attempts).toEqual([1]);
    expect(run.snapshot().attemptBudgetUsed).toEqual([3]);
    expect(run.snapshot().readiness.ops).toEqual([{ op: 0, status: "failed" }]);
  });

  it("records internal retries on successful execution without inventing outer attempts", async () => {
    const plan = ir(op(4));
    const scheduler = new SchedulerConcurrency(1);

    const result = await new PlainDagRun(
      plan,
      scheduler.createRun(plan),
      ({ attempt, retryBudget }) => {
        expect(attempt).toBe(1);
        expect(retryBudget.maxAttempts).toBe(4);
        expect(retryBudget.reportInternalRetries(2)).toBe(3);
        expect(retryBudget.remainingAttempts).toBe(1);
      },
    ).execute();

    expect(result.attempts).toEqual([1]);
    expect(result.attemptBudgetUsed).toEqual([3]);
    expect(result.readiness.ops).toEqual([{ op: 0, status: "completed" }]);
  });

  it("exposes zero remaining retry budget when maxAttempts is omitted", async () => {
    const plan = ir(op());
    const scheduler = new SchedulerConcurrency(1);

    const result = await new PlainDagRun(plan, scheduler.createRun(plan), ({ retryBudget }) => {
      expect(retryBudget.maxAttempts).toBe(1);
      expect(retryBudget.usedAttempts).toBe(1);
      expect(retryBudget.remainingAttempts).toBe(0);
      expect(retryBudget.reportInternalRetries(0)).toBe(1);
    }).execute();

    expect(result.attemptBudgetUsed).toEqual([1]);
  });

  it("passes shared budget usage into retry backoff hooks", async () => {
    const plan = ir(op(4));
    const scheduler = new SchedulerConcurrency(1);
    const contexts: PlainDagRetryBackoffContext[] = [];
    let outerCalls = 0;

    const result = await new PlainDagRun(
      plan,
      scheduler.createRun(plan),
      ({ attempt, retryBudget }) => {
        outerCalls += 1;
        if (attempt === 1) {
          retryBudget.reportInternalRetries();
          throw new Error("transient");
        }
      },
      {
        retry: {
          backoff: (context) => {
            contexts.push(context);
            return 0;
          },
        },
      },
    ).execute();

    expect(outerCalls).toBe(2);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 4,
      attemptBudgetUsed: 2,
      remainingAttempts: 2,
    });
    expect(Object.isFrozen(contexts[0])).toBe(true);
    expect(result.attempts).toEqual([2]);
    expect(result.attemptBudgetUsed).toEqual([3]);
  });

  it("rejects an internal retry report that would exceed the shared budget", async () => {
    const plan = ir(op(2));
    const scheduler = new SchedulerConcurrency(1);
    let outerCalls = 0;

    const run = new PlainDagRun(plan, scheduler.createRun(plan), ({ retryBudget }) => {
      outerCalls += 1;
      retryBudget.reportInternalRetries(2);
    });

    await expect(run.execute()).rejects.toThrow(
      "Run op 0 reported 2 internal retries with only 1 attempt remaining in its retry budget.",
    );

    expect(outerCalls).toBe(1);
    expect(run.snapshot().attempts).toEqual([1]);
    expect(run.snapshot().attemptBudgetUsed).toEqual([1]);
    expect(run.snapshot().readiness.ops).toEqual([{ op: 0, status: "failed" }]);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid reported internal retry count %s without another outer attempt",
    async (count) => {
      const plan = ir(op(2));
      const scheduler = new SchedulerConcurrency(1);
      let outerCalls = 0;

      const run = new PlainDagRun(plan, scheduler.createRun(plan), ({ retryBudget }) => {
        outerCalls += 1;
        retryBudget.reportInternalRetries(count);
      });

      await expect(run.execute()).rejects.toThrow(
        "Run op 0 internal retry count must be a non-negative safe integer.",
      );
      expect(outerCalls).toBe(1);
      expect(run.snapshot().attemptBudgetUsed).toEqual([1]);
    },
  );

  it("closes the per-attempt budget handle after execution settles", async () => {
    const plan = ir(op(2));
    const scheduler = new SchedulerConcurrency(1);
    let captured: PlainDagRetryBudget | undefined;

    await new PlainDagRun(plan, scheduler.createRun(plan), ({ retryBudget }) => {
      captured = retryBudget;
    }).execute();

    expect(captured).toBeDefined();
    expect(() => captured?.reportInternalRetries()).toThrow(
      "Run op 0 retry budget is closed for this scheduler attempt.",
    );
  });
});
