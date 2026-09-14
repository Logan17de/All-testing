import { describe, expect, it } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import { SchedulerConcurrency } from "./concurrency.js";
import type { ControlEdgeRuntimeStatus } from "./control-edge-state.js";
import { PlainDagRun } from "./plain-dag-run.js";
import type { RouterBranchSelection } from "./router-activation.js";
import {
  reduceStructuredControlFrontier,
  type StructuredControlAction,
  type StructuredControlFrontier,
} from "./structured-control.js";
import {
  createMockExecutionIr,
  createMockExecutionOp,
  DeterministicPlainDagExecutor,
} from "./testing.js";

const CONTROL_BEHAVIOR = {
  primitiveFamily: "control",
  recovery: "not-applicable",
  executionMode: "none",
} as const;

function join(sourceNodeId: string, dependencies: readonly number[]): ExecutionIrOpV1 {
  return createMockExecutionOp(sourceNodeId, dependencies, {
    type: "test.join",
    behavior: CONTROL_BEHAVIOR,
    control: { kind: "join", inputs: ["left", "right"], output: "out", mode: "all-active" },
  });
}

/** route → left | right → all-active join → finish, plus a data consumer of right. */
function routedPlan(): ExecutionIrV1 {
  return {
    ...createMockExecutionIr([
      createMockExecutionOp("route", [], {
        type: "test.router",
        behavior: CONTROL_BEHAVIOR,
        control: { kind: "router", entry: "in", branches: ["left", "right"] },
      }),
      createMockExecutionOp("left", [0]),
      createMockExecutionOp("right", [0]),
      join("join", [1, 2]),
      createMockExecutionOp("finish", [3]),
      createMockExecutionOp("uses-right", [2]),
    ]),
    controlEdges: [
      { from: { op: 0, port: "left" }, to: { op: 1 } },
      { from: { op: 0, port: "right" }, to: { op: 2 } },
      { from: { op: 1 }, to: { op: 3, port: "left" } },
      { from: { op: 2 }, to: { op: 3, port: "right" } },
      { from: { op: 3, port: "out" }, to: { op: 4 } },
    ],
  };
}

/** Two independent sources feeding one all-active join, then a finisher. */
function twoLanePlan(): ExecutionIrV1 {
  return {
    ...createMockExecutionIr([
      createMockExecutionOp("a"),
      createMockExecutionOp("b"),
      join("join", [0, 1]),
      createMockExecutionOp("finish", [2]),
    ]),
    controlEdges: [
      { from: { op: 0 }, to: { op: 2, port: "left" } },
      { from: { op: 1 }, to: { op: 2, port: "right" } },
      { from: { op: 2, port: "out" }, to: { op: 3 } },
    ],
  };
}

interface Frontier extends StructuredControlFrontier {
  readonly ops: readonly { readonly status: string; readonly remainingDependencies: number }[];
  readonly readyQueue: readonly number[];
  readonly controlEdges: readonly ControlEdgeRuntimeStatus[];
  readonly routerSelections: readonly RouterBranchSelection[];
}

function freshFrontier(plan: ExecutionIrV1): Frontier {
  return {
    ops: plan.ops.map((op) => ({
      status: op.dependencies.length === 0 ? "ready" : "pending",
      remainingDependencies: op.dependencies.length,
    })),
    readyQueue: plan.ops.flatMap((op, index) => (op.dependencies.length === 0 ? [index] : [])),
    controlEdges: plan.controlEdges.map(() => "unresolved"),
    routerSelections: [],
  };
}

