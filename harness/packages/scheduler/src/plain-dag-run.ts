import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import type { RunConcurrency, RunConcurrencySnapshot } from "./concurrency.js";
import { RunReadiness, type RunReadinessSnapshot } from "./run-readiness.js";

export interface PlainDagOpExecution {
  /** Zero-based Execution IR op index. */
  readonly op: number;
  readonly operation: ExecutionIrOpV1;
}

/**
 * Runtime-owned adapter invoked for one already-admitted plain DAG op.
 *
 * 3.4 deliberately does not define value materialization, model/tool adapters,
 * timeout, retry, or cancellation semantics. Later runtime layers can adapt this
 * boundary to concrete node executors while the scheduler owns ordering only.
 */
export type PlainDagOpExecutor = (
  execution: PlainDagOpExecution,
) => void | Promise<void>;

export interface PlainDagRunSnapshot {
  readonly started: boolean;
  readonly settled: boolean;
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
 * 3.4 owns only the plain DAG subset: dequeue FIFO-ready ops, acquire the frozen
 * 3.3 run/global concurrency admission, transition ready→running→completed, and
 * release every ordinary predecessor relation after successful completion.
 * Independent ready branches therefore overlap naturally up to the concurrency
 * limits. Structured router/join activation is rejected here and lands in 3.5+
 * rather than being accidentally treated as ordinary completion fan-out.
 *
 * Executor failure marks only that op failed, releases no downstream dependency,
 * stops new dispatch, lets already-admitted peers settle, and rejects the run
 * with the original error. Downstream failure propagation is intentionally not
 * claimed until its dedicated later scheduler coverage.
 */
export class PlainDagRun {
  private readonly readiness: RunReadiness;
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

  snapshot(): PlainDagRunSnapshot {
    return Object.freeze({
      started: this.started,
      settled: this.settled,
      readiness: this.readiness.snapshot(),
      concurrency: this.concurrency.snapshot(),
    });
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
    let permit;

    try {
      permit = await this.concurrency.acquire();
      this.readiness.startReservedReadyOp(op);

      const operation = this.ir.ops[op];
      if (operation === undefined) {
        throw new RangeError(`Execution IR op ${String(op)} is unavailable.`);
      }

      await this.executor(Object.freeze({ op, operation }));
      this.readiness.completeRunningOp(op);

      for (const targetOp of this.readiness.getDependents(op)) {
        this.readiness.releaseDependency(op, targetOp);
      }
    } catch (error) {
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
