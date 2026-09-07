import { describe, expect, it } from "vitest";

import type {
  ExecutionIrJoinControlV1,
  ExecutionIrOpV1,
  ExecutionIrV1,
} from "@zet-harness/graph";

import { RunControlEdges } from "./control-edge-state.js";
import { RunJoinActivation } from "./join-activation.js";
import { RunReadiness } from "./run-readiness.js";

function executableOp(sourceNodeId: string, dependencies: readonly number[]): ExecutionIrOpV1 {
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

function joinOp(
  sourceNodeId: string,
  dependencies: readonly number[],
  control: ExecutionIrJoinControlV1,
): ExecutionIrOpV1 {
  return {
    sourceNodeId,
    type: "test.join",
    version: "1",
    config: {},
    inputs: [],
    dependencies,
    behavior: {
      primitiveFamily: "control",
      determinism: "deterministic",
      effect: "none",
      idempotency: "not-applicable",
      recovery: "not-applicable",
      executionMode: "none",
      requiredCapabilities: [],
    },
    control,
  };
}

function ir(
  ops: readonly ExecutionIrOpV1[],
  controlEdges: ExecutionIrV1["controlEdges"],
): ExecutionIrV1 {
  return {
    format: "harness.ir/v1",
    graphInputs: [],
    graphOutputs: [],
    ops,
    controlEdges,
    entrypoints: [],
    policies: { capabilities: { required: [], optional: [], deny: [] } },
  };
}

function runtime(plan: ExecutionIrV1) {
  const readiness = new RunReadiness(plan);
  const controlEdges = new RunControlEdges(plan);
  const joins = new RunJoinActivation(plan, readiness, controlEdges);
  return { readiness, controlEdges, joins };
}

describe("threshold join activation", () => {
  it("releases an any join after one completed lane without cancelling another active lane", () => {
    const plan = ir(
      [
        executableOp("left", []),
        executableOp("right", []),
        joinOp("join", [0, 1], {
          kind: "join",
          inputs: ["left", "right"],
          output: "out",
          mode: "any",
        }),
        executableOp("finish", [2]),
      ],
      [
        { from: { op: 0 }, to: { op: 2, port: "left" } },
        { from: { op: 1 }, to: { op: 2, port: "right" } },
        { from: { op: 2, port: "out" }, to: { op: 3 } },
      ],
    );
    const { readiness, controlEdges, joins } = runtime(plan);

    expect(readiness.dequeueReadyOp()).toBe(0);
    readiness.startReservedReadyOp(0);
    controlEdges.activate(0);
    readiness.completeRunningOp(0);
    controlEdges.complete(0);

    expect(readiness.dequeueReadyOp()).toBe(1);
    readiness.startReservedReadyOp(1);
    controlEdges.activate(1);

    expect(joins.reconcileJoin(2)).toEqual({
      joinOp: 2,
      ready: true,
      newlyReady: true,
      unresolvedInputEdges: [],
      activeInputEdges: [1],
      completedInputEdges: [0],
      skippedInputEdges: [],
      propagatedSkippedOps: [],
    });
    expect(readiness.getRemainingDependencyCount(2)).toBe(0);

    expect(readiness.dequeueReadyOp()).toBe(2);
    expect(joins.completeReservedJoin(2)).toEqual({
      joinOp: 2,
      activatedTargets: [3],
      newlyReadyTargets: [3],
    });
    expect(readiness.getOpState(1).status).toBe("running");
    expect(controlEdges.getState(1).status).toBe("active");
    expect(readiness.getOpState(2).status).toBe("completed");
    expect(readiness.getOpState(3).status).toBe("ready");

    readiness.completeRunningOp(1);
    controlEdges.complete(1);
    expect(controlEdges.getState(1).status).toBe("completed");
  });

  it("counts distinct input lanes rather than duplicate completed edges toward quorum", () => {
    const plan = ir(
      [
        executableOp("a", []),
        executableOp("b", []),
        executableOp("c", []),
        joinOp("join", [0, 1, 2], {
          kind: "join",
          inputs: ["a", "b", "c"],
          output: "out",
          mode: "quorum",
          quorum: 2,
        }),
      ],
      [
        { from: { op: 0 }, to: { op: 3, port: "a" } },
        { from: { op: 0 }, to: { op: 3, port: "a" } },
        { from: { op: 1 }, to: { op: 3, port: "b" } },
        { from: { op: 2 }, to: { op: 3, port: "c" } },
      ],
    );
    const { readiness, controlEdges, joins } = runtime(plan);

    controlEdges.activate(0);
    controlEdges.complete(0);
    controlEdges.activate(1);
    controlEdges.complete(1);

    const duplicateLane = joins.reconcileJoin(3);
    expect(duplicateLane.ready).toBe(false);
    expect(duplicateLane.completedInputEdges).toEqual([0, 1]);
    expect(readiness.getRemainingDependencyCount(3)).toBe(3);

    controlEdges.activate(2);
    controlEdges.complete(2);
    const quorum = joins.reconcileJoin(3);
    expect(quorum.ready).toBe(true);
    expect(quorum.newlyReady).toBe(true);
    expect(quorum.unresolvedInputEdges).toEqual([3]);
    expect(readiness.getRemainingDependencyCount(3)).toBe(0);
  });

  it("skips a quorum join and propagates downstream once the threshold is impossible", () => {
    const plan = ir(
      [
        executableOp("a", []),
        executableOp("b", []),
        executableOp("c", []),
        joinOp("join", [0, 1, 2], {
          kind: "join",
          inputs: ["a", "b", "c"],
          output: "out",
          mode: "quorum",
          quorum: 2,
        }),
        executableOp("after", [3]),
        executableOp("tail", [4]),
      ],
      [
        { from: { op: 0 }, to: { op: 3, port: "a" } },
        { from: { op: 1 }, to: { op: 3, port: "b" } },
        { from: { op: 2 }, to: { op: 3, port: "c" } },
        { from: { op: 3, port: "out" }, to: { op: 4 } },
        { from: { op: 4 }, to: { op: 5 } },
      ],
    );
    const { readiness, controlEdges, joins } = runtime(plan);

    controlEdges.activate(0);
    controlEdges.complete(0);
    controlEdges.skip(1);
    controlEdges.skip(2);

    const reconciliation = joins.reconcileJoin(3);
    expect(reconciliation.ready).toBe(false);
    expect(reconciliation.newlyReady).toBe(false);
    expect(reconciliation.completedInputEdges).toEqual([0]);
    expect(reconciliation.skippedInputEdges).toEqual([1, 2]);
    expect(reconciliation.propagatedSkippedOps).toEqual([3, 4, 5]);
    expect(readiness.getOpState(3).status).toBe("skipped");
    expect(readiness.getOpState(4).status).toBe("skipped");
    expect(readiness.getOpState(5).status).toBe("skipped");
    expect(controlEdges.getState(3).status).toBe("skipped");
    expect(controlEdges.getState(4).status).toBe("skipped");
  });

  it("skips an any join when every input lane is definitively unavailable", () => {
    const plan = ir(
      [
        executableOp("left", []),
        executableOp("right", []),
        joinOp("join", [0, 1], {
          kind: "join",
          inputs: ["left", "right"],
          output: "out",
          mode: "any",
        }),
      ],
      [
        { from: { op: 0 }, to: { op: 2, port: "left" } },
        { from: { op: 1 }, to: { op: 2, port: "right" } },
      ],
    );
    const { readiness, controlEdges, joins } = runtime(plan);

    controlEdges.skip(0);
    controlEdges.skip(1);

    expect(joins.reconcileJoin(2).propagatedSkippedOps).toEqual([2]);
    expect(readiness.getOpState(2).status).toBe("skipped");
  });

  it("rejects an invalid quorum even when malformed IR bypasses the compiler", () => {
    const plan = ir(
      [
        executableOp("left", []),
        executableOp("right", []),
        joinOp("join", [0, 1], {
          kind: "join",
          inputs: ["left", "right"],
          output: "out",
          mode: "quorum",
          quorum: 3,
        }),
      ],
      [
        { from: { op: 0 }, to: { op: 2, port: "left" } },
        { from: { op: 1 }, to: { op: 2, port: "right" } },
      ],
    );
    const readiness = new RunReadiness(plan);
    const controlEdges = new RunControlEdges(plan);

    expect(() => new RunJoinActivation(plan, readiness, controlEdges)).toThrow(
      "Join op 2 has an invalid quorum.",
    );
  });
});