/** Apply one action the way a durable host would commit it. */
function commit(
  plan: ExecutionIrV1,
  frontier: Frontier,
  action: StructuredControlAction,
): Frontier {
  // A durable host marks an op running when its attempt begins, before it completes.
  if (action.kind === "complete" && frontier.ops[action.op]?.status === "ready") {
    frontier = {
      ...frontier,
      ops: frontier.ops.map((state, op) =>
        op === action.op ? { ...state, status: "running" } : state,
      ),
      readyQueue: frontier.readyQueue.filter((op) => op !== action.op),
    };
  }
  const delta = reduceStructuredControlFrontier(plan, frontier, action);
  const ops = frontier.ops.map((state) => ({ ...state }));
  for (const change of delta.ops) {
    ops[change.op] = { status: change.status, remainingDependencies: change.remainingDependencies };
  }
  const controlEdges = [...frontier.controlEdges];
  for (const change of delta.controlEdges) controlEdges[change.edge] = change.status;
  return {
    ops,
    readyQueue: [
      ...frontier.readyQueue.filter((op) => op !== action.op && ops[op]?.status === "ready"),
      ...delta.newlyReady,
    ],
    controlEdges,
    routerSelections:
      action.kind === "select-branch"
        ? [...frontier.routerSelections, { routerOp: action.op, branch: action.branch }]
        : frontier.routerSelections,
  };
}

/** Resume a live run from a committed frontier and let it finish. */
async function resume(plan: ExecutionIrV1, frontier: Frontier) {
  const statuses = frontier.ops.map((state) => state.status);
  const mock = new DeterministicPlainDagExecutor();
  const ordinaryCompleted = (op: number): boolean =>
    statuses[op] === "completed" && plan.ops[op]?.control === undefined;
  const run = new PlainDagRun(plan, new SchedulerConcurrency(2).createRun(plan), mock.execute, {
    restored: {
      readiness: {
        ops: statuses.map((status, op) => ({ op, status: status as "pending" })),
        remainingDependencies: frontier.ops.map((state) => state.remainingDependencies),
        readyQueue: frontier.readyQueue,
      },
      attempts: plan.ops.map((_, op) => (ordinaryCompleted(op) ? 1 : 0)),
      attemptBudgetUsed: plan.ops.map((_, op) => (ordinaryCompleted(op) ? 1 : 0)),
      retryDelaysMs: plan.ops.map(() => null),
      controlEdges: frontier.controlEdges,
      routerSelections: frontier.routerSelections,
    },
    control: { selectRouterBranch: () => "left" },
  });
  const result = await run.execute();
  return {
    statuses: result.readiness.ops.map(({ status }) => status),
    edges: result.controlEdges?.edges.map(({ status }) => status),
    ran: mock.snapshot().invocations.map(({ sourceNodeId }) => sourceNodeId),
  };
}

const ROUTED_STEPS: readonly StructuredControlAction[] = [
  { kind: "select-branch", op: 0, branch: "left" },
  { kind: "complete", op: 1 },
  { kind: "complete-join", op: 3 },
  { kind: "complete", op: 4 },
];

describe("committing control transitions", () => {
  it("records a branch choice with its skips and releases in one step", () => {
    const plan = routedPlan();
    const delta = reduceStructuredControlFrontier(plan, freshFrontier(plan), ROUTED_STEPS[0]!);

    expect(delta.ops).toEqual([
      { op: 0, status: "completed", remainingDependencies: 0 },
      { op: 1, status: "ready", remainingDependencies: 0 },
      { op: 2, status: "skipped", remainingDependencies: 1 },
      { op: 5, status: "skipped", remainingDependencies: 1 },
    ]);
    expect(delta.newlyReady).toEqual([1]);
    expect(delta.controlEdges).toEqual([
      { edge: 0, status: "completed" },
      { edge: 1, status: "skipped" },
      { edge: 3, status: "skipped" },
    ]);
  });

  it("reaches the same outcome as the live scheduler when every step is committed", async () => {
    const plan = routedPlan();
    let frontier = freshFrontier(plan);
    for (const step of ROUTED_STEPS) frontier = commit(plan, frontier, step);

    const live = new DeterministicPlainDagExecutor();
    const result = await new PlainDagRun(
      plan,
      new SchedulerConcurrency(2).createRun(plan),
      live.execute,
      { control: { selectRouterBranch: () => "left" } },
    ).execute();

    expect(frontier.ops.map((state) => state.status)).toEqual(
      result.readiness.ops.map(({ status }) => status),
    );
    expect(frontier.controlEdges).toEqual(result.controlEdges?.edges.map(({ status }) => status));
    expect(frontier.routerSelections).toEqual(result.routerSelections);
  });

  it("refuses a transition that contradicts the committed frontier", () => {
    const plan = routedPlan();
    expect(() =>
      reduceStructuredControlFrontier(plan, freshFrontier(plan), { kind: "complete-join", op: 3 }),
    ).toThrow("Control transition 'complete-join' conflicts with op 3 in 'pending'.");
  });

  it("leaves an all-active join waiting until its last active lane finishes", () => {
    const plan = twoLanePlan();
    const afterA = commit(plan, freshFrontier(plan), { kind: "complete", op: 0 });
    expect(afterA.ops[2]).toEqual({ status: "pending", remainingDependencies: 2 });

    const afterB = commit(plan, afterA, { kind: "complete", op: 1 });
    expect(afterB.ops[2]).toEqual({ status: "ready", remainingDependencies: 0 });
    expect(afterB.readyQueue).toEqual([2]);
  });
});

