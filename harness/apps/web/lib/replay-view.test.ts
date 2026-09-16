import { describe, expect, it } from "vitest";

import {
  describeReplayStep,
  isRunReplayView,
  replayNodeStatuses,
  type ReplayStepView,
} from "./replay-view";

function step(partial: Partial<ReplayStepView> & { readonly kind: ReplayStepView["kind"] }) {
  return {
    sequence: 1,
    eventId: 1,
    occurredAtMs: 1_000,
    nodeId: "check",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    outcome: "completed",
    detail: null,
    ...partial,
  } satisfies ReplayStepView;
}

describe("the state of a graph as of one replayed step", () => {
  it("fills in nodes in the order they happened, and no further", () => {
    const steps = [
      step({ kind: "attempt", sequence: 1, nodeId: "check" }),
      step({ kind: "attempt", sequence: 2, nodeId: "act", outcome: "failed", attempt: 2 }),
      step({ kind: "attempt", sequence: 3, nodeId: "after" }),
    ];

    expect([...replayNodeStatuses(steps, 0)]).toEqual([["check", "completed"]]);
    expect([...replayNodeStatuses(steps, 1)]).toEqual([
      ["check", "completed"],
      ["act", "failed"],
    ]);
    expect(replayNodeStatuses(steps, 2).get("after")).toBe("completed");
    // Before the first step, nothing has happened to any node.
    expect([...replayNodeStatuses(steps, -1)]).toEqual([]);
  });

  it("shows a loop running until it leaves, and a node waiting for a person", () => {
    const steps = [
      step({ kind: "loop", sequence: 1, nodeId: "loop", outcome: "entered", attempt: null }),
      step({ kind: "approval", sequence: 2, nodeId: "ask", outcome: "requested", attempt: null }),
      step({ kind: "approval", sequence: 3, nodeId: "ask", outcome: "approved", attempt: null }),
      step({ kind: "attempt", sequence: 4, nodeId: "ask" }),
      step({ kind: "loop", sequence: 5, nodeId: "loop", outcome: "exit", attempt: null }),
    ];

    expect(replayNodeStatuses(steps, 0).get("loop")).toBe("running");
    expect(replayNodeStatuses(steps, 2).get("ask")).toBe("waiting");
    expect(replayNodeStatuses(steps, 3).get("ask")).toBe("completed");
    expect(replayNodeStatuses(steps, 4).get("loop")).toBe("completed");
  });

  it("ignores steps that belong to no node", () => {
    const steps = [step({ kind: "run", nodeId: null, opIndex: null, outcome: "completed" })];
    expect([...replayNodeStatuses(steps, 0)]).toEqual([]);
  });
});

describe("what a replayed step says", () => {
  it("says what happened in plain words", () => {
    expect(describeReplayStep(step({ kind: "attempt", attempt: 2, outcome: "failed" }))).toBe(
      "check failed on attempt 2.",
    );
    expect(
      describeReplayStep(step({ kind: "router", nodeId: "route", outcome: "left", attempt: null })),
    ).toBe("route chose left.");
    expect(describeReplayStep(step({ kind: "loop", nodeId: "loop", outcome: "continue" }))).toBe(
      "loop went round again.",
    );
    expect(describeReplayStep(step({ kind: "loop", nodeId: "loop", outcome: "exit" }))).toBe(
      "loop ended.",
    );
    expect(describeReplayStep(step({ kind: "approval", outcome: "requested" }))).toBe(
      "check asked a person.",
    );
    expect(describeReplayStep(step({ kind: "approval", outcome: "rejected" }))).toBe(
      "A person rejected check.",
    );
    expect(
      describeReplayStep(step({ kind: "run", nodeId: null, opIndex: null, outcome: "cancelled" })),
    ).toBe("The run cancelled.");
  });

  it("names an op when the graph no longer has a name for it", () => {
    expect(describeReplayStep(step({ kind: "attempt", nodeId: null, opIndex: 3 }))).toBe(
      "op 3 completed on attempt 1.",
    );
  });
});

describe("a replay answer from the runtime", () => {
  it("is recognized only when it carries the parts the panel reads", () => {
    expect(isRunReplayView({ runId: "run-1", consistent: true, steps: [], issues: [] })).toBe(true);
    expect(isRunReplayView({ runId: "run-1", consistent: true, steps: [] })).toBe(false);
    expect(isRunReplayView(null)).toBe(false);
    expect(isRunReplayView("replay")).toBe(false);
  });
});
