import { describe, expect, it } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import { SchedulerConcurrency } from "./concurrency.js";
import type { RunOpStatus } from "./op-status.js";
import { PlainDagRun, type PlainDagRestoreState } from "./plain-dag-run.js";
import { createMockExecutionIr, createMockExecutionOp } from "./testing.js";

const CONTROL_BEHAVIOR = {
  primitiveFamily: "control",
  recovery: "not-applicable",
  executionMode: "none",
} as const;

function loopOp(maxIterations: number): ExecutionIrOpV1 {
  return createMockExecutionOp("loop", [0], {
    type: "test.loop",
    behavior: CONTROL_BEHAVIOR,
    control: {
      kind: "loop",
      entry: "enter",
      continue: "again",
      body: "body",
      exit: "done",
      region: [2, 3],
      maxIterations,
    },
  });
}

/** start → loop ─body→ a → b ─again→ loop ─done→ after, and after also reads b. */
function loopPlan(maxIterations = 3): ExecutionIrV1 {
  return {
    ...createMockExecutionIr(
      [
        createMockExecutionOp("start"),
        loopOp(maxIterations),
        createMockExecutionOp("a", [1]),
        createMockExecutionOp("b", [2]),
        createMockExecutionOp("after", [1, 3]),
      ],
      2,
    ),
    controlEdges: [
      { from: { op: 0 }, to: { op: 1, port: "enter" } },
      { from: { op: 1, port: "body" }, to: { op: 2 } },
      { from: { op: 3 }, to: { op: 1, port: "again" } },
      { from: { op: 1, port: "done" }, to: { op: 4 } },
    ],
  };
}

interface CommittedOp {
  readonly status: RunOpStatus;
  readonly remaining: number;
  readonly attempts: number;
}

function restored(
  ops: readonly CommittedOp[],
  iterations: readonly number[] | undefined,
): PlainDagRestoreState {
  return {
    readiness: {
      ops: ops.map((state, op) => ({ op, status: state.status })),
      remainingDependencies: ops.map((state) => state.remaining),
      readyQueue: ops.flatMap((state, op) => (state.status === "ready" ? [op] : [])),
    },
    attempts: ops.map((state) => state.attempts),
    attemptBudgetUsed: ops.map((state) => state.attempts),
    retryDelaysMs: ops.map(() => null),
    ...(iterations === undefined ? {} : { iterations }),
  };
}

function resume(
  plan: ExecutionIrV1,
  state: PlainDagRestoreState,
  continueLoop: (iteration: number) => boolean,
) {
  const ran: string[] = [];
  const decisions: number[] = [];
  const run = new PlainDagRun(
    plan,
    new SchedulerConcurrency(2).createRun(plan),
    (execution) => {
      ran.push(`${execution.operation.sourceNodeId}#${String(execution.iteration)}`);
    },
    {
      restored: state,
      control: {
        continueLoop: ({ iteration }) => {
          decisions.push(iteration);
          return continueLoop(iteration);
        },
      },
    },
  );
  return { run, ran, decisions };
}

const done = (attempts = 1): CommittedOp => ({ status: "completed", remaining: 0, attempts });

describe("resuming a run inside a loop", () => {
  it("continues mid-iteration from the committed body state", async () => {
    const { run, ran } = resume(
      loopPlan(3),
      restored(
        [
          done(),
          { status: "running", remaining: 0, attempts: 1 },
          done(),
          { status: "ready", remaining: 0, attempts: 0 },
          { status: "pending", remaining: 2, attempts: 0 },
        ],
        [0, 1, 1, 1, 0],
      ),
      () => true,
    );

    const result = await run.execute();

    expect(ran).toEqual(["b#1", "a#2", "b#2", "after#0"]);
    expect(result.iterations).toEqual([0, 2, 2, 2, 0]);
    expect(result.readiness.ops.every(({ status }) => status === "completed")).toBe(true);
  });

  it("takes a decision that a restart interrupted after the body finished", async () => {
    const { run, ran, decisions } = resume(
      loopPlan(3),
      restored(
        [
          done(),
          { status: "running", remaining: 0, attempts: 1 },
          done(),
          done(),
          { status: "pending", remaining: 2, attempts: 0 },
        ],
        [0, 0, 0, 0, 0],
      ),
      () => false,
    );

    await run.execute();

    expect(decisions).toEqual([0]);
    expect(ran).toEqual(["after#0"]);
  });

  it("resumes a loop that has not been entered yet", async () => {
    const { run, ran } = resume(
      loopPlan(2),
      restored(
        [
          done(),
          { status: "ready", remaining: 0, attempts: 0 },
          { status: "pending", remaining: 1, attempts: 0 },
          { status: "pending", remaining: 1, attempts: 0 },
          { status: "pending", remaining: 2, attempts: 0 },
        ],
        [0, 0, 0, 0, 0],
      ),
      () => true,
    );

    await run.execute();

    expect(ran).toEqual(["a#0", "b#0", "a#1", "b#1", "after#0"]);
  });

  it("refuses a committed state where work after the loop was released early", () => {
    const plan = loopPlan(3);
    expect(() =>
      resume(
        plan,
        restored(
          [
            done(),
            { status: "running", remaining: 0, attempts: 1 },
            done(),
            done(),
            { status: "pending", remaining: 1, attempts: 0 },
          ],
          [0, 0, 0, 0, 0],
        ),
        () => true,
      ),
    ).toThrow("Restored readiness contradicts committed dependency state.");
  });

  it("refuses to resume a loop without its iteration numbers", () => {
    expect(() =>
      resume(
        loopPlan(3),
        restored(
          [
            done(),
            { status: "running", remaining: 0, attempts: 1 },
            done(),
            { status: "ready", remaining: 0, attempts: 0 },
            { status: "pending", remaining: 2, attempts: 0 },
          ],
          undefined,
        ),
        () => true,
      ),
    ).toThrow("Restoring a run with loops requires its iteration numbers.");
  });

  it("records loop entry durably before the body starts", async () => {
    const plan = loopPlan(1);
    const events: string[] = [];
    const run = new PlainDagRun(
      plan,
      new SchedulerConcurrency(2).createRun(plan),
      (execution) => {
        events.push(`run ${execution.operation.sourceNodeId}`);
      },
      {
        control: { continueLoop: () => true },
        durability: {
          loopEntered: ({ op }) => {
            events.push(`entered ${String(op)}`);
          },
        },
      },
    );

    await run.execute();

    expect(events).toEqual(["run start", "entered 1", "run a", "run b", "run after"]);
  });
});
