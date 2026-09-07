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
  /** One-based scheduler-owned attempt number for this logical op. */
  readonly attempt: number;
  /** Run cancellation plus the current op's timeout, when configured. */
  readonly signal: AbortSignal;
}

/** Runtime-owned adapter invoked for one already-admitted plain DAG op attempt. */
export type PlainDagOpExecutor = (execution: PlainDagOpExecution) => void | Promise<void>;

export interface PlainDagRetryBackoffContext {
  readonly op: number;
  readonly operation: ExecutionIrOpV1;
  readonly error: unknown;
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  /** Static delay copied from IR retry defaults, or zero when omitted. */
  readonly configuredBackoffMs: number;
}

export interface PlainDagRetryJitterContext extends PlainDagRetryBackoffContext {
  /** Delay after the backoff hook and before jitter is applied. */
  readonly backoffMs: number;
}

/**
 * Scheduler-owned delay hooks. Both must return non-negative safe-integer
 * milliseconds. Defaults are deterministic: configured backoff, then no jitter.
 */
export interface PlainDagRetryHooks {
  readonly backoff?: (context: PlainDagRetryBackoffContext) => number;
  readonly jitter?: (context: PlainDagRetryJitterContext) => number;
}

export interface PlainDagRunOptions {
  readonly retry?: PlainDagRetryHooks;
}

export interface PlainDagRunSnapshot {
  readonly started: boolean;
  readonly settled: boolean;
  readonly cancelled: boolean;
  /** Number of scheduler-owned attempts started for each IR op. */
  readonly attempts: readonly number[];
  readonly readiness: RunReadinessSnapshot;
  readonly concurrency: RunConcurrencySnapshot;
}

function frozenCopy<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function assertPositiveTimeoutMs(op: number, timeoutMs: number | undefined): void {
  if (timeoutMs === undefined) {
    return;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError(`Run op ${String(op)} timeoutMs must be a positive safe integer.`);
  }
}

function assertNonNegativeSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
}

function assertRetryPolicy(op: number, operation: ExecutionIrOpV1): void {
  const retry = operation.behavior.retry;
  if (retry === undefined) {
    return;
  }

  if (!Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 1) {
    throw new TypeError(`Run op ${String(op)} retry.maxAttempts must be a positive safe integer.`);
  }
  if (retry.backoffMs !== undefined) {
    assertNonNegativeSafeInteger(`Run op ${String(op)} retry.backoffMs`, retry.backoffMs);
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
    assertRetryPolicy(index, op);
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

/** Wait for a scheduler delay, resolving early and cleaning the timer on run cancellation. */
function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    let cancelTimer = (): void => undefined;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancelTimer();
      signal.removeEventListener("abort", finish);
      resolve();
    };

    cancelTimer = scheduleTimeout(delayMs, finish);
    signal.addEventListener("abort", finish, { once: true });

    if (signal.aborted) {
      finish();
    }
  });
}

/** Wait for an attempt's underlying executor to settle, or stop waiting if the run is cancelled. */
function waitForSettlementOrAbort(settlement: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };

    signal.addEventListener("abort", finish, { once: true });
    void settlement.then(finish, finish);

    if (signal.aborted) {
      finish();
    }
  });
}

/**
 * Framework-free in-memory DAG execution loop.
 *
 * 3.9 supplies run-wide cooperative cancellation. 3.10 layers an independent
 * per-op timeout over that run signal. 3.11 adds scheduler-owned bounded retries:
 * `maxAttempts` counts the initial execution, failed attempts move through
 * running -> retry-wait -> ready, retry wait releases concurrency, and downstream
 * dependencies are released only after eventual completion.
 *
 * Backoff/jitter are runtime hooks rather than hidden randomness. By default the
 * scheduler waits the IR `backoffMs` value unchanged. Hook outputs are validated
 * as non-negative safe-integer milliseconds so tests and future runtimes can
 * inject deterministic exponential/jitter strategies without changing IR v1.
 *
 * In-process JavaScript cannot be forcibly preempted. If a timed-out executor
 * ignores its signal, its permit remains charged until the underlying Promise
 * settles. A retry never becomes ready before that prior attempt settles, so two
 * attempts of the same logical op are never intentionally run concurrently.
 */
export class PlainDagRun {
  private readonly readiness: RunReadiness;
  private readonly abortController = new AbortController();
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly attempts: number[];
  private started = false;
  private settled = false;
  private hasFailure = false;
  private firstFailure: unknown;

