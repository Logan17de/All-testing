import type { ExecutionIrV1 } from "@zet-harness/graph";

import { createRunOpState, transitionRunOpState, type RunOpState } from "./op-status.js";

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
 * 3.2 owns only deterministic FIFO readiness plus dependency counters. The
 * caller decides when one specific source→target dependency is satisfied;
 * completion/failure/skip/control-edge semantics are later Phase-3 concerns.
 */
export class RunReadiness {
  private readonly ops: RunOpState[];
  private readonly dependencies: readonly (readonly number[])[];
  private readonly remainingDependencies: number[];
  private readonly dependents: readonly (readonly number[])[];
  private readonly releasedDependencies: ReadonlySet<number>[];
  private readonly mutableReleasedDependencies: Set<number>[];
  private readonly readyQueue: number[] = [];
  private readyHead = 0;

  constructor(ir: ExecutionIrV1) {
    const dependents = Array.from({ length: ir.ops.length }, () => [] as number[]);

    this.ops = ir.ops.map((_, op) => createRunOpState(op));
    this.dependencies = Object.freeze(
      ir.ops.map((op) => Object.freeze([...op.dependencies]) as readonly number[]),
    );
    this.remainingDependencies = ir.ops.map((op) => op.dependencies.length);
    this.mutableReleasedDependencies = ir.ops.map(() => new Set<number>());
    this.releasedDependencies = this.mutableReleasedDependencies;

    ir.ops.forEach((op, targetOp) => {
      for (const dependencyOp of op.dependencies) {
        assertOpIndex(dependencyOp, ir.ops.length);
        dependents[dependencyOp]?.push(targetOp);
      }
    });

    this.dependents = Object.freeze(
      dependents.map((targets) => Object.freeze([...targets]) as readonly number[]),
    );

    for (let op = 0; op < this.ops.length; op += 1) {
      if (this.remainingDependencies[op] === 0) {
        this.markReady(op);
      }
    }
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
    return this.dependents[sourceOp] ?? Object.freeze([] as number[]);
  }

  isDependencyReleased(sourceOp: number, targetOp: number): boolean {
    assertOpIndex(sourceOp, this.ops.length);
    assertOpIndex(targetOp, this.ops.length);
    return this.releasedDependencies[targetOp]?.has(sourceOp) === true;
  }

  peekReadyOp(): number | undefined {
    return this.readyQueue[this.readyHead];
  }

  /**
   * Reserve the next FIFO-ready op for a later dispatch stage.
   *
   * 3.2 deliberately leaves the op status as `ready`; 3.3+ owns transition to
   * `running` once concurrency permission and dispatch are actually available.
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
    return op;
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

    const released = this.mutableReleasedDependencies[targetOp];
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