describe("resuming a run with routers and joins", () => {
  it("finishes identically from every committed point of a routed run", async () => {
    const plan = routedPlan();
    const expectedStatuses = [
      "completed",
      "completed",
      "skipped",
      "completed",
      "completed",
      "skipped",
    ];
    const ordinary = ["left", "finish"];

    let frontier = freshFrontier(plan);
    for (let step = 0; step <= ROUTED_STEPS.length; step += 1) {
      const resumed = await resume(plan, frontier);
      expect(resumed.statuses).toEqual(expectedStatuses);
      expect(resumed.edges).toEqual(["completed", "skipped", "completed", "skipped", "completed"]);
      const alreadyRan = frontier.ops.flatMap((state, op) =>
        state.status === "completed" && plan.ops[op]?.control === undefined
          ? [plan.ops[op]!.sourceNodeId]
          : [],
      );
      expect(resumed.ran).toEqual(ordinary.filter((name) => !alreadyRan.includes(name)));

      const next = ROUTED_STEPS[step];
      if (next !== undefined) frontier = commit(plan, frontier, next);
    }
  });

  it("resumes a join that is still waiting for one of its lanes", async () => {
    const plan = twoLanePlan();
    const frontier = commit(plan, freshFrontier(plan), { kind: "complete", op: 0 });

    const resumed = await resume(plan, frontier);

    expect(resumed.ran).toEqual(["b", "finish"]);
    expect(resumed.statuses).toEqual(["completed", "completed", "completed", "completed"]);
  });

  it("refuses a restore that is missing the committed control state", () => {
    const plan = routedPlan();
    const frontier = freshFrontier(plan);
    expect(
      () =>
        new PlainDagRun(plan, new SchedulerConcurrency(1).createRun(plan), () => undefined, {
          restored: {
            readiness: {
              ops: frontier.ops.map((state, op) => ({ op, status: state.status as "pending" })),
              remainingDependencies: frontier.ops.map((state) => state.remainingDependencies),
              readyQueue: frontier.readyQueue,
            },
            attempts: plan.ops.map(() => 0),
            attemptBudgetUsed: plan.ops.map(() => 0),
            retryDelaysMs: plan.ops.map(() => null),
          },
          control: { selectRouterBranch: () => "left" },
        }),
    ).toThrow(
      "Restoring a run with routers or joins requires its control-edge state and router selections.",
    );
  });

  it("refuses a restored branch choice that its committed state contradicts", async () => {
    const plan = routedPlan();
    const frontier = commit(plan, freshFrontier(plan), ROUTED_STEPS[0]!);
    await expect(
      resume(plan, { ...frontier, routerSelections: [{ routerOp: 0, branch: "right" }] }),
    ).rejects.toThrow("contradicts");
  });
});
