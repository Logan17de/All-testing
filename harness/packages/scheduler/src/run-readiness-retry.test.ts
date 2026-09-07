import { describe, expect, it } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

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

function ir(ops: readonly ExecutionIrOpV1[]): ExecutionIrV1 {
  return {
    format: "harness.ir/v1",
    graphInputs: [],
    graphOutputs: [],
    ops,
    controlEdges: [],
    entrypoints: [],
    policies: {
      capabilities: { required: [], optional: [], deny: [] },
    },
  };
}

describe("RunReadiness retry transitions", () => {
  it("moves running work through retry-wait back to FIFO ready without touching dependencies", () => {
    const readiness = new RunReadiness(ir([op("retry", []), op("independent", [])]));

    expect(readiness.dequeueReadyOp()).toBe(0);
    readiness.startReservedReadyOp(0);
    expect(readiness.retryRunningOp(0)).toEqual({ op: 0, status: "retry-wait" });
    expect(readiness.getRemainingDependencyCount(0)).toBe(0);
    expect(readiness.getReadyQueue()).toEqual([1]);

    expect(readiness.readyRetryOp(0)).toEqual({ op: 0, status: "ready" });
    expect(readiness.getReadyQueue()).toEqual([1, 0]);
    expect(readiness.getRemainingDependencyCount(0)).toBe(0);
  });

  it("requires the exact running and retry-wait states", () => {
    const readiness = new RunReadiness(ir([op("retry", [])]));

    expect(() => readiness.retryRunningOp(0)).toThrow(
      "Run op 0 cannot enter retry-wait from 'ready'.",
    );
    expect(() => readiness.readyRetryOp(0)).toThrow("Run op 0 cannot retry from 'ready'.");

    expect(readiness.dequeueReadyOp()).toBe(0);
    readiness.startReservedReadyOp(0);
    readiness.retryRunningOp(0);
    readiness.readyRetryOp(0);

    expect(() => readiness.readyRetryOp(0)).toThrow("Run op 0 cannot retry from 'ready'.");
  });
});
