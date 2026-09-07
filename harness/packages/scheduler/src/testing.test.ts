import { describe, expect, it } from "vitest";

import { SchedulerConcurrency } from "./concurrency.js";
import { PlainDagRun } from "./plain-dag-run.js";
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
  for (let turn = 0; turn < 20; turn += 1) {
    if (executor.snapshot().invocations.length >= count) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Expected ${String(count)} deterministic mock invocation(s).`);
}

describe("scheduler deterministic testing primitives", () => {
  it("builds deterministic executable mock ops and plans without sharing mutable dependency arrays", () => {
    const dependencies = [0];
    const operation = createMockExecutionOp("child", dependencies, {
      behavior: {
        timeoutMs: 50,
        retry: { maxAttempts: 2, backoffMs: 10 },
        requiredCapabilities: ["test.capability"],
      },
    });
    const plan = createMockExecutionIr([createMockExecutionOp("root"), operation], 2);

    dependencies.push(99);

    expect(operation.dependencies).toEqual([0]);
    expect(operation.behavior).toMatchObject({
      primitiveFamily: "pure",
      determinism: "deterministic",
      timeoutMs: 50,
      retry: { maxAttempts: 2, backoffMs: 10 },
      requiredCapabilities: ["test.capability"],
    });
    expect(plan.policies.maxParallelism).toBe(2);
    expect(() => createMockExecutionIr([], 0)).toThrow(
      "Mock execution IR maxParallelism must be a positive safe integer.",
    );
  });

  it("completes unscripted nodes deterministically and records ordered frozen trace snapshots", async () => {
    const plan = createMockExecutionIr([
      createMockExecutionOp("root"),
      createMockExecutionOp("child", [0]),
    ]);
    const scheduler = new SchedulerConcurrency(1);
    const mock = new DeterministicPlainDagExecutor();
    const run = new PlainDagRun(plan, scheduler.createRun(plan), mock.execute);

    await run.execute();

    const snapshot = mock.snapshot();
    expect(snapshot.invocations.map(({ sourceNodeId }) => sourceNodeId)).toEqual(["root", "child"]);
    expect(snapshot.trace.map(({ phase }) => phase)).toEqual([
      "start",
      "complete",
      "start",
      "complete",
    ]);
    expect(snapshot.active).toBe(0);
    expect(snapshot.maxActive).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.invocations)).toBe(true);
    expect(Object.isFrozen(snapshot.trace)).toBe(true);
  });

  it("scripts deterministic retry outcomes by stable source node id", async () => {
    const firstFailure = new Error("first attempt");
    const plan = createMockExecutionIr([
      createMockExecutionOp("flaky", [], {
        behavior: { retry: { maxAttempts: 2, backoffMs: 0 } },
      }),
    ]);
    const scheduler = new SchedulerConcurrency(1);
    const mock = new DeterministicPlainDagExecutor({
      flaky: [{ kind: "fail", error: firstFailure }, { kind: "complete" }],
    });
    const run = new PlainDagRun(plan, scheduler.createRun(plan), mock.execute);

    const result = await run.execute();

    expect(result.attempts).toEqual([2]);
    expect(mock.snapshot().invocations.map(({ attempt }) => attempt)).toEqual([1, 2]);
    expect(mock.snapshot().trace.map(({ phase }) => phase)).toEqual([
      "start",
      "fail",
      "start",
      "complete",
    ]);
    expect(mock.snapshot().trace[1]).toMatchObject({ error: firstFailure });
  });

  it("uses manual gates to expose deterministic concurrency without wall-clock sleeps", async () => {
    const gate = createDeterministicMockGate();
    const plan = createMockExecutionIr(
      [createMockExecutionOp("left"), createMockExecutionOp("right")],
      2,
    );
    const scheduler = new SchedulerConcurrency(2);
    const mock = new DeterministicPlainDagExecutor({
      left: [{ kind: "gate", gate }],
      right: [{ kind: "gate", gate }],
    });
    const run = new PlainDagRun(plan, scheduler.createRun(plan), mock.execute);

    const execution = run.execute();
    await waitForInvocations(mock, 2);

    expect(mock.snapshot().active).toBe(2);
    expect(mock.snapshot().maxActive).toBe(2);
    expect(gate.released).toBe(false);
    expect(gate.release()).toBe(true);
    expect(gate.release()).toBe(false);

    await execution;
    expect(mock.snapshot().active).toBe(0);
  });

  it("charges scripted internal retries to the scheduler-owned shared attempt budget", async () => {
    const plan = createMockExecutionIr([
      createMockExecutionOp("adapter", [], {
        behavior: { retry: { maxAttempts: 3, backoffMs: 0 } },
      }),
    ]);
    const scheduler = new SchedulerConcurrency(1);
    const mock = new DeterministicPlainDagExecutor({
      adapter: [{ kind: "complete", internalRetries: 2 }],
    });
    const run = new PlainDagRun(plan, scheduler.createRun(plan), mock.execute);

    const result = await run.execute();

    expect(result.attempts).toEqual([1]);
    expect(result.attemptBudgetUsed).toEqual([3]);
    expect(mock.snapshot().invocations).toEqual([
      {
        sequence: 1,
        op: 0,
        sourceNodeId: "adapter",
        attempt: 1,
        internalRetries: 2,
        maxAttempts: 3,
        budgetUsedAtStart: 1,
        budgetRemainingAtStart: 2,
      },
    ]);
  });

  it("waits cooperatively for abort and records the exact cancellation reason", async () => {
    const plan = createMockExecutionIr([createMockExecutionOp("waiting")]);
    const scheduler = new SchedulerConcurrency(1);
    const mock = new DeterministicPlainDagExecutor({
      waiting: [{ kind: "wait-for-abort" }],
    });
    const run = new PlainDagRun(plan, scheduler.createRun(plan), mock.execute);
    const reason = new Error("stop mock");

    const execution = run.execute();
    await waitForInvocations(mock, 1);
    expect(run.cancel(reason)).toBe(true);

    await expect(execution).rejects.toBe(reason);
    expect(mock.snapshot().active).toBe(0);
    expect(mock.snapshot().trace.map(({ phase }) => phase)).toEqual(["start", "abort"]);
    expect(mock.snapshot().trace[1]).toMatchObject({ error: reason });
  });

  it("fails loudly when an explicitly scripted node reaches an unconfigured attempt", async () => {
    const plan = createMockExecutionIr([
      createMockExecutionOp("incomplete-script", [], {
        behavior: { retry: { maxAttempts: 2, backoffMs: 0 } },
      }),
    ]);
    const scheduler = new SchedulerConcurrency(1);
    const mock = new DeterministicPlainDagExecutor({
      "incomplete-script": [{ kind: "fail", error: new Error("retry") }],
    });
    const run = new PlainDagRun(plan, scheduler.createRun(plan), mock.execute);

    await expect(run.execute()).rejects.toThrow(
      "No deterministic mock step configured for 'incomplete-script' attempt 2.",
    );
    expect(run.snapshot().attempts).toEqual([2]);
  });
});
