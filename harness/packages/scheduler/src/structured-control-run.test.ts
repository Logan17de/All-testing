import { describe, expect, it } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import { SchedulerConcurrency } from "./concurrency.js";
import { PlainDagRun, type PlainDagRouterSelectionContext } from "./plain-dag-run.js";
import { RunReadiness } from "./run-readiness.js";
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

function router(sourceNodeId: string, dependencies: readonly number[] = []): ExecutionIrOpV1 {
  return createMockExecutionOp(sourceNodeId, dependencies, {
    type: "test.router",
    behavior: CONTROL_BEHAVIOR,
    control: { kind: "router", entry: "in", branches: ["left", "right"] },
  });
}

/** route → left | right → all-active join → finish */
function routerJoinPlan(): ExecutionIrV1 {
  return {
    ...createMockExecutionIr([
      router("route"),
      createMockExecutionOp("left", [0]),
      createMockExecutionOp("right", [0]),
      createMockExecutionOp("join", [1, 2], {
        type: "test.join",
        behavior: CONTROL_BEHAVIOR,
        control: { kind: "join", inputs: ["left", "right"], output: "out", mode: "all-active" },
      }),
      createMockExecutionOp("finish", [3]),
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

function start(
  plan: ExecutionIrV1,
  selectRouterBranch: (context: PlainDagRouterSelectionContext) => string | Promise<string>,
  limit = 1,
) {
  const mock = new DeterministicPlainDagExecutor();
  const run = new PlainDagRun(plan, new SchedulerConcurrency(limit).createRun(plan), mock.execute, {
    control: { selectRouterBranch },
  });
  const ran = (): readonly string[] =>
    mock.snapshot().invocations.map(({ sourceNodeId }) => sourceNodeId);
  return { run, ran };
}

describe("routers and joins inside a run", () => {
  it("runs only the selected branch and completes through an all-active join", async () => {
    const { run, ran } = start(routerJoinPlan(), () => "left");

    const result = await run.execute();

    expect(ran()).toEqual(["left", "finish"]);
    expect(result.readiness.ops.map(({ status }) => status)).toEqual([
      "completed",
      "completed",
      "skipped",
      "completed",
      "completed",
    ]);
    expect(result.controlEdges?.edges.map(({ status }) => status)).toEqual([
      "completed",
      "skipped",
      "completed",
      "skipped",
      "completed",
    ]);
    expect(result.routerSelections).toEqual([{ routerOp: 0, branch: "left" }]);
  });

  it("gives the host the router's declared branches and the run's abort signal", async () => {
    const seen: PlainDagRouterSelectionContext[] = [];
    const { run } = start(routerJoinPlan(), (context) => {
      seen.push(context);
      return "right";
    });

    await run.execute();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.op).toBe(0);
    expect(seen[0]?.branches).toEqual(["left", "right"]);
    expect(seen[0]?.signal).toBe(run.signal);
  });

  it("waits for an asynchronous branch decision", async () => {
    const { run, ran } = start(routerJoinPlan(), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "right";
    });

    await run.execute();

    expect(ran()).toEqual(["right", "finish"]);
  });

  it("does not need a concurrency permit to resolve control ops", async () => {
    const { run, ran } = start(routerJoinPlan(), () => "left", 1);
    await expect(run.execute()).resolves.toMatchObject({ settled: true });
    expect(ran()).toEqual(["left", "finish"]);
  });

  it("fails the run when the host picks a branch the router does not declare", async () => {
    const { run, ran } = start(routerJoinPlan(), () => "sideways");

    await expect(run.execute()).rejects.toThrow(
      "Router op 0 selected a branch it does not declare.",
    );
    expect(ran()).toEqual([]);
  });

  it("fails the run when the branch decision itself fails", async () => {
    const { run, ran } = start(routerJoinPlan(), () => {
      throw new Error("no decision available");
    });

    await expect(run.execute()).rejects.toThrow("no decision available");
    expect(ran()).toEqual([]);
  });

  it("skips work that only receives data from a skipped branch", async () => {
    const plan: ExecutionIrV1 = {
      ...createMockExecutionIr([
        router("route"),
        createMockExecutionOp("left", [0]),
        createMockExecutionOp("right", [0]),
        createMockExecutionOp("uses-right", [2]),
        createMockExecutionOp("uses-left", [1]),
      ]),
      controlEdges: [
        { from: { op: 0, port: "left" }, to: { op: 1 } },
        { from: { op: 0, port: "right" }, to: { op: 2 } },
      ],
    };
    const { run, ran } = start(plan, () => "left");

    const result = await run.execute();

    expect(ran()).toEqual(["left", "uses-left"]);
    expect(result.readiness.ops.map(({ status }) => status)).toEqual([
      "completed",
      "completed",
      "skipped",
      "skipped",
      "completed",
    ]);
  });

  it("refuses a plan with a router but no host branch decision", () => {
    const plan = routerJoinPlan();
    expect(
      () => new PlainDagRun(plan, new SchedulerConcurrency(1).createRun(plan), () => undefined),
    ).toThrow("Router op 0 requires a host-owned branch selection hook");
  });

  it("still refuses loops, which are not executable yet", () => {
    const plan = createMockExecutionIr([
      createMockExecutionOp("loop", [], {
        type: "test.loop",
        behavior: CONTROL_BEHAVIOR,
        control: { kind: "loop", entry: "entry", continue: "again", body: "body", exit: "exit" },
      }),
    ]);
    expect(
      () =>
        new PlainDagRun(plan, new SchedulerConcurrency(1).createRun(plan), () => undefined, {
          control: { selectRouterBranch: () => "left" },
        }),
    ).toThrow("Plain DAG run cannot execute structured-control op 0 ('loop')");
  });

  it("refuses to restore a run with routers, since branch choices are not in the snapshot", () => {
    const plan = routerJoinPlan();
    const restored = {
      readiness: new RunReadiness(plan).snapshot(),
      attempts: plan.ops.map(() => 0),
      attemptBudgetUsed: plan.ops.map(() => 0),
      retryDelaysMs: plan.ops.map(() => null),
    };
    expect(
      () =>
        new PlainDagRun(plan, new SchedulerConcurrency(1).createRun(plan), () => undefined, {
          restored,
          control: { selectRouterBranch: () => "left" },
        }),
    ).toThrow("Restoring a run that contains routers or joins is not supported yet.");
  });
});
