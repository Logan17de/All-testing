import { describe, expect, it } from "vitest";

import {
  RUN_OP_STATUSES,
  RUN_OP_TERMINAL_STATUSES,
  canTransitionRunOpStatus,
  createRunOpState,
  getAllowedRunOpTransitions,
  isTerminalRunOpStatus,
  transitionRunOpState,
  type RunOpStatus,
} from "./op-status.js";

const allowedTransitions: Readonly<Record<RunOpStatus, readonly RunOpStatus[]>> = {
  pending: ["ready", "skipped", "cancelled"],
  ready: ["running", "skipped", "cancelled"],
  running: ["completed", "skipped", "waiting", "retry-wait", "failed", "cancelled"],
  completed: [],
  skipped: [],
  waiting: ["ready", "cancelled"],
  "retry-wait": ["ready", "cancelled"],
  failed: [],
  cancelled: [],
};

describe("run-local op status state machine", () => {
  it("freezes the complete 3.1 status vocabulary", () => {
    expect(RUN_OP_STATUSES).toEqual([
      "pending",
      "ready",
      "running",
      "completed",
      "skipped",
      "waiting",
      "retry-wait",
      "failed",
      "cancelled",
    ]);
    expect(new Set(RUN_OP_STATUSES).size).toBe(RUN_OP_STATUSES.length);
  });

  it("creates every op in immutable pending state", () => {
    const state = createRunOpState(7);

    expect(state).toEqual({ op: 7, status: "pending" });
    expect(Object.isFrozen(state)).toBe(true);
  });

  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid op index %s", (op) => {
    expect(() => createRunOpState(op)).toThrow(RangeError);
  });

  it("locks every legal and illegal status transition", () => {
    for (const from of RUN_OP_STATUSES) {
      expect(getAllowedRunOpTransitions(from)).toEqual(allowedTransitions[from]);

      for (const to of RUN_OP_STATUSES) {
        expect(canTransitionRunOpStatus(from, to)).toBe(allowedTransitions[from].includes(to));
      }
    }
  });

  it("preserves the previous state and op identity across a legal transition", () => {
    const pending = createRunOpState(3);
    const ready = transitionRunOpState(pending, "ready");
    const running = transitionRunOpState(ready, "running");
    const retryWait = transitionRunOpState(running, "retry-wait");
    const readyAgain = transitionRunOpState(retryWait, "ready");

    expect(pending).toEqual({ op: 3, status: "pending" });
    expect(ready).toEqual({ op: 3, status: "ready" });
    expect(running).toEqual({ op: 3, status: "running" });
    expect(retryWait).toEqual({ op: 3, status: "retry-wait" });
    expect(readyAgain).toEqual({ op: 3, status: "ready" });
    expect(ready).not.toBe(pending);
    expect(Object.isFrozen(readyAgain)).toBe(true);
  });

  it("allows waiting work to become ready again without inventing resume mechanics", () => {
    const running = transitionRunOpState(
      transitionRunOpState(createRunOpState(0), "ready"),
      "running",
    );
    const waiting = transitionRunOpState(running, "waiting");

    expect(transitionRunOpState(waiting, "ready")).toEqual({ op: 0, status: "ready" });
  });

  it("treats completed, skipped, failed, and cancelled as terminal", () => {
    expect(RUN_OP_TERMINAL_STATUSES).toEqual(["completed", "skipped", "failed", "cancelled"]);

    for (const status of RUN_OP_STATUSES) {
      const terminal = RUN_OP_TERMINAL_STATUSES.includes(
        status as (typeof RUN_OP_TERMINAL_STATUSES)[number],
      );
      expect(isTerminalRunOpStatus(status)).toBe(terminal);
    }
  });

  it("rejects self-transitions, terminal transitions, and phase-skipping transitions", () => {
    expect(() => transitionRunOpState(createRunOpState(1), "pending")).toThrow(
      "Illegal run op status transition 'pending' -> 'pending'.",
    );
    expect(() => transitionRunOpState(createRunOpState(1), "running")).toThrow(
      "Illegal run op status transition 'pending' -> 'running'.",
    );

    const completed = transitionRunOpState(
      transitionRunOpState(transitionRunOpState(createRunOpState(1), "ready"), "running"),
      "completed",
    );
    expect(() => transitionRunOpState(completed, "ready")).toThrow(
      "Illegal run op status transition 'completed' -> 'ready'.",
    );
  });
});
