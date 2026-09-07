import { describe, expect, it } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

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

describe("RunRouterActivation", () => {
  it("activates only the selected router branch and completes the scheduler-owned router", () => {
    const plan = ir(
      [routerOp("route", []), executableOp("yes", [0]), executableOp("no", [0])],
      [
        { from: { op: 0, port: "yes" }, to: { op: 1 } },
        { from: { op: 0, port: "no" }, to: { op: 2 } },
      ],
    );
    const readiness = new RunReadiness(plan);
    const routers = new RunRouterActivation(plan, readiness);

    expect(readiness.dequeueReadyOp()).toBe(0);
    const activation = routers.activateReservedRouter(0, "yes");

    expect(activation).toEqual({
      routerOp: 0,
      branch: "yes",
      activatedTargets: [1],
      newlyReadyTargets: [1],
    });
    expect(Object.isFrozen(activation)).toBe(true);
    expect(Object.isFrozen(activation.activatedTargets)).toBe(true);
    expect(Object.isFrozen(activation.newlyReadyTargets)).toBe(true);
    expect(readiness.getOpState(0).status).toBe("completed");
    expect(readiness.getOpState(1).status).toBe("ready");
    expect(readiness.getOpState(2).status).toBe("pending");
    expect(readiness.isDependencyReleased(0, 1)).toBe(true);
    expect(readiness.isDependencyReleased(0, 2)).toBe(false);
    expect(routers.getSelectedBranch(0)).toBe("yes");
  });

  it("activates every target wired to the selected branch while preserving other dependencies", () => {
    const plan = ir(
      [
        routerOp("route", []),
        executableOp("other-root", []),
        executableOp("yes-a", [0]),
        executableOp("yes-b", [0, 1]),
        executableOp("no", [0]),
      ],
      [
        { from: { op: 0, port: "yes" }, to: { op: 2 } },
        { from: { op: 0, port: "yes" }, to: { op: 3 } },
        { from: { op: 0, port: "no" }, to: { op: 4 } },
      ],
    );
    const readiness = new RunReadiness(plan);
    const routers = new RunRouterActivation(plan, readiness);

    expect(readiness.dequeueReadyOp()).toBe(0);
    const activation = routers.activateReservedRouter(0, "yes");

    expect(activation.activatedTargets).toEqual([2, 3]);
    expect(activation.newlyReadyTargets).toEqual([2]);
    expect(readiness.getRemainingDependencyCount(3)).toBe(1);
    expect(readiness.getOpState(3).status).toBe("pending");
    expect(readiness.getOpState(4).status).toBe("pending");
  });

  it("deduplicates multiple selected-branch control edges to one dependency target", () => {
    const plan = ir(
      [routerOp("route", []), executableOp("yes", [0])],
      [
        { from: { op: 0, port: "yes" }, to: { op: 1 } },
        { from: { op: 0, port: "yes" }, to: { op: 1 } },
      ],
    );
    const readiness = new RunReadiness(plan);
    const routers = new RunRouterActivation(plan, readiness);

    expect(readiness.dequeueReadyOp()).toBe(0);
    expect(routers.activateReservedRouter(0, "yes").activatedTargets).toEqual([1]);
    expect(readiness.getRemainingDependencyCount(1)).toBe(0);
  });

  it("rejects an undeclared branch before mutating the reserved router", () => {
    const plan = ir([routerOp("route", [])], []);
    const readiness = new RunReadiness(plan);
    const routers = new RunRouterActivation(plan, readiness);

    expect(readiness.dequeueReadyOp()).toBe(0);
    expect(() => routers.activateReservedRouter(0, "maybe")).toThrow(
      "Router op 0 cannot select undeclared branch 'maybe'.",
    );
    expect(readiness.getOpState(0).status).toBe("ready");
    expect(readiness.isReadyOpReserved(0)).toBe(true);
    expect(routers.hasSelectedBranch(0)).toBe(false);
  });

  it("rejects non-router activation and duplicate router selection", () => {
    const plan = ir(
      [routerOp("route", []), executableOp("plain", []), executableOp("yes", [0])],
      [{ from: { op: 0, port: "yes" }, to: { op: 2 } }],
    );
    const readiness = new RunReadiness(plan);
    const routers = new RunRouterActivation(plan, readiness);

    expect(() => routers.getSelectedBranch(1)).toThrow("Run op 1 is not a router.");

    expect(readiness.dequeueReadyOp()).toBe(0);
    routers.activateReservedRouter(0, "yes");
    expect(() => routers.activateReservedRouter(0, "no")).toThrow(
      "Router op 0 already selected a branch.",
    );
  });

  it("requires a dequeued ready reservation before router activation", () => {
    const plan = ir([routerOp("route", [])], []);
    const readiness = new RunReadiness(plan);
    const routers = new RunRouterActivation(plan, readiness);

    expect(() => routers.activateReservedRouter(0, "yes")).toThrow(
      "Router op 0 is not a dequeued ready reservation.",
    );
    expect(readiness.getOpState(0).status).toBe("ready");
  });

  it("rejects malformed router wiring before any activation can occur", () => {
    const unported = ir(
      [routerOp("route", []), executableOp("target", [0])],
      [{ from: { op: 0 }, to: { op: 1 } }],
    );
    expect(() => new RunRouterActivation(unported, new RunReadiness(unported))).toThrow(
      "Router op 0 has an outgoing control edge without a declared branch port.",
    );

    const missingDependency = ir(
      [routerOp("route", []), executableOp("target", [])],
      [{ from: { op: 0, port: "yes" }, to: { op: 1 } }],
    );
    expect(() => new RunRouterActivation(missingDependency, new RunReadiness(missingDependency))).toThrow(
      "Router control edge 0 -> 1 is missing its IR dependency.",
    );
  });

  it("returns deterministic frozen selection snapshots", () => {
    const plan = ir(
      [routerOp("route-a", []), routerOp("route-b", []), executableOp("a", [0]), executableOp("b", [1])],
      [
        { from: { op: 0, port: "yes" }, to: { op: 2 } },
        { from: { op: 1, port: "no" }, to: { op: 3 } },
      ],
    );
    const readiness = new RunReadiness(plan);
    const routers = new RunRouterActivation(plan, readiness);

    expect(readiness.dequeueReadyOp()).toBe(0);
    routers.activateReservedRouter(0, "yes");
    expect(readiness.dequeueReadyOp()).toBe(1);
    routers.activateReservedRouter(1, "no");

    const snapshot = routers.snapshot();
    expect(snapshot).toEqual({
      selections: [
        { routerOp: 0, branch: "yes" },
        { routerOp: 1, branch: "no" },
      ],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.selections)).toBe(true);
    expect(snapshot.selections.every(Object.isFrozen)).toBe(true);
  });
});
