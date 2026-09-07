import { describe, expect, it } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import {
  CONTROL_EDGE_RUNTIME_STATUSES,
  CONTROL_EDGE_RUNTIME_TRANSITIONS,
  RunControlEdges,
  canTransitionControlEdgeRuntimeState,
  transitionControlEdgeRuntimeState,
} from "./control-edge-state.js";

function op(sourceNodeId: string): ExecutionIrOpV1 {
  return {
    sourceNodeId,
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

function plan(): ExecutionIrV1 {
  return {
    format: "harness.ir/v1",
    graphInputs: [],
    graphOutputs: [],
    ops: [op("a"), op("b"), op("c")],
    controlEdges: [
      { from: { op: 0, port: "yes" }, to: { op: 1, port: "left" } },
      { from: { op: 0, port: "no" }, to: { op: 2, port: "right" } },
      { from: { op: 1 }, to: { op: 2, port: "left" } },
    ],
    entrypoints: [],
    policies: { capabilities: { required: [], optional: [], deny: [] } },
  };
}

describe("control-edge runtime state", () => {
  it("freezes the four-state vocabulary and legal transition table", () => {
    expect(CONTROL_EDGE_RUNTIME_STATUSES).toEqual([
      "unresolved",
      "active",
      "skipped",
      "completed",
    ]);
    expect(Object.isFrozen(CONTROL_EDGE_RUNTIME_STATUSES)).toBe(true);
    expect(Object.isFrozen(CONTROL_EDGE_RUNTIME_TRANSITIONS)).toBe(true);
    expect(Object.values(CONTROL_EDGE_RUNTIME_TRANSITIONS).every(Object.isFrozen)).toBe(true);

    expect(canTransitionControlEdgeRuntimeState("unresolved", "active")).toBe(true);
    expect(canTransitionControlEdgeRuntimeState("unresolved", "skipped")).toBe(true);
    expect(canTransitionControlEdgeRuntimeState("active", "completed")).toBe(true);
    expect(canTransitionControlEdgeRuntimeState("active", "skipped")).toBe(false);
    expect(canTransitionControlEdgeRuntimeState("skipped", "active")).toBe(false);
    expect(canTransitionControlEdgeRuntimeState("completed", "active")).toBe(false);
  });

  it("starts every IR control edge unresolved and returns frozen deterministic snapshots", () => {
    const controlEdges = new RunControlEdges(plan());
    const snapshot = controlEdges.snapshot();

    expect(snapshot.edges).toEqual([
      { edge: 0, status: "unresolved" },
      { edge: 1, status: "unresolved" },
      { edge: 2, status: "unresolved" },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.edges)).toBe(true);
    expect(snapshot.edges.every(Object.isFrozen)).toBe(true);
  });

  it("allows unresolved→active→completed and unresolved→skipped only", () => {
    const controlEdges = new RunControlEdges(plan());

    expect(controlEdges.activate(0)).toEqual({ edge: 0, status: "active" });
    expect(controlEdges.complete(0)).toEqual({ edge: 0, status: "completed" });
    expect(controlEdges.skip(1)).toEqual({ edge: 1, status: "skipped" });

    expect(() => controlEdges.complete(1)).toThrow(
      "Control edge 1 cannot transition from 'skipped' to 'completed'.",
    );
    expect(() => controlEdges.activate(0)).toThrow(
      "Control edge 0 cannot transition from 'completed' to 'active'.",
    );
    expect(controlEdges.getState(0).status).toBe("completed");
    expect(controlEdges.getState(1).status).toBe("skipped");
  });

  it("exposes immutable incoming/outgoing indexes without reordering IR edges", () => {
    const controlEdges = new RunControlEdges(plan());

    expect(controlEdges.getOutgoingEdgeIndexes(0)).toEqual([0, 1]);
    expect(controlEdges.getOutgoingEdgeIndexesForPort(0, "yes")).toEqual([0]);
    expect(controlEdges.getOutgoingEdgeIndexesForPort(0, "no")).toEqual([1]);
    expect(controlEdges.getIncomingEdgeIndexes(2)).toEqual([1, 2]);
    expect(controlEdges.getIncomingEdgeIndexesForPort(2, "right")).toEqual([1]);
    expect(controlEdges.getIncomingEdgeIndexesForPort(2, "left")).toEqual([2]);
    expect(Object.isFrozen(controlEdges.getOutgoingEdgeIndexes(0))).toBe(true);
    expect(Object.isFrozen(controlEdges.getIncomingEdgeIndexes(2))).toBe(true);
    expect(Object.isFrozen(controlEdges.getOutgoingEdgeIndexesForPort(0, "yes"))).toBe(true);
  });

  it("rejects invalid edge indexes without mutating existing state", () => {
    const controlEdges = new RunControlEdges(plan());
    const before = controlEdges.snapshot();

    expect(() => controlEdges.activate(99)).toThrow(RangeError);
    expect(controlEdges.snapshot()).toEqual(before);
  });

  it("keeps the pure transition helper immutable", () => {
    const initial = Object.freeze({ edge: 7, status: "unresolved" as const });
    const active = transitionControlEdgeRuntimeState(initial, "active");

    expect(active).toEqual({ edge: 7, status: "active" });
    expect(Object.isFrozen(active)).toBe(true);
    expect(initial.status).toBe("unresolved");
  });
});
