import { describe, expect, it } from "vitest";

import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import { SchedulerConcurrency } from "./concurrency.js";
import { PlainDagRun } from "./plain-dag-run.js";

function op(
  sourceNodeId: string,
  dependencies: readonly number[],
  overrides: Partial<ExecutionIrOpV1> = {},
): ExecutionIrOpV1 {
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
    ...overrides,
  };
}

function ir(ops: readonly ExecutionIrOpV1[], maxParallelism?: number): ExecutionIrV1 {
  return {
    format: "harness.ir/v1",
    graphInputs: [],
    graphOutputs: [],
    ops,
    controlEdges: [],
    entrypoints: [],
    policies: {
      ...(maxParallelism === undefined ? {} : { maxParallelism }),
      capabilities: { required: [], optional: [], deny: [] },
    },
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe("PlainDagRun", () => {
  it("executes independent fan-out branches concurrently and waits for both before fan-in", async () => {
    const plan = ir([op("root", []), op("left", [0]), op("right", [0]), op("join", [1, 2])], 2);
    const scheduler = new SchedulerConcurrency(4);
    const branchGate = deferred();
    const bothBranchesStarted = deferred();
    const events: string[] = [];
    let branchStarts = 0;

    const run = new PlainDagRun(plan, scheduler.createRun(plan), async ({ op: opIndex }) => {
      events.push(`start:${String(opIndex)}`);

      if (opIndex === 1 || opIndex === 2) {
        branchStarts += 1;
        if (branchStarts === 2) {
          bothBranchesStarted.resolve();
        }
        await branchGate.promise;
      }

      events.push(`end:${String(opIndex)}`);
    });

    const runPromise = run.execute();
    await bothBranchesStarted.promise;

    expect(events).toEqual(["start:0", "end:0", "start:1", "start:2"]);
    expect(run.snapshot().readiness.ops).toEqual([
      { op: 0, status: "completed" },
      { op: 1, status: "running" },
      { op: 2, status: "running" },
      { op: 3, status: "pending" },
    ]);

    branchGate.resolve();
    const result = await runPromise;

    expect(events.indexOf("start:3")).toBeGreaterThan(events.indexOf("end:1"));
    expect(events.indexOf("start:3")).toBeGreaterThan(events.indexOf("end:2"));
    expect(result.readiness.ops.map(({ status }) => status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(result.settled).toBe(true);
    expect(result.concurrency.run.active).toBe(0);
  });

  it("never exceeds the compiled per-run limit while dispatching independent roots", async () => {
    const plan = ir([op("a", []), op("b", []), op("c", []), op("d", [])], 2);
    const scheduler = new SchedulerConcurrency(8);
    const firstWaveStarted = deferred();
    const gate = deferred();
    const starts: number[] = [];
    let active = 0;
    let maxActive = 0;

    const run = new PlainDagRun(plan, scheduler.createRun(plan), async ({ op: opIndex }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      starts.push(opIndex);
      if (starts.length === 2) {
        firstWaveStarted.resolve();
      }

      await gate.promise;
      active -= 1;
    });

    const runPromise = run.execute();
    await firstWaveStarted.promise;

    expect(starts).toEqual([0, 1]);
    expect(run.snapshot().concurrency.run.active).toBe(2);
    expect(maxActive).toBe(2);

    gate.resolve();
    await runPromise;

    expect(starts).toEqual([0, 1, 2, 3]);
    expect(maxActive).toBe(2);
  });

  it("marks an executor failure locally, releases no downstream dependency, and rejects", async () => {
    const plan = ir([op("root", []), op("child", [0])], 1);
    const scheduler = new SchedulerConcurrency(1);
    const error = new Error("executor boom");
    const run = new PlainDagRun(plan, scheduler.createRun(plan), ({ op: opIndex }) => {
      if (opIndex === 0) {
        throw error;
      }
    });

    await expect(run.execute()).rejects.toBe(error);

    const snapshot = run.snapshot();
    expect(snapshot.settled).toBe(true);
    expect(snapshot.readiness.ops).toEqual([
      { op: 0, status: "failed" },
      { op: 1, status: "pending" },
    ]);
    expect(snapshot.readiness.remainingDependencies).toEqual([0, 1]);
    expect(snapshot.concurrency.run.active).toBe(0);
  });

  it("supports an empty plain DAG without inventing execution", async () => {
    const plan = ir([], 2);
    const scheduler = new SchedulerConcurrency(2);
    let calls = 0;
    const run = new PlainDagRun(plan, scheduler.createRun(plan), () => {
      calls += 1;
    });

    const result = await run.execute();

    expect(calls).toBe(0);
    expect(result.started).toBe(true);
    expect(result.settled).toBe(true);
    expect(result.readiness.ops).toEqual([]);
  });

  it("rejects repeated execution of the same run instance", async () => {
    const plan = ir([op("root", [])], 1);
    const scheduler = new SchedulerConcurrency(1);
    const run = new PlainDagRun(plan, scheduler.createRun(plan), () => undefined);

    await run.execute();
    await expect(run.execute()).rejects.toThrow("Plain DAG run may be executed only once.");
  });

  it("rejects structured-control ops instead of activating every branch as ordinary DAG fan-out", () => {
    const plan = ir([
      op("router", [], {
        control: { kind: "router", entry: "entry", branches: ["left", "right"] },
      }),
    ]);
    const scheduler = new SchedulerConcurrency(1);

    expect(() => new PlainDagRun(plan, scheduler.createRun(plan), () => undefined)).toThrow(
      "Plain DAG run cannot execute structured-control op 0 ('router')",
    );
  });

  it("rejects compile/control-only executionMode none ops", () => {
    const base = op("compile-only", []);
    const plan = ir([
      {
        ...base,
        behavior: { ...base.behavior, executionMode: "none", recovery: "not-applicable" },
      },
    ]);
    const scheduler = new SchedulerConcurrency(1);

    expect(() => new PlainDagRun(plan, scheduler.createRun(plan), () => undefined)).toThrow(
      "Plain DAG run cannot execute op 0 with executionMode 'none'.",
    );
  });
});
