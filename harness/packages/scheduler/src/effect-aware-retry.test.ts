import { describe, expect, it, vi } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import { SchedulerConcurrency } from "./concurrency.js";
import {
  PlainDagRun,
  classifyPlainDagEffectRetryRequirement,
  type PlainDagIdempotencyKeyRetryContext,
} from "./plain-dag-run.js";

type EffectClass = ExecutionIrOpV1["behavior"]["effect"];
type Idempotency = ExecutionIrOpV1["behavior"]["idempotency"];

function op(effect: EffectClass, idempotency: Idempotency, maxAttempts = 3): ExecutionIrOpV1 {
  return {
    sourceNodeId: "effect",
    type: "test.effect",
    version: "1",
    config: {},
    inputs: [],
    dependencies: [],
    behavior: {
      primitiveFamily: effect === "none" ? "pure" : "effect",
      determinism: "deterministic",
      effect,
      idempotency,
      recovery: effect === "external-write" && idempotency === "unknown" ? "manual" : "rerun",
      executionMode: "in-process",
      retry: { maxAttempts, backoffMs: 0 },
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

describe("effect-aware retry policy", () => {
  const classificationCases = [
    ["none", "not-applicable", "safe"],
    ["external-read", "idempotent", "safe"],
    ["external-write", "idempotent", "safe"],
    ["external-write", "idempotency-key", "stable-idempotency-key"],
    ["external-write", "unknown", "forbidden"],
  ] as const;

  it.each(classificationCases)(
    "classifies effect=%s idempotency=%s as %s",
    (effect, idempotency, expected) => {
      expect(classifyPlainDagEffectRetryRequirement({ effect, idempotency })).toBe(expected);
    },
  );

  it("does not repeat an unknown external write even when hand-crafted IR carries a larger budget", async () => {
    const plan = ir(op("external-write", "unknown", 3));
    const scheduler = new SchedulerConcurrency(1);
    const failure = new Error("ambiguous write failure");
    const backoff = vi.fn(() => 0);
    let calls = 0;

    const run = new PlainDagRun(
      plan,
      scheduler.createRun(plan),
      ({ retryBudget }) => {
        calls += 1;
        expect(retryBudget.maxAttempts).toBe(3);
        expect(retryBudget.repeatAuthorized).toBe(false);
        expect(retryBudget.remainingAttempts).toBe(0);
        throw failure;
      },
      { retry: { backoff } },
    );

    await expect(run.execute()).rejects.toBe(failure);

    expect(calls).toBe(1);
    expect(backoff).not.toHaveBeenCalled();
    expect(run.snapshot().attempts).toEqual([1]);
    expect(run.snapshot().attemptBudgetUsed).toEqual([1]);
    expect(run.snapshot().readiness.ops).toEqual([{ op: 0, status: "failed" }]);
  });

  it("allows an idempotent external write to use the existing shared retry budget", async () => {
    const plan = ir(op("external-write", "idempotent", 2));
    const scheduler = new SchedulerConcurrency(1);
    const attempts: number[] = [];

    const result = await new PlainDagRun(
      plan,
      scheduler.createRun(plan),
      ({ attempt, retryBudget }) => {
        attempts.push(attempt);
        expect(retryBudget.repeatAuthorized).toBe(true);
        if (attempt === 1) {
          expect(retryBudget.remainingAttempts).toBe(1);
          throw new Error("transient write failure");
        }
        expect(retryBudget.remainingAttempts).toBe(0);
      },
    ).execute();

    expect(attempts).toEqual([1, 2]);
    expect(result.attempts).toEqual([2]);
    expect(result.attemptBudgetUsed).toEqual([2]);
  });

  it("does not infer key-backed retry authority from idempotency-key metadata alone", async () => {
    const plan = ir(op("external-write", "idempotency-key", 3));
    const scheduler = new SchedulerConcurrency(1);
    const failure = new Error("key-backed write failed");
    let calls = 0;

    const run = new PlainDagRun(plan, scheduler.createRun(plan), ({ retryBudget }) => {
      calls += 1;
      expect(retryBudget.repeatAuthorized).toBe(false);
      expect(retryBudget.remainingAttempts).toBe(0);
      throw failure;
    });

    await expect(run.execute()).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(run.snapshot().attempts).toEqual([1]);
  });

  it("retries a key-backed write only after the runtime proves a stable key is bound", async () => {
    const plan = ir(op("external-write", "idempotency-key", 2));
    const scheduler = new SchedulerConcurrency(1);
    const contexts: PlainDagIdempotencyKeyRetryContext[] = [];
    const attempts: number[] = [];

    const result = await new PlainDagRun(
      plan,
      scheduler.createRun(plan),
      ({ attempt, retryBudget }) => {
        attempts.push(attempt);
        expect(retryBudget.repeatAuthorized).toBe(true);
        if (attempt === 1) {
          throw new Error("transient key-backed write failure");
        }
      },
      {
        effectRetry: {
          hasBoundIdempotencyKey: (context) => {
            contexts.push(context);
            expect(Object.isFrozen(context)).toBe(true);
            return true;
          },
        },
      },
    ).execute();

    expect(attempts).toEqual([1, 2]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.op).toBe(0);
    expect(result.attempts).toEqual([2]);
  });

  it("blocks adapter/internal retries when effect policy forbids repeating the op", async () => {
    const plan = ir(op("external-write", "unknown", 3));
    const scheduler = new SchedulerConcurrency(1);

    const run = new PlainDagRun(plan, scheduler.createRun(plan), ({ retryBudget }) => {
      expect(retryBudget.repeatAuthorized).toBe(false);
      expect(retryBudget.remainingAttempts).toBe(0);
      retryBudget.reportInternalRetries();
    });

    await expect(run.execute()).rejects.toThrow(
      "Run op 0 effect-aware retry policy does not authorize repeated execution.",
    );
    expect(run.snapshot().attempts).toEqual([1]);
    expect(run.snapshot().attemptBudgetUsed).toEqual([1]);
  });
});