  constructor(
    private readonly ir: ExecutionIrV1,
    private readonly concurrency: RunConcurrency,
    private readonly executor: PlainDagOpExecutor,
    private readonly options: PlainDagRunOptions = {},
  ) {
    assertPlainExecutableDag(ir);
    this.readiness = new RunReadiness(ir);
    this.attempts = ir.ops.map(() => 0);
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  snapshot(): PlainDagRunSnapshot {
    return Object.freeze({
      started: this.started,
      settled: this.settled,
      cancelled: this.signal.aborted,
      attempts: frozenCopy(this.attempts),
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
    let priorAttemptSettlement: Promise<void> | undefined;

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

      const attempt = this.startAttempt(op);
      const timeoutMs = operation.behavior.timeoutMs;
      if (timeoutMs === undefined) {
        await this.executor(Object.freeze({ op, operation, attempt, signal: this.signal }));
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
              attempt,
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
            // concurrency ownership until the underlying Promise actually settles,
            // and expose that settlement as a retry barrier for this same op.
            const heldPermit = permit;
            permit = undefined;
            priorAttemptSettlement = executorPromise.then(
              () => heldPermit?.release(),
              () => heldPermit?.release(),
            );
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
      if (this.signal.aborted) {
        return;
      }

      const operation = this.ir.ops[op];
      const current = this.readiness.getOpState(op);
      const failedAttempt = this.attempts[op] ?? 0;
      const maxAttempts = operation?.behavior.retry?.maxAttempts ?? 1;

      if (operation !== undefined && current.status === "running" && failedAttempt < maxAttempts) {
        let retryDelayMs: number;
        try {
          retryDelayMs = this.computeRetryDelay(operation, op, error, failedAttempt, maxAttempts);
        } catch (retryPolicyError) {
          this.readiness.failRunningOp(op);
          this.recordFailure(retryPolicyError);
          return;
        }

        this.readiness.retryRunningOp(op);

        // A normal failed attempt returns capacity immediately. Timed-out attempts
        // transfer permit ownership to `priorAttemptSettlement` above instead.
        permit?.release();
        permit = undefined;

        const waits: Promise<void>[] = [waitForDelay(retryDelayMs, this.signal)];
        if (priorAttemptSettlement !== undefined) {
          waits.push(waitForSettlementOrAbort(priorAttemptSettlement, this.signal));
        }
        await Promise.all(waits);

        if (this.signal.aborted || this.hasFailure) {
          return;
        }
        if (this.readiness.getOpState(op).status === "retry-wait") {
          this.readiness.readyRetryOp(op);
        }
        return;
      }

      if (current.status === "running") {
        this.readiness.failRunningOp(op);
      }
      this.recordFailure(error);
    } finally {
      permit?.release();
    }
  }

  private startAttempt(op: number): number {
    const current = this.attempts[op];
    if (current === undefined) {
      throw new RangeError(`Run op index ${String(op)} is unavailable.`);
    }

    const next = current + 1;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError(`Run op ${String(op)} attempt counter exceeded the safe integer range.`);
    }
    this.attempts[op] = next;
    return next;
  }

  private computeRetryDelay(
    operation: ExecutionIrOpV1,
    op: number,
    error: unknown,
    failedAttempt: number,
    maxAttempts: number,
  ): number {
    const configuredBackoffMs = operation.behavior.retry?.backoffMs ?? 0;
    const backoffContext: PlainDagRetryBackoffContext = Object.freeze({
      op,
      operation,
      error,
      failedAttempt,
      nextAttempt: failedAttempt + 1,
      maxAttempts,
      configuredBackoffMs,
    });

    const backoffMs = this.options.retry?.backoff?.(backoffContext) ?? configuredBackoffMs;
    assertNonNegativeSafeInteger(`Run op ${String(op)} retry backoff hook result`, backoffMs);

    const jitterContext: PlainDagRetryJitterContext = Object.freeze({
      ...backoffContext,
      backoffMs,
    });
    const delayMs = this.options.retry?.jitter?.(jitterContext) ?? backoffMs;
    assertNonNegativeSafeInteger(`Run op ${String(op)} retry jitter hook result`, delayMs);
    return delayMs;
  }

  private recordFailure(error: unknown): void {
    if (!this.hasFailure) {
      this.hasFailure = true;
      this.firstFailure = error;
    }
  }
}
