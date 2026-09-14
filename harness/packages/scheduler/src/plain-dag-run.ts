import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import type { ConcurrencyPermit, RunConcurrency, RunConcurrencySnapshot } from "./concurrency.js";
import type { ControlEdgeRuntimeStatus, RunControlEdgesSnapshot } from "./control-edge-state.js";
import { applyLoopReleaseRules, isLoopOp, loopPlansOf, RunLoopControl } from "./loop-control.js";
import { RunReadiness, type RunReadinessSnapshot } from "./run-readiness.js";
import type { RouterBranchSelection } from "./router-activation.js";
import {
  deriveReleasedDependencies,
  isStructuredControlOp,
  RunStructuredControl,
} from "./structured-control.js";
import {
  assertInvocationPermission,
  InvocationPermissionDeniedError,
} from "./invocation-permission.js";

const MAX_NATIVE_TIMER_MS = 2_147_483_647;
const RETRY_ACCOUNTING_ERRORS = new WeakSet<object>();

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

function retryAccountingError<T extends Error>(error: T): T {
  RETRY_ACCOUNTING_ERRORS.add(error);
  return error;
}

function isRetryAccountingError(error: unknown): boolean {
  return typeof error === "object" && error !== null && RETRY_ACCOUNTING_ERRORS.has(error);
}

/** Runtime repeat-safety requirement derived only from effect/idempotency semantics. */
export type PlainDagEffectRetryRequirement = "safe" | "stable-idempotency-key" | "forbidden";

/**
 * Classify whether repeating one scheduler-visible operation is effect-safe.
 *
 * This is runtime policy, not another behavior validator. The compiler/plugin
 * boundaries own contradictory metadata and malformed retry declarations. The
 * scheduler consumes already-frozen IR defensively and never treats deterministic
 * output, a retry budget, or stable logical effect identity as retry authority.
 */
export function classifyPlainDagEffectRetryRequirement(
  behavior: Pick<ExecutionIrOpV1["behavior"], "effect" | "idempotency">,
): PlainDagEffectRetryRequirement {
  if (behavior.effect === "none" || behavior.effect === "external-read") {
    return "safe";
  }
  if (behavior.idempotency === "idempotent") {
    return "safe";
  }
  if (behavior.idempotency === "idempotency-key") {
    return "stable-idempotency-key";
  }
  return "forbidden";
}

/**
 * Shared attempt budget for one scheduler-owned execution attempt.
 *
 * Starting the scheduler attempt already consumes one budget unit. Runtime
 * adapters must report every additional internal retry against the same budget,
 * so outer retries and adapter retries cannot multiply the IR `maxAttempts` cap.
 */
export interface PlainDagRetryBudget {
  readonly maxAttempts: number;
  /** Whether effect-aware runtime policy permits repeating this logical op. */
  readonly repeatAuthorized: boolean;
  /** Total scheduler attempts plus reported internal retries charged so far. */
  readonly usedAttempts: number;
  /**
   * Additional effect-authorized attempts still available after everything
   * charged so far. This is zero when repeat safety is not authorized even when
   * the static IR maxAttempts ceiling is greater than one.
   */
  readonly remainingAttempts: number;
  /**
   * Charge one or more adapter/executor-internal retries to this logical op.
   * Returns the new total budget usage. `count` defaults to one and may be zero
   * when an adapter forwards aggregate retry metadata unchanged.
   */
  reportInternalRetries(count?: number): number;
}

interface PlainDagRetryBudgetScope {
  readonly budget: PlainDagRetryBudget;
  close(): void;
}

export interface PlainDagOpExecution {
  /** Zero-based Execution IR op index. */
  readonly op: number;
  readonly operation: ExecutionIrOpV1;
  /** One-based scheduler-owned attempt number for this logical op. */
  readonly attempt: number;
  /** Zero-based loop iteration this attempt belongs to; zero outside loop bodies. */
  readonly iteration: number;
  /** Shared outer + internal retry budget for this scheduler attempt. */
  readonly retryBudget: PlainDagRetryBudget;
  /** Run cancellation plus the current op's timeout, when configured. */
  readonly signal: AbortSignal;
}

/** Runtime-owned adapter invoked for one already-admitted plain DAG op attempt. */
export type PlainDagOpExecutor = (execution: PlainDagOpExecution) => void | Promise<void>;

/**
 * Scheduler identity exposed after executor success but before completion.
 *
 * A durable runtime can use this boundary to commit the successful attempt
 * before the scheduler marks the op completed or releases its dependents.
 */
export interface PlainDagCompletionBarrierContext {
  readonly op: number;
  readonly operation: ExecutionIrOpV1;
  readonly attempt: number;
  /** Zero-based loop iteration; zero outside loop bodies. */
  readonly iteration: number;
}

export type PlainDagCompletionBarrier = (
  context: PlainDagCompletionBarrierContext,
) => void | Promise<void>;

