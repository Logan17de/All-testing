import type { ExecutionIrV1 } from "@zet-harness/graph";

import {
  createRunOpState,
  isTerminalRunOpStatus,
  transitionRunOpState,
  type RunOpState,
} from "./op-status.js";

export interface RunReadinessSnapshot {
  readonly ops: readonly RunOpState[];
  readonly remainingDependencies: readonly number[];
  readonly readyQueue: readonly number[];
}

function assertOpIndex(op: number, opCount: number): void {
  if (!Number.isSafeInteger(op) || op < 0 || op >= opCount) {
    throw new RangeError(`Run op index ${String(op)} is outside [0, ${String(opCount)}).`);
  }
}

function frozenCopy<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

/**
 * Run-local readiness bookkeeping over immutable Execution IR dependencies.
 *
 * 3.2 owns deterministic FIFO readiness plus dependency counters. 3.4 adds the
 * narrow execution handoff from a dequeued ready reservation to running and then
 * completed/failed. 3.11 uses the already-frozen state machine to move a failed
 * attempt through running -> retry-wait -> ready without touching dependency
 * counters or pretending the predecessor completed.
 */
export class RunReadiness {
  private readonly ops: RunOpState[];
  private readonly dependencies: readonly (readonly number[])[];
  private readonly remainingDependencies: number[];
  private readonly dependents: readonly (readonly number[])[];
  private readonly releasedDependencies: Set<number>[];
  private readonly reservedReadyOps = new Set<number>();
  private readonly readyQueue: number[] = [];
  private readyHead = 0;

  constructor(ir: ExecutionIrV1, restored?: RunReadinessSnapshot) {
    const dependents = Array.from({ length: ir.ops.length }, () => [] as number[]);

    this.ops = ir.ops.map((_, op) => createRunOpState(op));
    this.dependencies = Object.freeze(ir.ops.map((op) => Object.freeze([...op.dependencies])));
    this.remainingDependencies = ir.ops.map((op) => op.dependencies.length);
    this.releasedDependencies = ir.ops.map(() => new Set<number>());

    ir.ops.forEach((op, targetOp) => {
      for (const dependencyOp of op.dependencies) {
        assertOpIndex(dependencyOp, ir.ops.length);
        const targets = dependents[dependencyOp];
        if (targets === undefined) {
          throw new TypeError(`Dependency source op ${String(dependencyOp)} is unavailable.`);
        }
        targets.push(targetOp);
      }
    });

    this.dependents = Object.freeze(dependents.map((targets) => Object.freeze([...targets])));

    for (let op = 0; op < this.ops.length; op += 1) {
      if (this.remainingDependencies[op] === 0) this.markReady(op);
    }
    if (restored !== undefined) this.restore(ir, restored);
  }

  /** Restore a quiescent plain-DAG frontier, never an unclassified running attempt. */
  private restore(ir: ExecutionIrV1, restored: RunReadinessSnapshot): void {
    const count = this.ops.length;
    const allowed = new Set(["pending", "ready", "completed", "waiting", "retry-wait"]);
    if (restored.ops.length !== count || restored.remainingDependencies.length !== count) {
      throw new TypeError("Restored readiness must cover the exact Execution IR op domain.");
    }
    const queued = new Set(restored.readyQueue);
    if (queued.size !== restored.readyQueue.length) {
      throw new TypeError("Restored readiness contains duplicate queue entries.");
    }
    for (const op of queued) assertOpIndex(op, count);
    restored.ops.forEach((state, op) => {
      if (state.op !== op || !allowed.has(state.status)) {
        throw new TypeError("Restored readiness contains an unsupported op state.");
      }
      const expected = this.dependencies[op]!.filter(
        (source) => restored.ops[source]?.status !== "completed",
      ).length;
      if (
        restored.remainingDependencies[op] !== expected ||
        (state.status === "pending" ? expected === 0 : expected !== 0) ||
        queued.has(op) !== (state.status === "ready") ||
        (state.status === "waiting" && ir.ops[op]?.behavior.primitiveFamily !== "interrupt")
      ) {
        throw new TypeError("Restored readiness contradicts committed dependency state.");
      }
    });
    this.readyQueue.length = 0;
    this.readyHead = 0;
    this.readyQueue.push(...restored.readyQueue);
    restored.ops.forEach((state, op) => {
      this.ops[op] = Object.freeze({ ...state });
      this.remainingDependencies[op] = restored.remainingDependencies[op]!;
      this.releasedDependencies[op] = new Set(
        this.dependencies[op]!.filter((source) => restored.ops[source]?.status === "completed"),
      );
    });
  }

