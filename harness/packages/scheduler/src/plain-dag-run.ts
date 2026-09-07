import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import type { ConcurrencyPermit, RunConcurrency, RunConcurrencySnapshot } from "./concurrency.js";
import { RunReadiness, type RunReadinessSnapshot } from "./run-readiness.js";

const MAX_NATIVE_TIMER_MS = 2_147_483_647;

export class RunCancellationError extends Error {
  readonly code = "RUN_CANCELLED" as const;

  constructor(message = "Plain DAG run cancelled.") {
    super(message);
    this.name = "RunCancellationError";
  }
}

export class NodeTimeoutError extends Error {
  readonly code = "NODE_TIMEOUT" as const;

  constructor(
    readonly op: number,
    readonly timeoutMs: number,
  ) {
    super(`Run op ${String(op)} timed out after ${String(timeoutMs)} ms.`);
    this.name = "NodeTimeoutError";
  }
}

export interface PlainDagOpExecution {
  /** Zero-based Execution IR op index. */
  readonly op: number;
  readonly operation: ExecutionIrOpV1;
  /** Run cancellation plus the current op's timeout, when configured. */
  readonly signal: AbortSignal;
}

/** Runtime-owned adapter invoked for one already-admitted plain DAG op. */
export type PlainDagOpExecutor = (execution: PlainDagOpExecution) => void | Promise<void>;

export interface PlainDagRunSnapshot {
  readonly started: boolean;
  readonly settled: boolean;
  readonly cancelled: boolean;
  readonly readiness: RunReadinessSnapshot;
  readonly concurrency: RunConcurrencySnapshot;
}

function assertPositiveTimeoutMs(op: number, timeoutMs: number | undefined): void {
  if (timeoutMs === undefined) {
    return;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError(`Run op ${String(op)} timeoutMs must be a positive safe integer.`);
  }
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
    assertPositiveTimeoutMs(index, op.behavior.timeoutMs);
  });
}

/**
 * Schedule a timeout without relying on Node's single-timer 32-bit delay ceiling.
 * The returned cleanup is idempotent and prevents any future callback.
 */
function scheduleTimeout(timeoutMs: number, onTimeout: () => void): () => void {
  let remaining = timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const scheduleNext = (): void => {
    const delay = Math.min(remaining, MAX_NATIVE_TIMER_MS);
    timer = setTimeout(() => {
      if (cancelled) {
        return;
      }

      remaining -= delay;
      if (remaining > 0) {
        scheduleNext();
        return;
      }

      onTimeout();
    }, delay);
  };

  scheduleNext();

  return (): void => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
}

/**
 * Framework-free in-memory DAG execution loop.
 *
 * 3.9 supplies run-wide cooperative cancellation. 3.10 layers an independent
 * per-op timeout over that run signal. A timeout aborts only the timed op's
 * executor signal, marks that op failed, releases no downstream dependency, and
 * becomes the run's first failure. It never aborts the run controller and does
 * not schedule a retry; retry policy remains 3.11.
 *
 * In-process JavaScript cannot be forcibly preempted. If an executor ignores its
 * timeout signal, the scheduler may reject the run at the deadline but keeps that
 * executor's concurrency permit until its Promise actually settles. This prevents
 * uncooperative timed-out work from silently exceeding the global/run limits.
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

  /** Request cooperative run cancellation exactly once. */
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

      const timeoutMs = operation.behavior.timeoutMs;
      if (timeoutMs === undefined) {
        await this.executor(Object.freeze({ op, operation, signal: this.signal }));
      } else {
        const timeoutController = new AbortController();
        const timeoutError = new NodeTimeoutError(op, timeoutMs);
        let timedOut = false;
        let timeoutReject!: (reason: Error) => void;

        const onRunAbort = (): void => {
          timeoutController.abort(this.signal.reason);
        };
        if (this.signal.aborted) {
          onRunAbort();
        } else {
          this.signal.addEventListener("abort", onRunAbort, { once: true });
        }

        const executorPromise = Promise.resolve().then(() =>
          this.executor(
            Object.freeze({
              op,
              operation,
              signal: timeoutController.signal,
            }),
          ),
        );
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeoutReject = reject;
        });
        const cancelTimer = scheduleTimeout(timeoutMs, () => {
          if (timeoutController.signal.aborted) {
            return;
          }
          timedOut = true;
          timeoutController.abort(timeoutError);
          timeoutReject(timeoutError);
        });

        try {
          await Promise.race([executorPromise, timeoutPromise]);
        } catch (error) {
          if (timedOut) {
            // A timed-out in-process executor may ignore its signal. Keep its
            // concurrency ownership until the underlying Promise actually settles.
            const heldPermit = permit;
            permit = undefined;
            if (heldPermit !== undefined) {
              void executorPromise.then(
                () => heldPermit.release(),
                () => heldPermit.release(),
              );
            }
          }
          throw error;
        } finally {
          cancelTimer();
          this.signal.removeEventListener("abort", onRunAbort);
        }
      }

      if (this.signal.aborted) {
        return;
      }

      this.readiness.completeRunningOp(op);

      for (const targetOp of this.readiness.getDependents(op)) {
        this.readiness.releaseDependency(op, targetOp);
      }
    } catch (error) {
      if (error instanceof NodeTimeoutError && error.op === op) {
        if (this.readiness.getOpState(op).status === "running") {
          this.readiness.failRunningOp(op);
        }
        if (!this.hasFailure) {
          this.hasFailure = true;
          this.firstFailure = error;
        }
        return;
      }

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
