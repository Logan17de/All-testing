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

describe("RunReadiness", () => {
  it("initializes zero-dependency ops as ready in ascending op order", () => {
    const readiness = new RunReadiness(
      ir([op("a", []), op("b", [0]), op("c", []), op("d", [0, 2])]),
    );

    expect(readiness.snapshot()).toEqual({
      ops: [
        { op: 0, status: "ready" },
        { op: 1, status: "pending" },
        { op: 2, status: "ready" },
        { op: 3, status: "pending" },
      ],
      remainingDependencies: [0, 1, 0, 2],
      readyQueue: [0, 2],
    });
    expect(readiness.readyCount).toBe(2);
    expect(readiness.peekReadyOp()).toBe(0);
  });

  it("uses deterministic FIFO dequeue without prematurely changing ready status", () => {
    const readiness = new RunReadiness(ir([op("a", []), op("b", []), op("c", [])]));

    expect(readiness.dequeueReadyOp()).toBe(0);
    expect(readiness.getOpState(0)).toEqual({ op: 0, status: "ready" });
    expect(readiness.peekReadyOp()).toBe(1);
    expect(readiness.getReadyQueue()).toEqual([1, 2]);
    expect(readiness.dequeueReadyOp()).toBe(1);
    expect(readiness.dequeueReadyOp()).toBe(2);
    expect(readiness.dequeueReadyOp()).toBeUndefined();
    expect(readiness.readyCount).toBe(0);
  });

  it("decrements exact predecessor pairs and promotes targets only at zero", () => {
    const readiness = new RunReadiness(
      ir([op("root", []), op("left", [0]), op("right", [0]), op("join", [1, 2]), op("other", [])]),
    );

    expect(readiness.getDependents(0)).toEqual([1, 2]);
    expect(readiness.releaseDependency(0, 1)).toBe(true);
    expect(readiness.getRemainingDependencyCount(1)).toBe(0);
    expect(readiness.getRemainingDependencyCount(2)).toBe(1);
    expect(readiness.getOpState(1).status).toBe("ready");
    expect(readiness.getOpState(2).status).toBe("pending");

    expect(readiness.releaseDependency(0, 2)).toBe(true);
    expect(readiness.getRemainingDependencyCount(2)).toBe(0);
    expect(readiness.getOpState(2).status).toBe("ready");

    expect(readiness.releaseDependency(1, 3)).toBe(false);
    expect(readiness.getRemainingDependencyCount(3)).toBe(1);
    expect(readiness.getOpState(3).status).toBe("pending");

    expect(readiness.releaseDependency(2, 3)).toBe(true);
    expect(readiness.getRemainingDependencyCount(3)).toBe(0);
    expect(readiness.getOpState(3).status).toBe("ready");
  });

  it("allows one source to release selected targets without waking every dependent", () => {
    const readiness = new RunReadiness(
      ir([op("router", []), op("branch-a", [0]), op("branch-b", [0]), op("other", [])]),
    );

    expect(readiness.getDependents(0)).toEqual([1, 2]);
    expect(readiness.releaseDependency(0, 2)).toBe(true);
    expect(readiness.getOpState(2).status).toBe("ready");
    expect(readiness.getOpState(1).status).toBe("pending");
    expect(readiness.getRemainingDependencyCount(1)).toBe(1);
    expect(readiness.isDependencyReleased(0, 2)).toBe(true);
    expect(readiness.isDependencyReleased(0, 1)).toBe(false);
  });

  it("preserves FIFO order when newly-ready ops are appended behind existing work", () => {
    const readiness = new RunReadiness(
      ir([op("root", []), op("left", [0]), op("right", [0]), op("independent", [])]),
    );

    expect(readiness.getReadyQueue()).toEqual([0, 3]);
    expect(readiness.releaseDependency(0, 1)).toBe(true);
    expect(readiness.releaseDependency(0, 2)).toBe(true);
    expect(readiness.getReadyQueue()).toEqual([0, 3, 1, 2]);
  });

  it("rejects duplicate pair release before a dependency counter can underflow", () => {
    const readiness = new RunReadiness(ir([op("root", []), op("child", [0])]));

    expect(readiness.releaseDependency(0, 1)).toBe(true);
    expect(() => readiness.releaseDependency(0, 1)).toThrow(
      "Run dependency 0 -> 1 was already released.",
    );
    expect(readiness.getRemainingDependencyCount(1)).toBe(0);
  });

  it("rejects release of a source-target pair absent from Execution IR", () => {
    const readiness = new RunReadiness(ir([op("root", []), op("child", [0]), op("other", [])]));

    expect(() => readiness.releaseDependency(2, 1)).toThrow(
      "Run op 1 does not depend on source op 2.",
    );
    expect(readiness.getRemainingDependencyCount(1)).toBe(1);
  });

  it("returns frozen reverse-dependent and snapshot views without exposing storage", () => {
    const readiness = new RunReadiness(ir([op("a", []), op("b", [0])]));
    const dependents = readiness.getDependents(0);
    const queue = readiness.getReadyQueue();
    const snapshot = readiness.snapshot();

    expect(Object.isFrozen(dependents)).toBe(true);
    expect(Object.isFrozen(queue)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.ops)).toBe(true);
    expect(Object.isFrozen(snapshot.remainingDependencies)).toBe(true);
    expect(Object.isFrozen(snapshot.readyQueue)).toBe(true);
    expect(snapshot.readyQueue).not.toBe(readiness.getReadyQueue());
  });

  it.each([-1, 2, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid op index %s",
    (index) => {
      const readiness = new RunReadiness(ir([op("a", []), op("b", [0])]));

      expect(() => readiness.getOpState(index)).toThrow(RangeError);
      expect(() => readiness.getRemainingDependencyCount(index)).toThrow(RangeError);
      expect(() => readiness.getDependents(index)).toThrow(RangeError);
      expect(() => readiness.releaseDependency(index, 1)).toThrow(RangeError);
      expect(() => readiness.releaseDependency(0, index)).toThrow(RangeError);
    },
  );

  it("supports an empty IR without inventing runnable work", () => {
    const readiness = new RunReadiness(ir([]));

    expect(readiness.opCount).toBe(0);
    expect(readiness.readyCount).toBe(0);
    expect(readiness.hasReadyOps()).toBe(false);
    expect(readiness.peekReadyOp()).toBeUndefined();
    expect(readiness.dequeueReadyOp()).toBeUndefined();
    expect(readiness.snapshot()).toEqual({
      ops: [],
      remainingDependencies: [],
      readyQueue: [],
    });
  });
});
