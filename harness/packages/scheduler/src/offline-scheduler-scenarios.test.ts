import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutionIrV1 } from "@zet-harness/graph";

import { SchedulerConcurrency } from "./concurrency.js";
import { RunControlEdges } from "./control-edge-state.js";
import { RunJoinActivation } from "./join-activation.js";
import { NodeTimeoutError, PlainDagRun } from "./plain-dag-run.js";
import { RunReadiness } from "./run-readiness.js";
import { RunRouterActivation } from "./router-activation.js";
import {
  createDeterministicMockGate,
  createMockExecutionIr,
  createMockExecutionOp,
  DeterministicPlainDagExecutor,
} from "./testing.js";

async function waitForInvocations(
  executor: DeterministicPlainDagExecutor,
  count: number,
): Promise<void> {
  for (let turn = 0; turn < 30; turn += 1) {
    if (executor.snapshot().invocations.length >= count) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Expected ${String(count)} deterministic mock invocation(s).`);
}

function createRouterJoinScenarioIr(): ExecutionIrV1 {
  const ops = [
    createMockExecutionOp("route", [], {
      type: "test.router",
      behavior: {
        primitiveFamily: "control",
        recovery: "not-applicable",
        executionMode: "none",
      },
      control: { kind: "router", entry: "in", branches: ["left", "right"] },
    }),
    createMockExecutionOp("left", [0]),
    createMockExecutionOp("right", [0]),
    createMockExecutionOp("join", [1, 2], {
      type: "test.join",
      behavior: {
        primitiveFamily: "control",
        recovery: "not-applicable",
        executionMode: "none",
      },
      control: {
        kind: "join",
        inputs: ["left", "right"],
        output: "out",
        mode: "all-active",
      },
    }),
    createMockExecutionOp("finish", [3]),
  ];

  return {
    ...createMockExecutionIr(ops),
    controlEdges: [
      { from: { op: 0, port: "left" }, to: { op: 1 } },
      { from: { op: 0, port: "right" }, to: { op: 2 } },
      { from: { op: 1 }, to: { op: 3, port: "left" } },
      { from: { op: 2 }, to: { op: 3, port: "right" } },
      { from: { op: 3, port: "out" }, to: { op: 4 } },
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("offline scheduler scenarios", () => {
  it("executes a deterministic linear chain strictly in dependency order", async () => {
    const plan = createMockExecutionIr([
      createMockExecutionOp("fetch"),
      createMockExecutionOp("transform", [0]),
      createMockExecutionOp("store", [1]),
    ]);
    const scheduler = new SchedulerConcurrency(4);
    const mock = new DeterministicPlainDagExecutor();
    const run = new PlainDagRun(plan, scheduler.createRun(plan), mock.execute);

    const result = await run.execute();

    expect(mock.snapshot().invocations.map(({ sourceNodeId }) => sourceNodeId)).toEqual([
      "fetch",
      "transform",
      "store",
    ]);
    expect(result.readiness.ops.map(({ status }) => status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(result.readiness.remainingDependencies).toEqual([0, 0, 0]);
  });

  it("runs fan-out branches concurrently and starts fan-in only after both complete", async () => {
    const leftGate = createDeterministicMockGate();
    const rightGate = createDeterministicMockGate();
    const plan = createMockExecutionIr(
      [
        createMockExecutionOp("root"),
        createMockExecutionOp("left", [0]),
        createMockExecutionOp("right", [0]),
        createMockExecutionOp("join", [1, 2]),
      ],
      2,
    );
    const scheduler = new SchedulerConcurrency(4);
    const mock = new DeterministicPlainDagExecutor({
      left: [{ kind: "gate", gate: leftGate }],
      right: [{ kind: "gate", gate: rightGate }],
    });
    const run = new PlainDagRun(plan, scheduler.createRun(plan), mock.execute);

    const execution = run.execute();
    await waitForInvocations(mock, 3);

    expect(mock.snapshot().invocations.map(({ sourceNodeId }) => sourceNodeId)).toEqual([
      "root",
      "left",
      "right",
    ]);
    expect(mock.snapshot().active).toBe(2);
    expect(mock.snapshot().maxActive).toBe(2);

    leftGate.release();
    await Promise.resolve();
    expect(mock.snapshot().invocations).toHaveLength(3);

    rightGate.release();
    await execution;

    const trace = mock.snapshot().trace;
    const joinStart = trace.find(
      (event) => event.sourceNodeId === "join" && event.phase === "start",
    )?.sequence;
    const leftComplete = trace.find(
      (event) => event.sourceNodeId === "left" && event.phase === "complete",
    )?.sequence;
    const rightComplete = trace.find(
      (event) => event.sourceNodeId === "right" && event.phase === "complete",
    )?.sequence;

    expect(joinStart).toBeDefined();
    expect(leftComplete).toBeDefined();
    expect(rightComplete).toBeDefined();
    expect(joinStart).toBeGreaterThan(leftComplete ?? Number.POSITIVE_INFINITY);
    expect(joinStart).toBeGreaterThan(rightComplete ?? Number.POSITIVE_INFINITY);
  });

  it("routes one branch, skips the inactive path, then satisfies an all-active join", () => {
    const plan = createRouterJoinScenarioIr();
    const readiness = new RunReadiness(plan);
    const controlEdges = new RunControlEdges(plan);
    const routers = new RunRouterActivation(plan, readiness, controlEdges);
    const joins = new RunJoinActivation(plan, readiness, controlEdges);

    expect(readiness.dequeueReadyOp()).toBe(0);
    expect(routers.activateReservedRouter(0, "left")).toMatchObject({
      activatedTargets: [1],
      newlyReadyTargets: [1],
    });

    const waiting = joins.reconcileJoin(3);
    expect(waiting.ready).toBe(false);
    expect(waiting.propagatedSkippedOps).toEqual([2]);
    expect(readiness.getOpState(2).status).toBe("skipped");

    expect(readiness.dequeueReadyOp()).toBe(1);
    readiness.startReservedReadyOp(1);
    controlEdges.activate(2);
    readiness.completeRunningOp(1);
    controlEdges.complete(2);

    const ready = joins.reconcileJoin(3);
    expect(ready.ready).toBe(true);
    expect(ready.completedInputEdges).toEqual([2]);
    expect(ready.skippedInputEdges).toEqual([3]);

    expect(readiness.dequeueReadyOp()).toBe(3);
    expect(joins.completeReservedJoin(3)).toMatchObject({ newlyReadyTargets: [4] });

    expect(readiness.dequeueReadyOp()).toBe(4);
    readiness.startReservedReadyOp(4);
    readiness.completeRunningOp(4);

    expect(readiness.snapshot().ops.map(({ status }) => status)).toEqual([
      "completed",
      "completed",
      "skipped",
      "completed",
      "completed",
    ]);
    expect(controlEdges.snapshot().edges.map(({ status }) => status)).toEqual([
      "completed",
      "skipped",
      "completed",
      "skipped",
      "completed",
    ]);
  });

  it("isolates a node timeout and leaves its dependent work unsatisfied", async () => {
    vi.useFakeTimers();
    const plan = createMockExecutionIr([
      createMockExecutionOp("slow", [], { behavior: { timeoutMs: 25 } }),
      createMockExecutionOp("child", [0]),
    ]);
    const scheduler = new SchedulerConcurrency(1);
    const mock = new DeterministicPlainDagExecutor({
      slow: [{ kind: "wait-for-abort" }],
    });
    const run = new PlainDagRun(plan, scheduler.createRun(plan), mock.execute);

    const execution = run.execute();
    const rejection = expect(execution).rejects.toBeInstanceOf(NodeTimeoutError);
    await waitForInvocations(mock, 1);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    expect(run.signal.aborted).toBe(false);
    expect(run.snapshot().readiness.ops).toEqual([
      { op: 0, status: "failed" },
      { op: 1, status: "pending" },
    ]);
    expect(run.snapshot().readiness.remainingDependencies).toEqual([0, 1]);
    expect(mock.snapshot().trace.map(({ phase }) => phase)).toEqual(["start", "abort"]);
  });

  it("retries a transient failure within the shared budget before releasing downstream work", async () => {
    const transient = new Error("transient");
    const plan = createMockExecutionIr([
      createMockExecutionOp("flaky", [], {
        behavior: { retry: { maxAttempts: 2, backoffMs: 0 } },
      }),
      createMockExecutionOp("child", [0]),
    ]);
    const scheduler = new SchedulerConcurrency(1);
    const mock = new DeterministicPlainDagExecutor({
      flaky: [{ kind: "fail", error: transient }, { kind: "complete" }],
    });
    const run = new PlainDagRun(plan, scheduler.createRun(plan), mock.execute);

    const result = await run.execute();

    expect(mock.snapshot().invocations.map(({ sourceNodeId, attempt }) => [sourceNodeId, attempt])).toEqual([
      ["flaky", 1],
      ["flaky", 2],
      ["child", 1],
    ]);
    expect(result.attempts).toEqual([2, 1]);
    expect(result.attemptBudgetUsed).toEqual([2, 1]);
    expect(result.readiness.ops.map(({ status }) => status)).toEqual(["completed", "completed"]);
  });

  it("cancels a running mock cooperatively and terminalizes downstream work", async () => {
    const plan = createMockExecutionIr([
      createMockExecutionOp("waiting"),
      createMockExecutionOp("child", [0]),
    ]);
    const scheduler = new SchedulerConcurrency(1);
    const mock = new DeterministicPlainDagExecutor({
      waiting: [{ kind: "wait-for-abort" }],
    });
    const run = new PlainDagRun(plan, scheduler.createRun(plan), mock.execute);

    const execution = run.execute();
    await waitForInvocations(mock, 1);
    const reason = new Error("scenario cancelled");
    const rejection = expect(execution).rejects.toBe(reason);
    expect(run.cancel(reason)).toBe(true);
    await rejection;

    expect(run.snapshot().readiness.ops).toEqual([
      { op: 0, status: "cancelled" },
      { op: 1, status: "cancelled" },
    ]);
    expect(mock.snapshot().trace).toHaveLength(2);
    expect(mock.snapshot().trace[1]).toMatchObject({ phase: "abort", error: reason });
  });

  it("fails fast without releasing descendants or dispatching later ready siblings", async () => {
    const failure = new Error("branch failed");
    const plan = createMockExecutionIr(
      [
        createMockExecutionOp("root"),
        createMockExecutionOp("failing", [0]),
        createMockExecutionOp("later-sibling", [0]),
        createMockExecutionOp("fan-in", [1, 2]),
      ],
      1,
    );
    const scheduler = new SchedulerConcurrency(1);
    const mock = new DeterministicPlainDagExecutor({
      failing: [{ kind: "fail", error: failure }],
    });
    const run = new PlainDagRun(plan, scheduler.createRun(plan), mock.execute);

    await expect(run.execute()).rejects.toBe(failure);

    expect(mock.snapshot().invocations.map(({ sourceNodeId }) => sourceNodeId)).toEqual([
      "root",
      "failing",
    ]);
    expect(run.snapshot().readiness.ops).toEqual([
      { op: 0, status: "completed" },
      { op: 1, status: "failed" },
      { op: 2, status: "ready" },
      { op: 3, status: "pending" },
    ]);
    expect(run.snapshot().readiness.remainingDependencies).toEqual([0, 0, 0, 2]);
  });
});