export interface PlainDagRetryBackoffContext {
  readonly op: number;
  readonly operation: ExecutionIrOpV1;
  readonly error: unknown;
  /** One-based scheduler-owned attempt that just failed. */
  readonly failedAttempt: number;
  /** One-based scheduler-owned attempt that would run next. */
  readonly nextAttempt: number;
  /** Shared outer + internal attempt ceiling from the IR retry policy. */
  readonly maxAttempts: number;
  /** Shared budget charged before scheduling the next outer attempt. */
  readonly attemptBudgetUsed: number;
  /** Shared budget still available before scheduling the next outer attempt. */
  readonly remainingAttempts: number;
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

/** Runtime proof boundary for a key-backed external write. */
export interface PlainDagIdempotencyKeyRetryContext {
  readonly op: number;
  readonly operation: ExecutionIrOpV1;
}

export interface PlainDagEffectRetryOptions {
  /**
   * Return true only when a stable Harness-owned idempotency key has already been
   * bound to the logical external operation that the executor/integration will
   * repeat. Merely having a persisted logical effect identity is not sufficient.
   * The result is cached for the logical op so retry authority cannot change
   * between scheduler attempts.
   */
  readonly hasBoundIdempotencyKey?: (context: PlainDagIdempotencyKeyRetryContext) => boolean;
}

/** Structural shape intentionally satisfied by the host Core permission policy. */
export interface PlainDagCapabilityAuthorityEvaluation {
  readonly decision: "allow" | "deny";
  readonly denialReason?: "explicitly-denied" | "not-granted";
}

/** Current host-owned capability authority consulted immediately before invocation. */
export interface PlainDagCapabilityAuthority {
  evaluate(
    capability: ExecutionIrOpV1["behavior"]["requiredCapabilities"][number],
  ): PlainDagCapabilityAuthorityEvaluation;
}

/** Host-provided quiescent state reconstructed from the durable journal. */
export interface PlainDagRestoreState {
  readonly readiness: RunReadinessSnapshot;
  readonly attempts: readonly number[];
  readonly attemptBudgetUsed: readonly number[];
  /** Remaining wall-clock backoff per op, null except for retry-wait. */
  readonly retryDelaysMs: readonly (number | null)[];
  /** Committed control-edge states; required when the plan has routers or joins. */
  readonly controlEdges?: readonly ControlEdgeRuntimeStatus[];
  /** Committed router branch choices; required when the plan has routers or joins. */
  readonly routerSelections?: readonly RouterBranchSelection[];
  /** Current iteration of every op; required when the plan has loops. */
  readonly iterations?: readonly number[];
}

export interface PlainDagAttemptFailureContext extends PlainDagCompletionBarrierContext {
  readonly error: unknown;
  readonly attemptBudgetUsed: number;
  /** null means terminal; zero is an authorized immediate retry. */
  readonly retryDelayMs: number | null;
}

export interface PlainDagDurabilityHooks {
  readonly beforeAttempt?: (context: PlainDagCompletionBarrierContext) => void | Promise<void>;
  readonly attemptFailed?: (context: PlainDagAttemptFailureContext) => void | Promise<void>;
  /** Called with no active attempts or retry waits; must persist before resolving. */
  readonly suspend?: (context: {
    readonly op: number;
    readonly operation: ExecutionIrOpV1;
  }) => void | Promise<void>;
  /**
   * Persist a router's branch choice or a join's completion, with every readiness
   * and skip consequence, before the run acts on it.
   */
  readonly controlResolved?: (context: {
    readonly op: number;
    readonly operation: ExecutionIrOpV1;
    readonly branch?: string;
  }) => void | Promise<void>;
  /** Persist that a loop op started running and released its body, before the body runs. */
  readonly loopEntered?: (context: {
    readonly op: number;
    readonly operation: ExecutionIrOpV1;
  }) => void | Promise<void>;
  /**
   * Persist a loop's decision after an iteration finishes, before the run acts on
   * it: `continue` starts the next iteration, `exit` completes the loop.
   */
  readonly loopAdvanced?: (context: {
    readonly op: number;
    readonly operation: ExecutionIrOpV1;
    readonly iteration: number;
    readonly decision: "continue" | "exit";
  }) => void | Promise<void>;
}

export interface PlainDagRouterSelectionContext {
  readonly op: number;
  readonly operation: ExecutionIrOpV1;
  readonly branches: readonly string[];
  readonly signal: AbortSignal;
}

export interface PlainDagLoopDecisionContext {
  readonly op: number;
  readonly operation: ExecutionIrOpV1;
  /** The iteration that just finished, zero-based. */
  readonly iteration: number;
  readonly signal: AbortSignal;
}

export interface PlainDagControlHooks {
  /**
   * Host-owned branch decision for one scheduler-owned router. The branch must be
   * one the router declares; any other answer fails the run rather than guessing.
   */
  readonly selectRouterBranch?: (
    context: PlainDagRouterSelectionContext,
  ) => string | Promise<string>;
  /**
   * Host-owned decision after a loop body finishes an iteration: `true` runs another
   * iteration, `false` leaves the loop. The loop's `maxIterations` ends it regardless.
   */
  readonly continueLoop?: (context: PlainDagLoopDecisionContext) => boolean | Promise<boolean>;
}

export interface PlainDagRunOptions {
  readonly restored?: PlainDagRestoreState;
  readonly durability?: PlainDagDurabilityHooks;
  readonly retry?: PlainDagRetryHooks;
  readonly effectRetry?: PlainDagEffectRetryOptions;
  /**
   * Host-owned authority re-evaluated for every scheduler invocation attempt.
   * Its evaluator and receiver are pinned at construction, not its decisions:
   * later options/method replacement cannot grant authority, while the original
   * evaluator can still observe host-owned revocation state on every attempt.
   * Omission is fail-closed only for ops that actually require capabilities.
   */
  readonly capabilityAuthority?: PlainDagCapabilityAuthority;
  /**
   * Optional post-execution gate that must resolve before completion becomes
   * scheduler-visible. Durable runtimes use this for the atomic completion
   * commit; rejection is terminal and never re-executes the successful node.
   */
  readonly completionBarrier?: PlainDagCompletionBarrier;
  /** Routers need a branch decision and loops a continue decision; joins need none. */
  readonly control?: PlainDagControlHooks;
}

export interface PlainDagRunSnapshot {
  readonly started: boolean;
  readonly settled: boolean;
  readonly cancelled: boolean;
  readonly suspended?: true;
  /** Number of scheduler-owned attempts started for each IR op. */
  readonly attempts: readonly number[];
  /** Scheduler attempts plus adapter/executor-internal retries charged per op. */
  readonly attemptBudgetUsed: readonly number[];
  readonly readiness: RunReadinessSnapshot;
  readonly concurrency: RunConcurrencySnapshot;
  /** Present only for plans with routers or joins. */
  readonly controlEdges?: RunControlEdgesSnapshot;
  readonly routerSelections?: readonly RouterBranchSelection[];
  /** Present only for plans with loops: the current iteration of every op. */
  readonly iterations?: readonly number[];
}

const NO_OPS: ReadonlySet<number> = new Set();

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

function assertPlainExecutableDag(
  ir: ExecutionIrV1,
  humanHandler: boolean,
  routerHandler: boolean,
  loopHandler: boolean,
): void {
  ir.ops.forEach((op, index) => {
    if (op.control?.kind === "router" && !routerHandler) {
      throw new TypeError(
        `Router op ${String(index)} requires a host-owned branch selection hook; branches are never all activated as ordinary fan-out.`,
      );
    }
    if (op.control?.kind === "loop" && !loopHandler) {
      throw new TypeError(
        `Loop op ${String(index)} requires a host-owned continue decision; a body never repeats by default.`,
      );
    }
    if (op.control !== undefined && !isStructuredControlOp(op) && op.control.kind !== "loop") {
      throw new TypeError(
        `Plain DAG run cannot execute structured-control op ${String(index)} ('${op.control.kind}'); use the later structured-control scheduler.`,
      );
    }
    if (
      op.behavior.executionMode === "none" &&
      !isStructuredControlOp(op) &&
      op.control?.kind !== "loop"
    ) {
      throw new TypeError(
        `Plain DAG run cannot execute op ${String(index)} with executionMode 'none'.`,
      );
    }
    if (op.behavior.primitiveFamily === "interrupt" && !humanHandler) {
      throw new TypeError("Human interrupt requires a host-owned durable suspension handler.");
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

function anySignalAborted(signals: readonly AbortSignal[]): boolean {
  return signals.some((signal) => signal.aborted);
}

/** Wait for a scheduler delay, resolving early when any stop signal aborts. */
function waitForDelay(delayMs: number, signals: readonly AbortSignal[]): Promise<void> {
  if (delayMs === 0 || anySignalAborted(signals)) {
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
      for (const signal of signals) {
        signal.removeEventListener("abort", finish);
      }
      resolve();
    };

    cancelTimer = scheduleTimeout(delayMs, finish);
    for (const signal of signals) {
      signal.addEventListener("abort", finish, { once: true });
    }

    if (anySignalAborted(signals)) {
      finish();
    }
  });
}

/** Wait for an attempt's underlying executor to settle, or any stop signal to abort. */
function waitForSettlementOrAbort(
  settlement: Promise<void>,
  signals: readonly AbortSignal[],
): Promise<void> {
  if (anySignalAborted(signals)) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      for (const signal of signals) {
        signal.removeEventListener("abort", finish);
      }
      resolve();
    };

    for (const signal of signals) {
      signal.addEventListener("abort", finish, { once: true });
    }
    void settlement.then(finish, finish);

    if (anySignalAborted(signals)) {
      finish();
    }
  });
}

