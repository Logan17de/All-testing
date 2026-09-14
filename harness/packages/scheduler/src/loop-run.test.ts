import { describe, expect, it } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import { SchedulerConcurrency } from "./concurrency.js";
import {
  PlainDagRun,
  type PlainDagLoopDecisionContext,
  type PlainDagOpExecution,
  type PlainDagRunOptions,
} from "./plain-dag-run.js";
import { RunReadiness } from "./run-readiness.js";
import { createMockExecutionIr, createMockExecutionOp } from "./testing.js";

const CONTROL_BEHAVIOR = {
  primitiveFamily: "control",
  recovery: "not-applicable",
  executionMode: "none",
} as const;

function loopOp(
  dependencies: readonly number[],
  region: readonly number[],
  maxIterations: number,
): ExecutionIrOpV1 {
  return createMockExecutionOp("loop", dependencies, {
    type: "test.loop",
    behavior: CONTROL_BEHAVIOR,
    control: {
      kind: "loop",
      entry: "enter",
      continue: "again",
      body: "body",
      exit: "done",
      region,
      maxIterations,
    },
  });
}

/** start → loop ─body→ a → b ─again→ loop ─done→ after, and after also reads b. */
function loopPlan(
  maxIterations = 3,
  a: ExecutionIrOpV1 = createMockExecutionOp("a", [1]),
): ExecutionIrV1 {
  return {
    ...createMockExecutionIr(
      [
        createMockExecutionOp("start"),
        loopOp([0], [2, 3], maxIterations),
        a,
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

function start(
  plan: ExecutionIrV1,
  continueLoop: (context: PlainDagLoopDecisionContext) => boolean | Promise<boolean>,
  options: Omit<PlainDagRunOptions, "control"> & {
    readonly selectRouterBranch?: () => string;
    readonly fail?: (execution: PlainDagOpExecution) => boolean;
  } = {},
) {
  const ran: string[] = [];
  const decisions: number[] = [];
  const { selectRouterBranch, fail, ...rest } = options;
  const run = new PlainDagRun(
    plan,
    new SchedulerConcurrency(2).createRun(plan),
    (execution) => {
      ran.push(`${execution.operation.sourceNodeId}#${String(execution.iteration)}`);
      if (fail?.(execution) === true) throw new Error("transient");
    },
    {
      ...rest,
      control: {
        continueLoop: (context) => {
          decisions.push(context.iteration);
          return continueLoop(context);
        },
        ...(selectRouterBranch === undefined ? {} : { selectRouterBranch }),
      },
    },
  );
  return { run, ran, decisions };
}

describe("loops inside a run", () => {
  it("repeats the body until its bound while the host keeps continuing", async () => {
    const { run, ran, decisions } = start(loopPlan(3), () => true);

    const result = await run.execute();

    expect(ran).toEqual(["start#0", "a#0", "b#0", "a#1", "b#1", "a#2", "b#2", "after#0"]);
    // The bound ends the third iteration without asking.
    expect(decisions).toEqual([0, 1]);
    expect(result.readiness.ops.map(({ status }) => status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(result.iterations).toEqual([0, 2, 2, 2, 0]);
  });

  it("leaves the loop as soon as the host says stop", async () => {
    const { run, ran } = start(loopPlan(5), () => false);
    await run.execute();
    expect(ran).toEqual(["start#0", "a#0", "b#0", "after#0"]);
  });

  it("asks again after every iteration and stops when the host does", async () => {
    const { run, ran, decisions } = start(loopPlan(5), ({ iteration }) => iteration < 1);
    await run.execute();
    expect(ran).toEqual(["start#0", "a#0", "b#0", "a#1", "b#1", "after#0"]);
    expect(decisions).toEqual([0, 1]);
  });

  it("waits for an asynchronous decision", async () => {
    const { run, ran } = start(loopPlan(2), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    });
    await run.execute();
    expect(ran).toEqual(["start#0", "a#0", "b#0", "a#1", "b#1", "after#0"]);
  });

  it("records each decision durably before acting on it", async () => {
    const recorded: { iteration: number; decision: string; ranSoFar: number }[] = [];
    const { run, ran } = start(loopPlan(3), ({ iteration }) => iteration === 0, {
      durability: {
        loopAdvanced: ({ iteration, decision }) => {
          recorded.push({ iteration, decision, ranSoFar: ran.length });
        },
      },
    });

    await run.execute();

    expect(recorded).toEqual([
      { iteration: 0, decision: "continue", ranSoFar: 3 },
      { iteration: 1, decision: "exit", ranSoFar: 5 },
    ]);
  });

  it("gives a body op a fresh retry budget in every iteration", async () => {
    const a = createMockExecutionOp("a", [1], { behavior: { retry: { maxAttempts: 2 } } });
    const attempts: string[] = [];
    const { run } = start(loopPlan(2, a), () => true, {
      fail: (execution) => {
        if (execution.operation.sourceNodeId !== "a") return false;
        attempts.push(`${String(execution.iteration)}.${String(execution.attempt)}`);
        return execution.attempt === 1;
      },
    });

    await run.execute();

    expect(attempts).toEqual(["0.1", "0.2", "1.1", "1.2"]);
  });

  it("fails the run when the decision is not true or false", async () => {
    const { run, ran } = start(loopPlan(3), () => "yes" as unknown as boolean);
    await expect(run.execute()).rejects.toThrow(
      "Loop op 1 continue decision must be true or false.",
    );
    expect(ran).not.toContain("after#0");
  });

  it("runs a loop on the branch a router chose, with control edges resolved per iteration", async () => {
    const plan: ExecutionIrV1 = {
      ...createMockExecutionIr([
        createMockExecutionOp("route", [], {
          type: "test.router",
          behavior: CONTROL_BEHAVIOR,
          control: { kind: "router", entry: "in", branches: ["left", "right"] },
        }),
        createMockExecutionOp("right", [0]),
        loopOp([0], [3], 2),
        createMockExecutionOp("body", [2]),
        createMockExecutionOp("after", [2]),
      ]),
      controlEdges: [
        { from: { op: 0, port: "left" }, to: { op: 2, port: "enter" } },
        { from: { op: 0, port: "right" }, to: { op: 1 } },
        { from: { op: 2, port: "body" }, to: { op: 3 } },
        { from: { op: 3 }, to: { op: 2, port: "again" } },
        { from: { op: 2, port: "done" }, to: { op: 4 } },
      ],
    };
    const { run, ran } = start(plan, () => true, { selectRouterBranch: () => "left" });

    const result = await run.execute();

    expect(ran).toEqual(["body#0", "body#1", "after#0"]);
    expect(result.readiness.ops.map(({ status }) => status)).toEqual([
      "completed",
      "skipped",
      "completed",
      "completed",
      "completed",
    ]);
    expect(result.controlEdges?.edges.map(({ status }) => status)).toEqual([
      "completed",
      "skipped",
      "completed",
      "completed",
      "completed",
    ]);
  });
});

describe("loops the scheduler refuses", () => {
  it("refuses a loop without a continue decision", () => {
    const plan = loopPlan();
    expect(
      () => new PlainDagRun(plan, new SchedulerConcurrency(1).createRun(plan), () => undefined),
    ).toThrow("Loop op 1 requires a host-owned continue decision");
  });

  it("refuses a router inside a loop body", () => {
    const plan = loopPlan(
      2,
      createMockExecutionOp("a", [1], {
        type: "test.router",
        behavior: CONTROL_BEHAVIOR,
        control: { kind: "router", entry: "in", branches: ["x", "y"] },
      }),
    );
    expect(
      () =>
        new PlainDagRun(plan, new SchedulerConcurrency(1).createRun(plan), () => undefined, {
          control: { continueLoop: () => true, selectRouterBranch: () => "x" },
        }),
    ).toThrow("inside a loop body are not supported yet");
  });

  it("refuses to restore a run with loops, since iterations are not in the snapshot yet", () => {
    const plan = loopPlan();
    expect(
      () =>
        new PlainDagRun(plan, new SchedulerConcurrency(1).createRun(plan), () => undefined, {
          restored: {
            readiness: new RunReadiness(plan).snapshot(),
            attempts: plan.ops.map(() => 0),
            attemptBudgetUsed: plan.ops.map(() => 0),
            retryDelaysMs: plan.ops.map(() => null),
          },
          control: { continueLoop: () => true },
        }),
    ).toThrow("Restoring a run that contains loops is not supported yet.");
  });
});
