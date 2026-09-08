import { describe, expect, it } from "vitest";

import type {
  PreCrashRunningAttempt,
  RecoveryExecutionIrOp,
  RecoveryExecutionIrV1,
} from "./runtime-recovery.js";
import { classifyPreCrashRunningAttempts } from "./runtime-recovery-policy.js";

function op(
  sourceNodeId: string,
  recovery: string,
  executionMode = "in-process",
): RecoveryExecutionIrOp {
  return {
    sourceNodeId,
    dependencies: [],
    behavior: {
      executionMode,
      recovery,
      retry: { maxAttempts: 1 },
    },
  };
}

function ir(...ops: readonly RecoveryExecutionIrOp[]): RecoveryExecutionIrV1 {
  return {
    format: "harness.ir/v1",
    ops,
    controlEdges: [],
  };
}

function attempt(opIndex: number, iteration = 0, attemptNumber = 1): PreCrashRunningAttempt {
  return {
    opIndex,
    iteration,
    attempt: attemptNumber,
    logicalEffectId: `effect-${String(opIndex)}-${String(iteration)}`,
    startedAtMs: 100 + opIndex,
  };
}

describe("pre-crash recovery-policy classification", () => {
  it("maps every executable recovery policy without executing or mutating the frontier", () => {
    const executionIr = ir(
      op("rerun-node", "rerun"),
      op("reuse-node", "reuse"),
      op("reconcile-node", "reconcile"),
      op("manual-node", "manual"),
    );
    const preCrashRunningAttempts = [attempt(0), attempt(1), attempt(2), attempt(3)] as const;

    const classifications = classifyPreCrashRunningAttempts({
      executionIr,
      preCrashRunningAttempts,
    });

    expect(classifications).toEqual([
      expect.objectContaining({
        sourceNodeId: "rerun-node",
        recoveryPolicy: "rerun",
        action: "rerun",
        logicalEffectId: "effect-0-0",
      }),
      expect.objectContaining({
        sourceNodeId: "reuse-node",
        recoveryPolicy: "reuse",
        action: "hold-for-reuse",
      }),
      expect.objectContaining({
        sourceNodeId: "reconcile-node",
        recoveryPolicy: "reconcile",
        action: "hold-for-reconciliation",
      }),
      expect.objectContaining({
        sourceNodeId: "manual-node",
        recoveryPolicy: "manual",
        action: "hold-for-manual-review",
      }),
    ]);
    expect(Object.isFrozen(classifications)).toBe(true);
    expect(classifications.every((classification) => Object.isFrozen(classification))).toBe(true);
    expect(preCrashRunningAttempts[0]).toEqual(attempt(0));
  });

  it("returns a frozen empty classification for a frontier with no interrupted attempts", () => {
    const classifications = classifyPreCrashRunningAttempts({
      executionIr: ir(op("idle", "rerun")),
      preCrashRunningAttempts: [],
    });

    expect(classifications).toEqual([]);
    expect(Object.isFrozen(classifications)).toBe(true);
  });

  it("rejects not-applicable and unknown policies on a durable running attempt", () => {
    expect(() =>
      classifyPreCrashRunningAttempts({
        executionIr: ir(op("compile-policy", "not-applicable")),
        preCrashRunningAttempts: [attempt(0)],
      }),
    ).toThrow(/cannot use recovery policy 'not-applicable'/u);

    expect(() =>
      classifyPreCrashRunningAttempts({
        executionIr: ir(op("future-policy", "teleport")),
        preCrashRunningAttempts: [attempt(0)],
      }),
    ).toThrow(/unknown recovery policy 'teleport'/u);
  });

  it("rejects an impossible running attempt for a non-executable IR op", () => {
    expect(() =>
      classifyPreCrashRunningAttempts({
        executionIr: ir(op("compile-only", "not-applicable", "none")),
        preCrashRunningAttempts: [attempt(0)],
      }),
    ).toThrow(/execution mode 'none'/u);
  });

  it("rejects missing ops and duplicate running attempts for one logical invocation", () => {
    expect(() =>
      classifyPreCrashRunningAttempts({
        executionIr: ir(op("only-op", "rerun")),
        preCrashRunningAttempts: [attempt(1)],
      }),
    ).toThrow(/unavailable Execution IR op 1/u);

    expect(() =>
      classifyPreCrashRunningAttempts({
        executionIr: ir(op("duplicate", "rerun")),
        preCrashRunningAttempts: [attempt(0, 2, 1), attempt(0, 2, 2)],
      }),
    ).toThrow(/Multiple pre-crash running attempts exist for op\/iteration 0:2/u);
  });
});
