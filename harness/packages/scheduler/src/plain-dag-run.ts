import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import type { ConcurrencyPermit, RunConcurrency, RunConcurrencySnapshot } from "./concurrency.js";
import { RunReadiness, type RunReadinessSnapshot } from "./run-readiness.js";

export class RunCancellationError extends Error {
  readonly code = "RUN_CANCELLED" as const;

  constructor(message = "Plain DAG run cancelled.") {
    super(message);
    this.name = "RunCancellationError";
  }
}

export interface PlainDagOpExecution {
  /** Zero-based Execution IR op index. */
  readonly op: number;
  readonly operation: ExecutionIrOpV1;
  /** Run-owned cooperative cancellation signal shared by every admitted op. */
  readonly signal: AbortSignal;
}

/**
 * Runtime-owned adapter invoked for one already-admitted plain DAG op.
 *
 * 3.9 adds only cooperative run cancellation through `execution.signal`. Value
 * materialization, model/tool adapters, timeout, and retry remain later layers.
 */
export type PlainDagOpExecutor = (execution: PlainDagOpExecution) => void | Promise<void>;

export interface PlainDagRunSnapshot {
  readonly started: boolean;
  readonly settled: boolean;
  readonly cancelled: boolean;
  readonly readiness: RunReadinessSnapshot;
  readonly concurrency: RunConcurrencySnapshot;
}

function assertPlainExecutableDag(ir: ExecutionIrV1): void {
  ir.ops.forEach((op, index) => {
    if (op.control !== undefined) {
      throw new TypeError(
        `Plain DAG run cannot execute structured-control op ${String(index)} ('${op.control.kind}'); use the later structured-control scheduler.`,
      );
    }
    if (op.behavior.executionMode === "none") {
      throw new TypeError(
        `Plain DAG run cannot execute op ${String(index)} with executionMode 'none'.`,
      );
    }
  });
}

/**
 * First framework-free in-memory DAG execution loop.
 *
 * The run owns exactly one AbortController. Calling `cancel()` stops new dispatch,
 * clears queued/reserved readiness, aborts local/global concurrency waiters, marks
 * every unfinished op cancelled, and propagates the same AbortSignal to running
 * executors. JavaScript work remains cooperative: an executor that ignores its
 * signal may still take time to settle, but it cannot complete or release new DAG
 * dependencies after the run has been cancelled.
 *
 * Executor failure remains distinct from cancellation. The first executor failure
 * still wins the final rejection if it happened before a later user cancellation;
 * cancellation may nevertheless abort already-admitted peers so they can settle.
 */
export class PlainDagRun {
  private readonly readiness: RunReadiness;
  private readonly abortController = new AbortController();
  private readonly activeTasks = new Set<Promise<void>>();
  private started = false;
  private settled = false;
  private hasFailure = false;
  private firstFailure: unknown;

  constructor(
    private readonly ir: ExecutionIrV1,
    private readonly concurrency: RunConcurrency,
    private readonly executor: PlainDagOpExecutor,
  ) {
    assertPlainExecutableDag(ir);
    this.readiness = new RunReadiness(ir);
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  snapshot(): PlainDagRunSnapshot {
    return Object.freeze({
      started: this.started,
      settled: this.settled,
      cancelled: this.signal.aborted,
      readiness: this.readiness.snapshot(),
      concurrency: this.concurrency.snapshot(),
    });
  }

  /**
   * Request cooperative run cancellation exactly once.
   *
   * Returns true only for the first accepted cancellation request. A settled run
   * is immutable and cannot be retroactively cancelled.
   */
  cancel(reason: unknown = new RunCancellationError()): boolean {
    if (this.settled || this.signal.aborted) {
      return false;
    }

    this.readiness.cancelNonTerminalOps();
    this.abortController.abort(reason);
    return true;
  }

  async execute(): Promise<PlainDagRunSnapshot> {
    if (this.started) {
      throw new TypeError("Plain DAG run may be executed only once.");
    }
    this.started = true;

    while (true) {
      this.dispatchAvailableReadyOps();

      if (this.activeTasks.size === 0) {
        break;
      }

      await Promise.race(this.activeTasks);
    }

    this.settled = true;

    if (this.hasFailure) {
      throw this.firstFailure;
    }
    if (this.signal.aborted) {
      throw this.signal.reason;
    }

    const incomplete = this.readiness
      .snapshot()
      .ops.filter((state) => state.status !== "completed")
      .map((state) => state.op);
    if (incomplete.length > 0) {
      throw new TypeError(
        `Plain DAG run stalled with incomplete ops: ${incomplete.map(String).join(", ")}.`,
      );
    }

    return this.snapshot();
  }

  private dispatchAvailableReadyOps(): void {
    while (
      !this.hasFailure &&
      !this.signal.aborted &&
      this.readiness.hasReadyOps() &&
      this.concurrency.activeCount < this.concurrency.limit
    ) {
      const op = this.readiness.dequeueReadyOp();
      if (op === undefined) {
        return;
      }

      const task = this.executeReservedOp(op);
      this.activeTasks.add(task);
      void task.finally(() => {
        this.activeTasks.delete(task);
      });
    }
  }

  private async executeReservedOp(op: number): Promise<void> {
    let permit: ConcurrencyPermit | undefined;

    try {
      permit = await this.concurrency.acquire(this.signal);
      if (this.signal.aborted) {
        return;
      }

      this.readiness.startReservedReadyOp(op);

      const operation = this.ir.ops[op];
      if (operation === undefined) {
        throw new RangeError(`Execution IR op ${String(op)} is unavailable.`);
      }

      await this.executor(Object.freeze({ op, operation, signal: this.signal }));
      if (this.signal.aborted) {
        return;
      }

      this.readiness.completeRunningOp(op);

      for (const targetOp of this.readiness.getDependents(op)) {
        this.readiness.releaseDependency(op, targetOp);
      }
    } catch (error) {
      if (this.signal.aborted) {
        return;
      }

      if (this.readiness.getOpState(op).status === "running") {
        this.readiness.failRunningOp(op);
      }
      if (!this.hasFailure) {
        this.hasFailure = true;
        this.firstFailure = error;
      }
    } finally {
      permit?.release();
    }
  }
}