  /** Commit-backed human wait. No executor attempt or dependency is consumed here. */
  waitReadyOp(op: number): void {
    if (this.peekReadyOp() !== op) throw new TypeError("Human gate must be FIFO ready.");
    this.dequeueReadyOp();
    this.startReservedReadyOp(op);
    this.ops[op] = transitionRunOpState(this.getOpState(op), "waiting");
  }

  get opCount(): number {
    return this.ops.length;
  }

  get readyCount(): number {
    return this.readyQueue.length - this.readyHead;
  }

  hasReadyOps(): boolean {
    return this.readyCount > 0;
  }

  getOpState(op: number): RunOpState {
    assertOpIndex(op, this.ops.length);
    const state = this.ops[op];
    if (state === undefined) {
      throw new RangeError(`Run op index ${String(op)} is unavailable.`);
    }
    return state;
  }

  getRemainingDependencyCount(op: number): number {
    assertOpIndex(op, this.ops.length);
    const remaining = this.remainingDependencies[op];
    if (remaining === undefined) {
      throw new RangeError(`Run op index ${String(op)} is unavailable.`);
    }
    return remaining;
  }

  getDependents(sourceOp: number): readonly number[] {
    assertOpIndex(sourceOp, this.ops.length);
    const targets = this.dependents[sourceOp];
    if (targets === undefined) {
      throw new RangeError(`Run op index ${String(sourceOp)} is unavailable.`);
    }
    return targets;
  }

  isDependencyReleased(sourceOp: number, targetOp: number): boolean {
    assertOpIndex(sourceOp, this.ops.length);
    assertOpIndex(targetOp, this.ops.length);
    const released = this.releasedDependencies[targetOp];
    if (released === undefined) {
      throw new RangeError(`Run op index ${String(targetOp)} is unavailable.`);
    }
    return released.has(sourceOp);
  }

  isReadyOpReserved(op: number): boolean {
    assertOpIndex(op, this.ops.length);
    return this.reservedReadyOps.has(op);
  }

  peekReadyOp(): number | undefined {
    return this.readyQueue[this.readyHead];
  }

  /**
   * Reserve the next FIFO-ready op for dispatch without starting it yet.
   * 3.4 transitions this exact reservation to running only after concurrency
   * admission has succeeded.
   */
  dequeueReadyOp(): number | undefined {
    const op = this.readyQueue[this.readyHead];
    if (op === undefined) {
      return undefined;
    }

    this.readyHead += 1;
    if (this.readyHead === this.readyQueue.length) {
      this.readyQueue.length = 0;
      this.readyHead = 0;
    }

    if (this.reservedReadyOps.has(op)) {
      throw new TypeError(`Run op ${String(op)} already has a ready reservation.`);
    }
    this.reservedReadyOps.add(op);
    return op;
  }

  /** Transition one dequeued ready reservation to running exactly once. */
  startReservedReadyOp(op: number): RunOpState {
    assertOpIndex(op, this.ops.length);
    if (!this.reservedReadyOps.has(op)) {
      throw new TypeError(`Run op ${String(op)} is not a dequeued ready reservation.`);
    }

    const current = this.getOpState(op);
    if (current.status !== "ready") {
      throw new TypeError(`Run op ${String(op)} cannot start from '${current.status}'.`);
    }

    this.reservedReadyOps.delete(op);
    const next = transitionRunOpState(current, "running");
    this.ops[op] = next;
    return next;
  }

  /** Mark one actively running op completed. Dependency release remains explicit. */
  completeRunningOp(op: number): RunOpState {
    return this.finishRunningOp(op, "completed");
  }

  /** Mark one actively running op failed without satisfying downstream dependencies. */
  failRunningOp(op: number): RunOpState {
    return this.finishRunningOp(op, "failed");
  }

  /**
   * Move one failed execution attempt into retry wait without releasing any DAG
   * dependency. The next attempt is a scheduler retry of the same logical op.
   */
  retryRunningOp(op: number): RunOpState {
    assertOpIndex(op, this.ops.length);
    const current = this.getOpState(op);
    if (current.status !== "running") {
      throw new TypeError(`Run op ${String(op)} cannot enter retry-wait from '${current.status}'.`);
    }

    const next = transitionRunOpState(current, "retry-wait");
    this.ops[op] = next;
    return next;
  }