/**
 * Framework-free in-memory DAG execution loop.
 *
 * 3.9 supplies run-wide cooperative cancellation. 3.10 layers an independent
 * per-op timeout over that run signal. 3.11 adds scheduler-owned bounded retries:
 * failed attempts move through running -> retry-wait -> ready, retry wait releases
 * concurrency, and downstream dependencies are released only after completion.
 * 3.12 makes the IR `maxAttempts` ceiling a shared outer + internal budget. Each
 * scheduler attempt charges one unit, and runtime adapters report their own
 * internal retries through the frozen per-attempt `retryBudget` object. Future
 * adapters can cap provider/SDK retries from `remainingAttempts`, preventing
 * accidental multiplicative retry stacks without adding adapter APIs here.
 * Retry-accounting contract violations are terminal and never schedule another
 * outer retry while preserving their original TypeError/RangeError identity.
 *
 * 5.3 adds effect-aware repeat authorization without changing Graph/IR validation:
 * side-effect-free work, external reads, and idempotent writes can consume the
 * configured retry budget; unknown external writes cannot repeat; key-backed
 * writes require an explicit runtime assertion that a stable idempotency key is
 * bound to the integration operation. The same gate clamps adapter/internal
 * retries, so retry layers cannot bypass effect safety by sharing only a number.
 *
 * 5.7 re-checks each op's frozen required capability demand immediately before
 * every executor attempt. Current host authority is intentionally not cached
 * across attempts, so a revoked capability blocks a retry before it consumes a
 * new scheduler attempt or reaches executor/effect code. Graph deny remains a
 * one-way runtime restriction, while capability-free ops need no authority.
 * 5.8 pins the host-selected evaluator in a private slot. Plugin/model data,
 * retained options, and replaced authority methods cannot select a new grant
 * source after construction. Decisions still come from that evaluator per attempt.
 *
 * Retry waits are liveness tasks, not active execution tasks. They keep the run
 * alive while backoff is pending but never block dispatch of unrelated ready work.
 * Zero-delay retries use an immediate Promise path rather than a timer.
 *
 * Backoff/jitter are runtime hooks rather than hidden randomness. By default the
 * scheduler waits the IR `backoffMs` value unchanged. Hook outputs are validated
 * as non-negative safe-integer milliseconds so tests and future runtimes can
 * inject deterministic exponential/jitter strategies without changing IR v1.
 *
 * 3.17 fail-fast uses a separate internal work-stop signal. The first terminal
 * scheduler failure aborts pending concurrency admissions and retry waits without
 * aborting the public run signal or relabeling the run as user-cancelled. Work
 * already executing remains cooperative and may settle normally.
 *
 * In-process JavaScript cannot be forcibly preempted. If a timed-out executor
 * ignores its signal, its permit remains charged until the underlying Promise
 * settles. A retry never becomes ready before that prior attempt settles, so two
 * attempts of the same logical op are never intentionally run concurrently.
 */
