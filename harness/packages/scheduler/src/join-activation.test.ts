import { describe, expect, it } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import { RunControlEdges } from "./control-edge-state.js";
import { RunAllActiveJoinActivation } from "./join-activation.js";
import { RunReadiness } from "./run-readiness.js";
import { RunRouterActivation } from "./router-activation.js";

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

function routerOp(sourceNodeId: string, dependencies: readonly number[]): ExecutionIrOpV1 {
  return {
    sourceNodeId,
    type: "test.router",
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
    control: { kind: "router", entry: "in", branches: ["yes", "no"] },
  };
}

function joinOp(
  sourceNodeId: string,
  dependencies: readonly number[],
  options: { readonly executionMode?: "none" | "in-process" } = {},
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
      executionMode: options.executionMode ?? "none",
      requiredCapabilities: [],
    },
    control: {
      kind: "join",
      inputs: ["left", "right"],
      output: "out",
      mode: "all-active",
    },
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
  const routers = new RunRouterActivation(plan, readiness, controlEdges);
  const joins = new RunAllActiveJoinActivation(plan, readiness, controlEdges);
  return { readiness, controlEdges, routers, joins };
}

describe("RunAllActiveJoinActivation", () => {
  it("skips an unselected router path, waits for the active path, then completes the join", () => {
    const plan = ir(
      [
        routerOp("route", []),
        executableOp("left", [0]),
        executableOp("right", [0]),
        joinOp("join", [1, 2]),
        executableOp("finish", [3]),
      ],
      [
        { from: { op: 0, port: "yes" }, to: { op: 1 } },
        { from: { op: 0, port: "no" }, to: { op: 2 } },
        { from: { op: 1 }, to: { op: 3, port: "left" } },
        { from: { op: 2 }, to: { op: 3, port: "right" } },
        { from: { op: 3, port: "out" }, to: { op: 4 } },
      ],
    );
    const { readiness, controlEdges, routers, joins } = runtime(plan);

    expect(readiness.dequeueReadyOp()).toBe(0);
    routers.activateReservedRouter(0, "yes");

    const waiting = joins.reconcileJoin(3);
    expect(waiting).toEqual({
      joinOp: 3,
      ready: false,
      newlyReady: false,
      unresolvedInputEdges: [2],
      activeInputEdges: [],
      completedInputEdges: [],
      skippedInputEdges: [3],
      propagatedSkippedOps: [2],
    });
    expect(readiness.getOpState(2).status).toBe("skipped");
    expect(controlEdges.getState(3).status).toBe("skipped");

    expect(readiness.dequeueReadyOp()).toBe(1);
    readiness.startReservedReadyOp(1);
    controlEdges.activate(2);
    readiness.completeRunningOp(1);
    controlEdges.complete(2);

    const ready = joins.reconcileJoin(3);
    expect(ready.ready).toBe(true);
    expect(ready.newlyReady).toBe(true);
    expect(ready.completedInputEdges).toEqual([2]);
    expect(ready.skippedInputEdges).toEqual([3]);
    expect(readiness.getOpState(3).status).toBe("ready");

    expect(readiness.dequeueReadyOp()).toBe(3);
    expect(joins.completeReservedJoin(3)).toEqual({
      joinOp: 3,
      activatedTargets: [4],
      newlyReadyTargets: [4],
    });
    expect(readiness.getOpState(3).status).toBe("completed");
    expect(readiness.getOpState(4).status).toBe("ready");
    expect(controlEdges.getState(4).status).toBe("completed");
  });

  it("waits while any incoming edge is unresolved or active", () => {
    const plan = ir(
      [executableOp("left", []), executableOp("right", []), joinOp("join", [0, 1])],
      [
        { from: { op: 0 }, to: { op: 2, port: "left" } },
        { from: { op: 1 }, to: { op: 2, port: "right" } },
      ],
    );
    const { controlEdges, joins, readiness } = runtime(plan);

    controlEdges.activate(0);
    controlEdges.complete(0);
    expect(joins.reconcileJoin(2).ready).toBe(false);

    controlEdges.activate(1);
    const active = joins.reconcileJoin(2);
    expect(active.ready).toBe(false);
    expect(active.activeInputEdges).toEqual([1]);
    expect(readiness.getRemainingDependencyCount(2)).toBe(2);

    controlEdges.complete(1);
    expect(joins.reconcileJoin(2).ready).toBe(true);
    expect(readiness.getRemainingDependencyCount(2)).toBe(0);
  });

  it("does not skip a target when one of several edges from the same router source is selected", () => {
    const plan = ir(
      [routerOp("route", []), executableOp("branch", [0]), joinOp("join", [1])],
      [
        { from: { op: 0, port: "yes" }, to: { op: 1 } },
        { from: { op: 0, port: "no" }, to: { op: 1 } },
        { from: { op: 1 }, to: { op: 2, port: "left" } },
      ],
    );
    const { readiness, routers, joins } = runtime(plan);

    expect(readiness.dequeueReadyOp()).toBe(0);
    routers.activateReservedRouter(0, "yes");
    const reconciliation = joins.reconcileJoin(2);

    expect(reconciliation.propagatedSkippedOps).toEqual([]);
    expect(readiness.getOpState(1).status).toBe("ready");
  });

  it("propagates a definitively skipped control path to a fixed point", () => {
    const plan = ir(
      [
        routerOp("route", []),
        executableOp("left", [0]),
        executableOp("right-a", [0]),
        executableOp("right-b", [2]),
        joinOp("join", [1, 3]),
      ],
      [
        { from: { op: 0, port: "yes" }, to: { op: 1 } },
        { from: { op: 0, port: "no" }, to: { op: 2 } },
        { from: { op: 1 }, to: { op: 4, port: "left" } },
        { from: { op: 2 }, to: { op: 3 } },
        { from: { op: 3 }, to: { op: 4, port: "right" } },
      ],
    );
    const { readiness, controlEdges, routers, joins } = runtime(plan);

    expect(readiness.dequeueReadyOp()).toBe(0);
    routers.activateReservedRouter(0, "yes");
    const reconciliation = joins.reconcileJoin(4);

    expect(reconciliation.propagatedSkippedOps).toEqual([2, 3]);
    expect(readiness.getOpState(2).status).toBe("skipped");
    expect(readiness.getOpState(3).status).toBe("skipped");
    expect(controlEdges.getState(3).status).toBe("skipped");
    expect(controlEdges.getState(4).status).toBe("skipped");
  });

  it("releases one deduplicated join dependency for multiple terminal edges from one source", () => {
    const plan = ir(
      [executableOp("source", []), joinOp("join", [0])],
      [
        { from: { op: 0 }, to: { op: 1, port: "left" } },
        { from: { op: 0 }, to: { op: 1, port: "right" } },
      ],
    );
    const { readiness, controlEdges, joins } = runtime(plan);

    controlEdges.activate(0);
    controlEdges.complete(0);
    controlEdges.skip(1);

    const first = joins.reconcileJoin(1);
    expect(first.ready).toBe(true);
    expect(first.newlyReady).toBe(true);
    expect(readiness.getRemainingDependencyCount(1)).toBe(0);

    const second = joins.reconcileJoin(1);
    expect(second.ready).toBe(true);
    expect(second.newlyReady).toBe(false);
    expect(readiness.getRemainingDependencyCount(1)).toBe(0);
  });

  it("preflights a reserved join before mutating its output edges or lifecycle", () => {
    const plan = ir(
      [executableOp("source", []), joinOp("join", [0]), executableOp("finish", [1])],
      [
        { from: { op: 0 }, to: { op: 1, port: "left" } },
        { from: { op: 1, port: "out" }, to: { op: 2 } },
      ],
    );
    const { readiness, controlEdges, joins } = runtime(plan);

    controlEdges.activate(0);
    controlEdges.complete(0);
    expect(joins.reconcileJoin(1).ready).toBe(true);
    expect(() => joins.completeReservedJoin(1)).toThrow(
      "Join op 1 is not a dequeued ready reservation.",
    );

    expect(readiness.dequeueReadyOp()).toBe(0);
    readiness.startReservedReadyOp(0);
    readiness.completeRunningOp(0);
    expect(readiness.dequeueReadyOp()).toBe(1);
    controlEdges.activate(1);

    expect(() => joins.completeReservedJoin(1)).toThrow(
      "Join op 1 cannot resolve output edge 1 from 'active'.",
    );
    expect(readiness.getOpState(1).status).toBe("ready");
    expect(readiness.isReadyOpReserved(1)).toBe(true);
  });

  it("rejects malformed join wiring before reconciliation", () => {
    const wrongInput = ir(
      [executableOp("source", []), joinOp("join", [0])],
      [{ from: { op: 0 }, to: { op: 1, port: "maybe" } }],
    );
    expect(
      () =>
        new RunAllActiveJoinActivation(
          wrongInput,
          new RunReadiness(wrongInput),
          new RunControlEdges(wrongInput),
        ),
    ).toThrow("Join op 1 has an incoming control edge without a declared input port.");

    const missingDependency = ir(
      [executableOp("source", []), joinOp("join", [])],
      [{ from: { op: 0 }, to: { op: 1, port: "left" } }],
    );
    expect(
      () =>
        new RunAllActiveJoinActivation(
          missingDependency,
          new RunReadiness(missingDependency),
          new RunControlEdges(missingDependency),
        ),
    ).toThrow("Join control edge 0 -> 1 is missing its IR dependency.");

    const wrongExecutionMode = ir([joinOp("join", [], { executionMode: "in-process" })], []);
    expect(
      () =>
        new RunAllActiveJoinActivation(
          wrongExecutionMode,
          new RunReadiness(wrongExecutionMode),
          new RunControlEdges(wrongExecutionMode),
        ),
    ).toThrow("Join op 0 must be scheduler-owned with executionMode 'none'.");
  });

  it("requires shared control-edge state from the exact same IR object", () => {
    const left = ir([joinOp("join", [])], []);
    const right = ir([joinOp("join", [])], []);

    expect(
      () => new RunAllActiveJoinActivation(left, new RunReadiness(left), new RunControlEdges(right)),
    ).toThrow("Join activation control-edge state does not belong to this Execution IR.");
  });

  it("returns frozen reconciliation and completion results", () => {
    const plan = ir(
      [executableOp("source", []), joinOp("join", [0]), executableOp("finish", [1])],
      [
        { from: { op: 0 }, to: { op: 1, port: "left" } },
        { from: { op: 1, port: "out" }, to: { op: 2 } },
      ],
    );
    const { readiness, controlEdges, joins } = runtime(plan);

    controlEdges.activate(0);
    controlEdges.complete(0);
    const reconciliation = joins.reconcileJoin(1);
    expect(Object.isFrozen(reconciliation)).toBe(true);
    expect(Object.isFrozen(reconciliation.completedInputEdges)).toBe(true);
    expect(Object.isFrozen(reconciliation.propagatedSkippedOps)).toBe(true);

    expect(readiness.dequeueReadyOp()).toBe(0);
    readiness.startReservedReadyOp(0);
    readiness.completeRunningOp(0);
    expect(readiness.dequeueReadyOp()).toBe(1);
    const completion = joins.completeReservedJoin(1);
    expect(Object.isFrozen(completion)).toBe(true);
    expect(Object.isFrozen(completion.activatedTargets)).toBe(true);
    expect(Object.isFrozen(completion.newlyReadyTargets)).toBe(true);
  });
});