  /**
   * Re-enqueue one retry-wait op at the FIFO tail after its delay has elapsed.
   * Dependency counters remain unchanged because this is the same logical op.
   */
  readyRetryOp(op: number): RunOpState {
    assertOpIndex(op, this.ops.length);
    const current = this.getOpState(op);
    if (current.status !== "retry-wait") {
      throw new TypeError(`Run op ${String(op)} cannot retry from '${current.status}'.`);
    }
    if (this.reservedReadyOps.has(op)) {
      throw new TypeError(`Run op ${String(op)} already has a ready reservation.`);
    }

    const next = transitionRunOpState(current, "ready");
    this.ops[op] = next;
    this.readyQueue.push(op);
    return next;
  }

  /** Mark control-inactive work skipped before it ever becomes ready. */
  skipPendingOp(op: number): RunOpState {
    assertOpIndex(op, this.ops.length);
    const current = this.getOpState(op);
    if (current.status !== "pending") {
      throw new TypeError(`Run op ${String(op)} cannot be skipped from '${current.status}'.`);
    }

    const next = transitionRunOpState(current, "skipped");
    this.ops[op] = next;
    return next;
  }

  /**
   * Terminalize every unfinished op for run-level cancellation.
   *
   * Completed/skipped/failed/cancelled work remains untouched. Pending, ready,
   * reserved-ready, running, waiting, and retry-wait work becomes cancelled.
   * Dependency counters remain historical scheduler state; cancellation never
   * pretends that a predecessor completed successfully.
   */
  cancelNonTerminalOps(): readonly number[] {
    const cancelled: number[] = [];

    for (let op = 0; op < this.ops.length; op += 1) {
      const current = this.ops[op];
      if (current === undefined || isTerminalRunOpStatus(current.status)) {
        continue;
      }

      this.ops[op] = transitionRunOpState(current, "cancelled");
      cancelled.push(op);
    }

    this.readyQueue.length = 0;
    this.readyHead = 0;
    this.reservedReadyOps.clear();

    return Object.freeze(cancelled);
  }

  /** Return the current FIFO queue without exposing mutable scheduler storage. */
  getReadyQueue(): readonly number[] {
    return frozenCopy(this.readyQueue.slice(this.readyHead));
  }

  /**
   * Satisfy one exact Execution-IR predecessor relation exactly once.
   * Returns true only when this release makes the target newly ready.
   */
  releaseDependency(sourceOp: number, targetOp: number): boolean {
    assertOpIndex(sourceOp, this.ops.length);
    assertOpIndex(targetOp, this.ops.length);

    const dependencies = this.dependencies[targetOp];
    if (dependencies === undefined || !dependencies.includes(sourceOp)) {
      throw new TypeError(
        `Run op ${String(targetOp)} does not depend on source op ${String(sourceOp)}.`,
      );
    }

    const released = this.releasedDependencies[targetOp];
    if (released === undefined) {
      throw new RangeError(`Run op index ${String(targetOp)} is unavailable.`);
    }
    if (released.has(sourceOp)) {
      throw new TypeError(
        `Run dependency ${String(sourceOp)} -> ${String(targetOp)} was already released.`,
      );
    }

    const remaining = this.remainingDependencies[targetOp];
    if (remaining === undefined || remaining <= 0) {
      throw new TypeError(
        `Run op ${String(targetOp)} dependency counter would underflow from source ${String(sourceOp)}.`,
      );
    }

    released.add(sourceOp);
    const nextRemaining = remaining - 1;
    this.remainingDependencies[targetOp] = nextRemaining;

    if (nextRemaining === 0 && this.ops[targetOp]?.status === "pending") {
      this.markReady(targetOp);
      return true;
    }

    return false;
  }

  snapshot(): RunReadinessSnapshot {
    return Object.freeze({
      ops: frozenCopy(this.ops),
      remainingDependencies: frozenCopy(this.remainingDependencies),
      readyQueue: this.getReadyQueue(),
    });
  }

  private finishRunningOp(op: number, nextStatus: "completed" | "failed"): RunOpState {
    assertOpIndex(op, this.ops.length);
    const current = this.getOpState(op);
    if (current.status !== "running") {
      throw new TypeError(
        `Run op ${String(op)} cannot enter ${nextStatus} from '${current.status}'.`,
      );
    }

    const next = transitionRunOpState(current, nextStatus);
    this.ops[op] = next;
    return next;
  }

  private markReady(op: number): void {
    const current = this.ops[op];
    if (current === undefined) {
      throw new RangeError(`Run op index ${String(op)} is unavailable.`);
    }
    if (current.status !== "pending") {
      throw new TypeError(`Run op ${String(op)} cannot enter ready from '${current.status}'.`);
    }

    this.ops[op] = transitionRunOpState(current, "ready");
    this.readyQueue.push(op);
  }
}