export class PlainDagRun {
  private readonly readiness: RunReadiness;
  private readonly abortController = new AbortController();
  private readonly workStopController = new AbortController();
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly retryWaitTasks = new Set<Promise<void>>();
  private readonly pauseController = new AbortController();
  private suspendedForHuman = false;
  private readonly control: RunStructuredControl | undefined;
  private readonly loops: RunLoopControl | undefined;
  readonly #continueLoop: PlainDagControlHooks["continueLoop"];
  readonly #selectRouterBranch: PlainDagControlHooks["selectRouterBranch"] | undefined;
  readonly #durability: PlainDagDurabilityHooks;
  private readonly initialRetryDelays: readonly (number | null)[];
  private readonly attempts: number[];
  private readonly attemptBudgetUsed: number[];
  private readonly repeatAuthorizations: Array<boolean | undefined>;
  readonly #evaluateCapability: PlainDagCapabilityAuthority["evaluate"] | undefined;
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
    const hooks = options.durability;
    this.#durability = Object.freeze({
      ...(hooks?.beforeAttempt === undefined
        ? {}
        : { beforeAttempt: hooks.beforeAttempt.bind(hooks) }),
      ...(hooks?.attemptFailed === undefined
        ? {}
        : { attemptFailed: hooks.attemptFailed.bind(hooks) }),
      ...(hooks?.suspend === undefined ? {} : { suspend: hooks.suspend.bind(hooks) }),
      ...(hooks?.controlResolved === undefined
        ? {}
        : { controlResolved: hooks.controlResolved.bind(hooks) }),
      ...(hooks?.loopEntered === undefined ? {} : { loopEntered: hooks.loopEntered.bind(hooks) }),
      ...(hooks?.loopAdvanced === undefined
        ? {}
        : { loopAdvanced: hooks.loopAdvanced.bind(hooks) }),
    });
    this.suspendedForHuman =
      options.restored?.readiness.ops.some((op) => op.status === "waiting") ?? false;
    assertPlainExecutableDag(
      ir,
      this.#durability.suspend !== undefined,
      options.control?.selectRouterBranch !== undefined,
      options.control?.continueLoop !== undefined,
    );
    const control = options.control;
    this.#selectRouterBranch = control?.selectRouterBranch?.bind(control);
    this.#continueLoop = control?.continueLoop?.bind(control);
    const authority = options.capabilityAuthority;
    this.#evaluateCapability = authority?.evaluate.bind(authority);
    const restored = options.restored;
    const structured = ir.ops.some(isStructuredControlOp);
    const restoredControl =
      restored?.controlEdges === undefined || restored.routerSelections === undefined
        ? undefined
        : { controlEdges: restored.controlEdges, routerSelections: restored.routerSelections };
    if (structured && restored !== undefined && restoredControl === undefined) {
      // Without committed edge state and branch choices a resumed run would
      // silently forget which branch was taken.
      throw new TypeError(
        "Restoring a run with routers or joins requires its control-edge state and router selections.",
      );
    }
    const loopPlans = loopPlansOf(ir);
    if (loopPlans.length > 0 && restored !== undefined && restored.iterations === undefined) {
      // A resumed loop must know which iteration its body was in.
      throw new TypeError("Restoring a run with loops requires its iteration numbers.");
    }
    let releasedDependencies: readonly (readonly number[])[] | undefined;
    if (restored !== undefined && (structured || loopPlans.length > 0)) {
      const opStatuses = restored.readiness.ops.map(({ status }) => status);
      releasedDependencies =
        structured && restoredControl !== undefined
          ? deriveReleasedDependencies(ir, {
              opStatuses,
              remainingDependencies: restored.readiness.remainingDependencies,
              ...restoredControl,
            })
          : ir.ops.map((operation) =>
              operation.dependencies.filter((source) => opStatuses[source] === "completed"),
            );
      if (loopPlans.length > 0) {
        releasedDependencies = applyLoopReleaseRules(
          ir,
          loopPlans,
          opStatuses,
          releasedDependencies,
        );
      }
    }
    this.readiness = new RunReadiness(ir, restored?.readiness, {
      ...(releasedDependencies === undefined ? {} : { releasedDependencies }),
      runningOps: new Set(
        loopPlans
          .map(({ op }) => op)
          .filter((op) => restored?.readiness.ops[op]?.status === "running"),
      ),
    });
    this.control = structured
      ? new RunStructuredControl(ir, this.readiness, restoredControl)
      : undefined;
    this.loops =
      loopPlans.length === 0
        ? undefined
        : new RunLoopControl(ir, this.readiness, loopPlans, restored?.iterations);
    this.attempts = [...(options.restored?.attempts ?? ir.ops.map(() => 0))];
    this.attemptBudgetUsed = [...(options.restored?.attemptBudgetUsed ?? ir.ops.map(() => 0))];
    this.initialRetryDelays = [...(options.restored?.retryDelaysMs ?? ir.ops.map(() => null))];
    if (
      [this.attempts, this.attemptBudgetUsed, this.initialRetryDelays].some(
        (values) => values.length !== ir.ops.length,
      )
    )
      throw new TypeError("Restored attempt accounting must cover the exact op domain.");
    ir.ops.forEach((operation, op) => {
      const attempts = this.attempts[op]!;
      const used = this.attemptBudgetUsed[op]!;
      const delay = this.initialRetryDelays[op]!;
      const state = this.readiness.getOpState(op).status;
      if (
        !Number.isSafeInteger(attempts) ||
        attempts < 0 ||
        !Number.isSafeInteger(used) ||
        used < attempts ||
        used > (operation.behavior.retry?.maxAttempts ?? 1) ||
        (state === "retry-wait" && attempts < 1) ||
        // Routers and joins complete without an attempt; every other op needs one.
        (state === "completed" && attempts < 1 && !isStructuredControlOp(operation)) ||
        ((state === "pending" || state === "waiting" || state === "skipped") && used !== 0) ||
        (state === "retry-wait" ? delay === null : delay !== null)
      ) {
        throw new TypeError("Invalid restored attempt accounting.");
      }
      if (delay !== null) assertNonNegativeSafeInteger("Restored retry delay", delay);
    });
    this.repeatAuthorizations = ir.ops.map(() => undefined);
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  snapshot(): PlainDagRunSnapshot {
    return Object.freeze({
      started: this.started,
      settled: this.settled,
      cancelled: this.signal.aborted,
      ...(this.pauseController.signal.aborted || this.suspendedForHuman
        ? { suspended: true as const }
        : {}),
      attempts: frozenCopy(this.attempts),
      attemptBudgetUsed: frozenCopy(this.attemptBudgetUsed),
      readiness: this.readiness.snapshot(),
      concurrency: this.concurrency.snapshot(),
      ...(this.control === undefined ? {} : this.control.snapshot()),
      ...(this.loops === undefined ? {} : { iterations: this.loops.snapshot() }),
    });
  }

  /** Stop new dispatch, drain admitted work, and preserve nonterminal state for restart. */
  pause(): boolean {
    if (this.settled || this.pauseController.signal.aborted) return false;
    this.pauseController.abort();
    return true;
  }

  /** Request cooperative run cancellation exactly once. */
  cancel(reason: unknown = new RunCancellationError()): boolean {
    if (this.settled || this.signal.aborted) {
      return false;
    }

    this.readiness.cancelNonTerminalOps();
    this.abortController.abort(reason);
    this.workStopController.abort(reason);
    return true;
  }

  async execute(): Promise<PlainDagRunSnapshot> {
    if (this.started) {
      throw new TypeError("Plain DAG run may be executed only once.");
    }
    this.started = true;
    this.initialRetryDelays.forEach((delay, op) => {
      if (delay !== null) this.scheduleRetryWait(op, delay, undefined);
    });
    // A restart can land after a body finished an iteration but before the loop
    // recorded its decision; take that decision now.
    for (const loopOp of this.loops?.undecidedLoops() ?? []) {
      this.trackTask(this.advanceLoop(loopOp));
    }

    while (true) {
      this.dispatchAvailableReadyOps();

      const livenessTasks = [...this.activeTasks, ...this.retryWaitTasks];
      if (livenessTasks.length === 0) {
        const op = this.readiness.peekReadyOp();
        const operation = op === undefined ? undefined : this.ir.ops[op];
        if (
          !this.hasFailure &&
          !this.signal.aborted &&
          !this.pauseController.signal.aborted &&
          op !== undefined &&
          operation?.behavior.primitiveFamily === "interrupt"
        ) {
          try {
            if (!this.suspendedForHuman) {
              this.assertInvocationCapabilities(op, operation);
              await this.#durability.suspend!({ op, operation });
              // Cancellation may have terminalized readiness while the host committed.
              // A late success/failure must not replace the user's cancellation reason.
              if (!this.signal.aborted) {
                this.readiness.waitReadyOp(op);
                this.suspendedForHuman = true;
              }
            }
          } catch (error) {
            if (!this.signal.aborted) this.recordFailure(error);
          }
        }
        break;
      }

      await Promise.race(livenessTasks);
    }

    this.settled = true;

    if (this.hasFailure) {
      throw this.firstFailure;
    }
    if (this.signal.aborted) {
      throw this.signal.reason;
    }

    if (
      this.pauseController.signal.aborted ||
      this.suspendedForHuman ||
      this.readiness.snapshot().ops.some((op) => op.status === "waiting")
    ) {
      return this.snapshot();
    }

    const incomplete = this.readiness
      .snapshot()
      .ops.filter((state) => state.status !== "completed" && state.status !== "skipped")
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
      !this.pauseController.signal.aborted &&
      !this.suspendedForHuman &&
      this.readiness.hasReadyOps() &&
      this.concurrency.activeCount < this.concurrency.limit
    ) {
      const next = this.readiness.peekReadyOp();
      if (next !== undefined && this.ir.ops[next]?.behavior.primitiveFamily === "interrupt") return;
      const op = this.readiness.dequeueReadyOp();
      if (op === undefined) {
        return;
      }

      const task = isStructuredControlOp(this.ir.ops[op]!)
        ? this.executeControlOp(op)
        : isLoopOp(this.ir, op)
          ? this.enterLoop(op)
          : this.executeReservedOp(op);
      this.activeTasks.add(task);
      void task.finally(() => {
        this.activeTasks.delete(task);
      });
    }
  }

  private async executeReservedOp(op: number): Promise<void> {
    let permit: ConcurrencyPermit | undefined;
    let priorAttemptSettlement: Promise<void> | undefined;
    let repeatAuthorized = false;
    let startBarrierFailed = false;

    try {
      permit = await this.concurrency.acquire(this.workStopController.signal);
      if (this.signal.aborted || this.hasFailure || this.workStopController.signal.aborted) {
        return;
      }

      this.readiness.startReservedReadyOp(op);

      const operation = this.ir.ops[op];
      if (operation === undefined) {
        throw new RangeError(`Execution IR op ${String(op)} is unavailable.`);
      }

      this.assertInvocationCapabilities(op, operation);

      const maxAttempts = operation.behavior.retry?.maxAttempts ?? 1;
      repeatAuthorized = this.resolveRepeatAuthorization(op, operation, maxAttempts);
      if (this.attempts[op]! > 0 && !repeatAuthorized) {
        throw new TypeError("Restored operation is not authorized for repeated execution.");
      }
      const iteration = this.loops?.iterationOf(op) ?? 0;
      const attempt = this.startAttempt(op, maxAttempts);
      try {
        if (this.#durability.beforeAttempt !== undefined) {
          await this.#durability.beforeAttempt({ op, operation, attempt, iteration });
        }
      } catch (error) {
        startBarrierFailed = true;
        throw error;
      }
      // An asynchronous durable admission must not allow an intervening user
      // cancellation to invoke effect code. The admitted record remains available
      // to the host's cancellation/recovery path; no external operation occurred.
      if (this.signal.aborted) return;
      const retryBudgetScope = this.createRetryBudgetScope(op, maxAttempts, repeatAuthorized);

      try {
        const timeoutMs = operation.behavior.timeoutMs;
        if (timeoutMs === undefined) {
          if (this.#durability.beforeAttempt !== undefined)
            this.assertInvocationCapabilities(op, operation);
          await this.executor(
            Object.freeze({
              op,
              operation,
              attempt,
              iteration,
              retryBudget: retryBudgetScope.budget,
              signal: this.signal,
            }),
          );
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

          const executorPromise = Promise.resolve().then(() => {
            this.signal.throwIfAborted();
            this.assertInvocationCapabilities(op, operation);
            return this.executor(
              Object.freeze({
                op,
                operation,
                attempt,
                iteration,
                retryBudget: retryBudgetScope.budget,
                signal: timeoutController.signal,
              }),
            );
          });
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
      } finally {
        // A stale/timed-out executor must never charge retries to a later outer
        // attempt after this scheduler-visible attempt has already terminated.
        retryBudgetScope.close();
      }

      if (this.signal.aborted) {
        return;
      }

      if (this.options.completionBarrier !== undefined) {
        try {
          await this.options.completionBarrier(
            Object.freeze({
              op,
              operation,
              attempt,
              iteration,
            }),
          );
        } catch (error) {
          if (this.signal.aborted) {
            return;
          }
          if (this.readiness.getOpState(op).status === "running") {
            this.readiness.failRunningOp(op);
          }
          this.recordFailure(error);
          return;
        }

        if (this.signal.aborted) {
          return;
        }
      }

      this.readiness.completeRunningOp(op);
      // A body op releases only the rest of its body; work after the loop waits for the exit.
      const withheld = this.loops?.withheldDependents(op) ?? NO_OPS;
      if (this.control === undefined) {
        for (const targetOp of this.readiness.getDependents(op)) {
          if (!withheld.has(targetOp)) this.readiness.releaseDependency(op, targetOp);
        }
      } else {
        this.control.releaseCompletedOp(op, withheld);
      }
      const loopOp = this.loops?.loopOf(op);
      if (loopOp !== undefined && this.loops!.iterationFinished(loopOp)) {
        this.trackTask(this.advanceLoop(loopOp));
      }
    } catch (error) {
      if (this.signal.aborted) {
        return;
      }

      const current = this.readiness.getOpState(op);
      if (startBarrierFailed) {
        if (current.status === "running") this.readiness.failRunningOp(op);
        this.recordFailure(error);
        return;
      }
      if (this.hasFailure && this.workStopController.signal.aborted) {
        if (current.status === "running") {
          if (this.#durability.attemptFailed !== undefined)
            await this.persistAttemptFailure(op, error, null);
          this.readiness.failRunningOp(op);
        }
        return;
      }

      const operation = this.ir.ops[op];
      const failedAttempt = this.attempts[op] ?? 0;
      const attemptBudgetUsed = this.attemptBudgetUsed[op] ?? 0;
      const maxAttempts = operation?.behavior.retry?.maxAttempts ?? 1;

      if (isRetryAccountingError(error) || error instanceof InvocationPermissionDeniedError) {
        if (this.#durability.attemptFailed !== undefined)
          await this.persistAttemptFailure(op, error, null);
        if (current.status === "running") {
          this.readiness.failRunningOp(op);
        }
        this.recordFailure(error);
        return;
      }

      if (
        operation !== undefined &&
        repeatAuthorized &&
        current.status === "running" &&
        attemptBudgetUsed < maxAttempts
      ) {
        let retryDelayMs: number;
        try {
          retryDelayMs = this.computeRetryDelay(
            operation,
            op,
            error,
            failedAttempt,
            attemptBudgetUsed,
            maxAttempts,
          );
        } catch (retryPolicyError) {
          if (this.#durability.attemptFailed !== undefined)
            await this.persistAttemptFailure(op, retryPolicyError, null);
          this.readiness.failRunningOp(op);
          this.recordFailure(retryPolicyError);
          return;
        }

        if (
          this.#durability.attemptFailed !== undefined &&
          !(await this.persistAttemptFailure(op, error, retryDelayMs))
        ) {
          this.readiness.failRunningOp(op);
          return;
        }
        this.readiness.retryRunningOp(op);

        // A normal failed attempt returns capacity immediately. Timed-out attempts
        // transfer permit ownership to `priorAttemptSettlement` above instead.
        permit?.release();
        permit = undefined;

        this.scheduleRetryWait(op, retryDelayMs, priorAttemptSettlement);
        return;
      }

      if (this.#durability.attemptFailed !== undefined)
        await this.persistAttemptFailure(op, error, null);
      if (current.status === "running") {
        this.readiness.failRunningOp(op);
      }
      this.recordFailure(error);
    } finally {
      permit?.release();
    }
  }

  private async persistAttemptFailure(
    op: number,
    error: unknown,
    retryDelayMs: number | null,
  ): Promise<boolean> {
    const operation = this.ir.ops[op]!;
    try {
      await this.#durability.attemptFailed?.({
        op,
        operation,
        error,
        retryDelayMs,
        attempt: this.attempts[op]!,
        iteration: this.loops?.iterationOf(op) ?? 0,
        attemptBudgetUsed: this.attemptBudgetUsed[op]!,
      });
      return true;
    } catch (commitError) {
      this.recordFailure(commitError);
      return false;
    }
  }

  private scheduleRetryWait(
    op: number,
    retryDelayMs: number,
    priorAttemptSettlement: Promise<void> | undefined,
  ): void {
    const task = this.waitForRetry(op, retryDelayMs, priorAttemptSettlement);
    this.retryWaitTasks.add(task);
    void task.finally(() => {
      this.retryWaitTasks.delete(task);
    });
  }

  private async waitForRetry(
    op: number,
    retryDelayMs: number,
    priorAttemptSettlement: Promise<void> | undefined,
  ): Promise<void> {
    const stopSignals = [
      this.signal,
      this.workStopController.signal,
      this.pauseController.signal,
    ] as const;
    const waits: Promise<void>[] = [waitForDelay(retryDelayMs, stopSignals)];
    if (priorAttemptSettlement !== undefined) {
      waits.push(waitForSettlementOrAbort(priorAttemptSettlement, stopSignals));
    }
    await Promise.all(waits);

    if (stopSignals.some((signal) => signal.aborted) || this.hasFailure) return;
    if (this.readiness.getOpState(op).status === "retry-wait") {
      this.readiness.readyRetryOp(op);
    }
  }

  private assertInvocationCapabilities(op: number, operation: ExecutionIrOpV1): void {
    assertInvocationPermission(
      op,
      [...this.ir.policies.capabilities.required, ...operation.behavior.requiredCapabilities],
      this.ir.policies.capabilities.deny,
      this.#evaluateCapability,
    );
  }

  private resolveRepeatAuthorization(
    op: number,
    operation: ExecutionIrOpV1,
    maxAttempts: number,
  ): boolean {
    if (maxAttempts <= 1) {
      return false;
    }

    const cached = this.repeatAuthorizations[op];
    if (cached !== undefined) {
      return cached;
    }

    const requirement = classifyPlainDagEffectRetryRequirement(operation.behavior);
    let authorized: boolean;
    switch (requirement) {
      case "safe":
        authorized = true;
        break;
      case "stable-idempotency-key":
        authorized =
          this.options.effectRetry?.hasBoundIdempotencyKey?.(
            Object.freeze({
              op,
              operation,
            }),
          ) === true;
        break;
      case "forbidden":
        authorized = false;
        break;
    }

    this.repeatAuthorizations[op] = authorized;
    return authorized;
  }

  private startAttempt(op: number, maxAttempts: number): number {
    const current = this.attempts[op];
    const budgetUsed = this.attemptBudgetUsed[op];
    if (current === undefined || budgetUsed === undefined) {
      throw new RangeError(`Run op index ${String(op)} is unavailable.`);
    }

    const next = current + 1;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError(`Run op ${String(op)} attempt counter exceeded the safe integer range.`);
    }
    if (budgetUsed >= maxAttempts) {
      throw new RangeError(
        `Run op ${String(op)} retry budget is exhausted before scheduler attempt ${String(next)}.`,
      );
    }

    this.attempts[op] = next;
    this.attemptBudgetUsed[op] = budgetUsed + 1;
    return next;
  }

  private createRetryBudgetScope(
    op: number,
    maxAttempts: number,
    repeatAuthorized: boolean,
  ): PlainDagRetryBudgetScope {
    let closed = false;

    const readUsedAttempts = (): number => {
      const used = this.attemptBudgetUsed[op];
      if (used === undefined) {
        throw new RangeError(`Run op index ${String(op)} is unavailable.`);
      }
      return used;
    };

    const budget: PlainDagRetryBudget = Object.freeze({
      maxAttempts,
      repeatAuthorized,
      get usedAttempts(): number {
        return readUsedAttempts();
      },
      get remainingAttempts(): number {
        return repeatAuthorized ? maxAttempts - readUsedAttempts() : 0;
      },
      reportInternalRetries: (count = 1): number => {
        if (closed) {
          throw retryAccountingError(
            new TypeError(
              `Run op ${String(op)} retry budget is closed for this scheduler attempt.`,
            ),
          );
        }
        if (!Number.isSafeInteger(count) || count < 0) {
          throw retryAccountingError(
            new TypeError(
              `Run op ${String(op)} internal retry count must be a non-negative safe integer.`,
            ),
          );
        }
        if (count > 0 && !repeatAuthorized) {
          throw retryAccountingError(
            new TypeError(
              `Run op ${String(op)} effect-aware retry policy does not authorize repeated execution.`,
            ),
          );
        }

        const used = readUsedAttempts();
        const remaining = maxAttempts - used;
        if (count > remaining) {
          const attemptLabel = remaining === 1 ? "attempt" : "attempts";
          throw retryAccountingError(
            new RangeError(
              `Run op ${String(op)} reported ${String(count)} internal retries with only ${String(remaining)} ${attemptLabel} remaining in its retry budget.`,
            ),
          );
        }

        const next = used + count;
        this.attemptBudgetUsed[op] = next;
        return next;
      },
    });

    return Object.freeze({
      budget,
      close: (): void => {
        closed = true;
      },
    });
  }

  private computeRetryDelay(
    operation: ExecutionIrOpV1,
    op: number,
    error: unknown,
    failedAttempt: number,
    attemptBudgetUsed: number,
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
      attemptBudgetUsed,
      remainingAttempts: maxAttempts - attemptBudgetUsed,
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

  /**
   * Resolve one dequeued router or join.
   *
   * Both are scheduler-owned: they take no concurrency permit and run no
   * executor. A router's branch comes from the host hook, never from the op, and
   * a durable host commits the decision before the run acts on it.
   */
  private async executeControlOp(op: number): Promise<void> {
    const operation = this.ir.ops[op]!;
    const control = this.control!;
    const halted = (): boolean =>
      this.signal.aborted || this.hasFailure || this.workStopController.signal.aborted;
    try {
      if (operation.control?.kind === "router") {
        const branches = operation.control.branches;
        const branch: unknown = await this.#selectRouterBranch!(
          Object.freeze({ op, operation, branches, signal: this.signal }),
        );
        if (halted()) return;
        if (typeof branch !== "string" || !branches.includes(branch)) {
          throw new TypeError(`Router op ${String(op)} selected a branch it does not declare.`);
        }
        await this.#durability.controlResolved?.(Object.freeze({ op, operation, branch }));
        if (halted()) return;
        control.activateReservedRouter(op, branch);
      } else {
        await this.#durability.controlResolved?.(Object.freeze({ op, operation }));
        if (halted()) return;
        control.completeReservedJoin(op);
      }
    } catch (error) {
      if (!this.signal.aborted) this.recordFailure(error);
    }
  }

  private trackTask(task: Promise<void>): void {
    this.activeTasks.add(task);
    void task.finally(() => {
      this.activeTasks.delete(task);
    });
  }

  /**
   * Start a dequeued loop op. It runs no executor and holds no permit, and it stays
   * running while its body iterates, so nothing after the loop can start early.
   */
  private async enterLoop(op: number): Promise<void> {
    const operation = this.ir.ops[op]!;
    try {
      await this.#durability.loopEntered?.(Object.freeze({ op, operation }));
      if (this.signal.aborted || this.hasFailure || this.workStopController.signal.aborted) {
        return;
      }
      const plan = this.loops!.enter(op);
      this.control?.beginLoopIteration(op, plan.region, plan.control.body);
    } catch (error) {
      if (!this.signal.aborted) this.recordFailure(error);
    }
  }

  /**
   * After a body finishes an iteration, run another or leave the loop.
   *
   * The host decides, unless `maxIterations` is reached, which always exits. A
   * durable host records the decision before the run acts on it. Body ops start
   * each iteration with a fresh attempt count and retry budget.
   */
  private async advanceLoop(op: number): Promise<void> {
    const loops = this.loops!;
    const operation = this.ir.ops[op]!;
    const plan = loops.planFor(op)!;
    const halted = (): boolean =>
      this.signal.aborted || this.hasFailure || this.workStopController.signal.aborted;
    try {
      const iteration = loops.iterationOf(op);
      let decision: "continue" | "exit" = "exit";
      if (iteration + 1 < plan.control.maxIterations) {
        const again: unknown = await this.#continueLoop!(
          Object.freeze({ op, operation, iteration, signal: this.signal }),
        );
        if (halted()) return;
        if (typeof again !== "boolean") {
          throw new TypeError(`Loop op ${String(op)} continue decision must be true or false.`);
        }
        decision = again ? "continue" : "exit";
      }
      await this.#durability.loopAdvanced?.(Object.freeze({ op, operation, iteration, decision }));
      if (halted()) return;
      if (decision === "continue") {
        loops.rearm(op, this.ir);
        for (const member of plan.region) {
          this.attempts[member] = 0;
          this.attemptBudgetUsed[member] = 0;
          this.repeatAuthorizations[member] = undefined;
        }
        this.control?.beginLoopIteration(op, plan.region, plan.control.body);
      } else {
        loops.exit(op);
        this.control?.finishLoop(op, plan.control.body);
      }
    } catch (error) {
      if (!this.signal.aborted) this.recordFailure(error);
    }
  }

  private recordFailure(error: unknown): void {
    if (!this.hasFailure) {
      this.hasFailure = true;
      this.firstFailure = error;
      this.workStopController.abort(error);
    }
  }
}
