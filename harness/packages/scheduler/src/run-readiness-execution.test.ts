import { describe, expect, it } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import { RunReadiness } from "./run-readiness.js";

function op(): ExecutionIrOpV1 {
  return {
    sourceNodeId: "root",
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
      requiredCapabilities: [],
    },
  };
}

function ir(): ExecutionIrV1 {
  return {
    format: "harness.ir/v1",
    graphInputs: [],
    graphOutputs: [],
    ops: [op()],
    controlEdges: [],
    entrypoints: [],
    policies: { capabilities: { required: [], optional: [], deny: [] } },
  };
}

describe("RunReadiness 3.4 execution handoff", () => {
  it("requires a dequeued reservation before ready can become running", () => {
    const readiness = new RunReadiness(ir());

    expect(() => readiness.startReservedReadyOp(0)).toThrow(
      "Run op 0 is not a dequeued ready reservation.",
    );

    expect(readiness.dequeueReadyOp()).toBe(0);
    expect(readiness.isReadyOpReserved(0)).toBe(true);
    expect(readiness.startReservedReadyOp(0)).toEqual({ op: 0, status: "running" });
    expect(readiness.isReadyOpReserved(0)).toBe(false);
    expect(readiness.completeRunningOp(0)).toEqual({ op: 0, status: "completed" });
  });

  it("can mark a running reservation failed but cannot finish it twice", () => {
    const readiness = new RunReadiness(ir());

    expect(readiness.dequeueReadyOp()).toBe(0);
    readiness.startReservedReadyOp(0);
    expect(readiness.failRunningOp(0)).toEqual({ op: 0, status: "failed" });
    expect(() => readiness.completeRunningOp(0)).toThrow(
      "Run op 0 cannot enter completed from 'failed'.",
    );
  });
});
