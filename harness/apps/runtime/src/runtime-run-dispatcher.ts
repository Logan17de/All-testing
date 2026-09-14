import type { DatabaseSync } from "node:sqlite";

import { commitDurableNodeCompletion, type SqliteDatabase } from "@zet-harness/db";
import { generateLogicalEffectId } from "@zet-harness/db/durable-node-invocation";
import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";
import {
  hasStructuredControl,
  InvocationPermissionDeniedError,
  loopPlansOf,
  PlainDagRun,
  reduceStructuredControlFrontier,
  SchedulerConcurrency,
  type PlainDagAttemptFailureContext,
  type PlainDagOpExecution,
  type PlainDagRestoreState,
  type PlainDagRunOptions,
  type StructuredControlDelta,
} from "@zet-harness/scheduler";

import type { RuntimeHumanApprovals, RuntimeApprovalAuthority } from "./runtime-human-approvals.js";
import { applyControlDelta, controlFrontierOf } from "./runtime-control-frontier.js";
import {
  currentIterations,
  currentOps,
  loopBodyOf,
  nextReadyOrder,
} from "./runtime-iteration-frontier.js";
import {
  DURABLE_CONTROL_EDGE_FRONTIER_EVENT_TYPE,
  DURABLE_ROUTER_SELECTION_EVENT_TYPE,
  reconstructExecutionFrontier,
  type RecoveredExecutionFrontier,
  type RecoveredOpFrontier,
} from "./runtime-recovery.js";
import {
  type RuntimeRedactionRegistry,
  canonicalRuntimeJson,
  type SafeJson,
} from "./runtime-redaction.js";

/** Bindings stay ordered, including repeated ports; the host adapter owns aggregation. */
export interface RuntimeNodeExecution extends PlainDagOpExecution {
  readonly runId: string;
  readonly logicalEffectId: string;
  readonly inputs: readonly { readonly port: string; readonly value: SafeJson }[];
}

export interface RuntimeNodeExecutionResult {
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly usage?: unknown;
}

export interface RuntimeExecutionOptions {
  /** Trusted host adapter. The dispatcher never sends human gates to this function. */
  readonly execute: (
    execution: RuntimeNodeExecution,
  ) => RuntimeNodeExecutionResult | Promise<RuntimeNodeExecutionResult>;
  readonly concurrency?: number;
  readonly retry?: PlainDagRunOptions["retry"];
  readonly effectRetry?: PlainDagRunOptions["effectRetry"];
}

export interface RuntimeDispatchReport {
  readonly runId: string;
  readonly status:
    "completed" | "waiting" | "paused" | "failed" | "recovery-required" | "cancelled";
  readonly code?:
    | "RUNTIME_RECOVERY_REQUIRED"
    | "RUNTIME_DURABILITY_FAILED"
    | "RUNTIME_EXECUTION_FAILED"
    | "PERMISSION_DENIED";
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function event(
  connection: DatabaseSync,
  runId: string,
  type: string,
  payload: unknown,
  op: number | null = null,
  attempt: number | null = null,
  iteration = 0,
): void {
  connection
    .prepare(
      `INSERT INTO durable_events
    (run_id, event_type, event_schema_version, op_index, iteration, attempt, occurred_at_ms, payload_json)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      type,
      op,
      op === null ? null : iteration,
      attempt,
      Date.now(),
      canonicalRuntimeJson(payload),
    );
}

function publishOp(connection: DatabaseSync, runId: string, state: RecoveredOpFrontier): void {
  event(connection, runId, "harness.frontier.op", state, state.opIndex, null, state.iteration);
}

/**
 * Publish the consequences of one committed control transition: edges that
 * finished or were skipped, and ops that became ready or were skipped. The
 * transition's own op is published by the caller, which knows how it finished.
 */
function publishControlDelta(
  connection: DatabaseSync,
  runId: string,
  frontier: RecoveredExecutionFrontier,
  delta: StructuredControlDelta,
  subject: number,
): void {
  const next = applyControlDelta(frontier, delta);
  for (const change of delta.controlEdges) {
    event(connection, runId, DURABLE_CONTROL_EDGE_FRONTIER_EVENT_TYPE, {
      edgeIndex: change.edge,
      iteration: 0,
      status: change.status,
    });
  }
  for (const change of delta.ops) {
    if (change.op !== subject) publishOp(connection, runId, next.ops[change.op]!);
  }
}

function plan(frontier: RecoveredExecutionFrontier): ExecutionIrV1 {
  // This is persisted compiler output, not a new source-validation path. Runtime
  // checks below concern supported execution/recovery states only.
  const ir = freeze(structuredClone(frontier.executionIr)) as unknown as ExecutionIrV1;
  const kinds = new Set(
    ir.ops.flatMap((op) => (op.control === undefined ? [] : [op.control.kind])),
  );
  if ([...kinds].some((kind) => kind !== "router" && kind !== "join" && kind !== "loop")) {
    throw new TypeError("Durable dispatch supports routers, joins and loops only.");
  }
  if (kinds.has("loop") && (kinds.has("router") || kinds.has("join"))) {
    // The durable control reducer does not track loop iterations yet.
    throw new TypeError("Durable dispatch does not yet support loops with routers or joins.");
  }
  if (!kinds.has("loop") && frontier.ops.some((op) => op.iteration !== 0)) {
    throw new TypeError("Only loop bodies may run more than one iteration.");
  }
  return ir;
}

function restore(frontier: RecoveredExecutionFrontier): PlainDagRestoreState {
  const now = Date.now();
  const ops = currentOps(frontier);
  return {
    readiness: {
      ops: ops.map((op) => ({ op: op.opIndex, status: op.status })),
      remainingDependencies: ops.map((op) => op.remainingDependencies),
      readyQueue: frontier.readyQueue
        .filter((entry) => ops[entry.opIndex]?.iteration === entry.iteration)
        .map((entry) => entry.opIndex),
    },
    attempts: ops.map((op) => op.attemptsStarted),
    attemptBudgetUsed: ops.map((op) => op.attemptBudgetUsed),
    retryDelaysMs: ops.map((op) =>
      op.retryNotBeforeMs === null ? null : Math.max(0, op.retryNotBeforeMs - now),
    ),
    controlEdges: frontier.controlEdges.map((edge) => edge.status),
    routerSelections: frontier.routerSelections.map((selection) => ({
      routerOp: selection.routerOpIndex,
      branch: selection.branch,
    })),
    iterations: currentIterations(frontier),
  };
}

function safeFailure(error: unknown): {
  readonly code: "PERMISSION_DENIED" | "RUNTIME_EXECUTION_FAILED";
} {
  return {
    code:
      error instanceof InvocationPermissionDeniedError
        ? "PERMISSION_DENIED"
        : "RUNTIME_EXECUTION_FAILED",
  };
}

/**
 * The existing PlainDagRun remains the only execution scheduler. This host driver
 * binds its lifecycle to SQLite and coalesces wake-ups. No timer lives during a
 * human wait. Unclassified running attempts are held, never blindly replayed.
 */
export class RuntimeRunDispatcher {
  readonly #database: SqliteDatabase;
  readonly #approvals: RuntimeHumanApprovals;
  readonly #redaction: RuntimeRedactionRegistry;
  readonly #options: RuntimeExecutionOptions;
  readonly #authority: RuntimeApprovalAuthority | undefined;
  readonly #concurrency: SchedulerConcurrency;
  readonly #tasks = new Map<string, Promise<RuntimeDispatchReport>>();
  readonly #runs = new Map<string, PlainDagRun>();
  readonly #reports = new Map<string, RuntimeDispatchReport>();
  readonly #dirty = new Set<string>();
  readonly #executors = new Set<Promise<void>>();
  #started = false;
  #stopping = false;

  constructor(
    database: SqliteDatabase,
    approvals: RuntimeHumanApprovals,
    options: RuntimeExecutionOptions,
    redaction: RuntimeRedactionRegistry,
    authority?: RuntimeApprovalAuthority,
  ) {
    this.#database = database;
    this.#approvals = approvals;
    this.#redaction = redaction;
    this.#options = Object.freeze({ ...options });
    // Pin the evaluator once across *all* wake-ups, not merely each scheduler instance.
    const evaluate = authority?.evaluate.bind(authority);
    this.#authority = evaluate === undefined ? undefined : Object.freeze({ evaluate });
    this.#concurrency = new SchedulerConcurrency(options.concurrency ?? 8);
  }

  start(): void {
    if (this.#started || this.#stopping) throw new TypeError("Dispatcher cannot restart.");
    this.#started = true;
    const rows = this.#database
      .connection()
      .prepare(
        "SELECT run_id AS id FROM runs WHERE status IN ('pending', 'running', 'waiting') ORDER BY created_at_ms, run_id",
      )
      .all() as { readonly id: string }[];
    for (const row of rows) this.wake(row.id);
  }

  /** Notifications are hints only: the authoritative ready frontier is always durable. */
  wake(runId: string): void {
    if (!this.#started || this.#stopping) return;
    this.#dirty.add(runId);
    if (this.#tasks.has(runId)) return;
    const task = Promise.resolve()
      .then(async () => {
        let report: RuntimeDispatchReport;
        do {
          this.#dirty.delete(runId);
          report = await this.execute(runId);
          this.#reports.set(runId, report);
        } while (this.#dirty.has(runId) && !this.#stopping);
        return report;
      })
      .catch((): RuntimeDispatchReport => {
        const report: RuntimeDispatchReport = {
          runId,
          status: "recovery-required",
          code: "RUNTIME_DURABILITY_FAILED",
        };
        this.#reports.set(runId, report);
        return report;
      })
      .finally(() => {
        this.#tasks.delete(runId);
        // Covers a notification arriving after the loop's last check but before cleanup.
        if (this.#dirty.has(runId) && !this.#stopping) this.wake(runId);
      });
    this.#tasks.set(runId, task);
  }

  async dispatch(runId: string): Promise<RuntimeDispatchReport> {
    if (!this.#started || this.#stopping) throw new TypeError("Dispatcher is not accepting work.");
    this.wake(runId);
    return this.waitForIdle(runId);
  }

  async waitForIdle(runId: string): Promise<RuntimeDispatchReport> {
    while (this.#tasks.has(runId)) await this.#tasks.get(runId);
    const report = this.#reports.get(runId);
    if (report === undefined) throw new RangeError("Run has not been dispatched.");
    return report;
  }

  async pauseRun(runId: string): Promise<void> {
    this.#runs.get(runId)?.pause();
    const task = this.#tasks.get(runId);
    if (task !== undefined) await task;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#dirty.clear();
    for (const run of this.#runs.values()) run.pause();
    await Promise.all(this.#tasks.values());
    // Timed-out in-process code is cooperative. Never close its DB while it is alive.
    await Promise.allSettled(this.#executors);
    await this.#database.drainWrites();
  }

  private async execute(runId: string): Promise<RuntimeDispatchReport> {
    if (this.#stopping) return { runId, status: "paused" };
    let frontier = reconstructExecutionFrontier(this.#database.connection(), runId);
    if (["completed", "failed", "cancelled"].includes(frontier.runStatus)) {
      return { runId, status: frontier.runStatus as "completed" | "failed" | "cancelled" };
    }
    const loopOps = new Set(
      (frontier.executionIr as unknown as ExecutionIrV1).ops.flatMap((op, index) =>
        op.control?.kind === "loop" ? [index] : [],
      ),
    );
    const latest = currentOps(frontier);
    // A loop op runs, without an attempt of its own, for as long as its body iterates.
    if (
      frontier.preCrashRunningAttempts.length > 0 ||
      latest.some((op) => op.status === "running" && !loopOps.has(op.opIndex))
    ) {
      return { runId, status: "recovery-required", code: "RUNTIME_RECOVERY_REQUIRED" };
    }
    if (latest.some((op) => op.status === "waiting")) return { runId, status: "waiting" };
    if (latest.some((op) => op.status === "failed")) {
      await this.terminalize(runId, "failed");
      return { runId, status: "failed", code: "RUNTIME_EXECUTION_FAILED" };
    }
    const ir = plan(frontier);
    if (frontier.runStatus === "pending") {
      await this.#database.commit((connection) => {
        connection
          .prepare(
            "UPDATE runs SET status = 'running', started_at_ms = ? WHERE run_id = ? AND status = 'pending'",
          )
          .run(Date.now(), runId);
      });
      frontier = reconstructExecutionFrontier(this.#database.connection(), runId);
    }
    const effectIds = new Map<number, string>();
    const outputs = new Map<number, { readonly json: string; readonly usage: string | null }>();
    let durabilityFailed = false;
    const critical = async <T>(work: Promise<T>): Promise<T> => {
      try {
        return await work;
      } catch (error) {
        durabilityFailed = true;
        throw error;
      }
    };
    const used = (op: number): number => run.snapshot().attemptBudgetUsed[op]!;
    const run = new PlainDagRun(
      ir,
      this.#concurrency.createRun(ir),
      async (execution) => {
        const work = (async () => {
          const result = await this.#options.execute(
            Object.freeze({
              ...execution,
              runId,
              logicalEffectId: effectIds.get(execution.op)!,
              inputs: this.inputs(runId, ir, execution),
            }),
          );
          if (execution.signal.aborted) return;
          const safe = JSON.parse(this.#redaction.assertSafe(result.outputs)) as SafeJson;
          if (safe === null || typeof safe !== "object" || Array.isArray(safe))
            throw new TypeError("Node outputs must be an object.");
          const refs: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
          for (const [port, value] of Object.entries(safe)) refs[port] = { kind: "inline", value };
          outputs.set(execution.op, {
            json: canonicalRuntimeJson(refs),
            usage: result.usage === undefined ? null : this.#redaction.assertSafe(result.usage),
          });
        })();
        this.#executors.add(work);
        try {
          await work;
        } finally {
          this.#executors.delete(work);
        }
      },
      {
        restored: restore(frontier),
        control: {
          selectRouterBranch: ({ operation, branches }) =>
            this.routerBranch(runId, ir, operation, branches),
          continueLoop: ({ operation }) => this.loopContinues(runId, ir, operation),
        },
        ...(this.#authority === undefined ? {} : { capabilityAuthority: this.#authority }),
        ...(this.#options.retry === undefined ? {} : { retry: this.#options.retry }),
        ...(this.#options.effectRetry === undefined
          ? {}
          : { effectRetry: this.#options.effectRetry }),
        durability: {
          beforeAttempt: async ({ op, attempt, iteration }) => {
            const id = await critical(this.beginAttempt(runId, op, iteration, attempt, used(op)));
            effectIds.set(op, id);
          },
          attemptFailed: async (context) => {
            await critical(this.failAttempt(runId, context));
          },
          controlResolved: async ({ op, branch }) => {
            await critical(this.resolveControl(runId, op, branch));
          },
          loopEntered: async ({ op }) => {
            await critical(this.enterLoop(runId, op));
          },
          loopAdvanced: async ({ op, iteration, decision }) => {
            await critical(this.advanceLoop(runId, op, iteration, decision));
          },
          suspend: async ({ op, operation }) => {
            await critical(
              this.#approvals.suspend({ runId, opIndex: op, request: operation.config }),
            );
          },
        },
        completionBarrier: async ({ op, attempt, iteration }) => {
          const result = outputs.get(op);
          if (result === undefined)
            throw new TypeError("Successful executor has no prepared outputs.");
          await critical(this.completeAttempt(runId, op, iteration, attempt, used(op), result));
          outputs.delete(op);
        },
      },
    );
    this.#runs.set(runId, run);
    if (this.#stopping) run.pause();
    try {
      const snapshot = await run.execute();
      const recovered = reconstructExecutionFrontier(this.#database.connection(), runId);
      if (
        currentOps(recovered).every((op) => op.status === "completed" || op.status === "skipped")
      ) {
        await this.terminalize(runId, "completed");
        return { runId, status: "completed" };
      }
      return {
        runId,
        status:
          snapshot.suspended && !currentOps(recovered).some((op) => op.status === "waiting")
            ? "paused"
            : "waiting",
      };
    } catch (error) {
      if (durabilityFailed)
        return { runId, status: "recovery-required", code: "RUNTIME_DURABILITY_FAILED" };
      const recovered = reconstructExecutionFrontier(this.#database.connection(), runId);
      if (recovered.preCrashRunningAttempts.length > 0) {
        return { runId, status: "recovery-required", code: "RUNTIME_RECOVERY_REQUIRED" };
      }
      await this.terminalize(runId, "failed");
      return { runId, status: "failed", ...safeFailure(error) };
    } finally {
      this.#runs.delete(runId);
    }
  }

  /** A router follows the branch named by the string on its `branch` input. */
  private routerBranch(
    runId: string,
    ir: ExecutionIrV1,
    operation: ExecutionIrOpV1,
    branches: readonly string[],
  ): string {
    const value = this.inputs(runId, ir, { operation }).find(
      (input) => input.port === "branch",
    )?.value;
    if (typeof value !== "string" || !branches.includes(value)) {
      throw new TypeError(
        `Router '${operation.sourceNodeId}' needs a 'branch' input naming one of: ${branches.join(", ")}.`,
      );
    }
    return value;
  }

  /** Commit a router's branch choice or a join's completion with all of its consequences. */
  private resolveControl(runId: string, op: number, branch: string | undefined): Promise<void> {
    return this.#database.commit((connection) => {
      const frontier = reconstructExecutionFrontier(connection, runId);
      const state = currentOps(frontier)[op];
      if (frontier.runStatus !== "running" || state?.status !== "ready") {
        throw new TypeError("Control resolution conflicts with the current frontier.");
      }
      const delta = reduceStructuredControlFrontier(
        frontier.executionIr as unknown as ExecutionIrV1,
        controlFrontierOf(frontier),
        branch === undefined
          ? { kind: "complete-join", op }
          : { kind: "select-branch", op, branch },
      );
      if (branch !== undefined) {
        event(connection, runId, DURABLE_ROUTER_SELECTION_EVENT_TYPE, { branch }, op);
      }
      publishOp(connection, runId, { ...state, status: "completed", readyOrder: null });
      publishControlDelta(connection, runId, frontier, delta, op);
    });
  }

  /** A loop continues while its `again` input is true; without one it runs to its bound. */
  private loopContinues(runId: string, ir: ExecutionIrV1, operation: ExecutionIrOpV1): boolean {
    const again = this.inputs(runId, ir, { operation }).find((input) => input.port === "again");
    if (again === undefined) return true;
    if (typeof again.value !== "boolean") {
      throw new TypeError(`Loop '${operation.sourceNodeId}' needs a true or false 'again' input.`);
    }
    return again.value;
  }

  /** Commit that a loop op started running and released the start of its body. */
  private enterLoop(runId: string, op: number): Promise<void> {
    return this.#database.commit((connection) => {
      const frontier = reconstructExecutionFrontier(connection, runId);
      const ir = frontier.executionIr as unknown as ExecutionIrV1;
      const ops = currentOps(frontier);
      const state = ops[op];
      const plan = loopPlansOf(ir).find((candidate) => candidate.op === op);
      if (frontier.runStatus !== "running" || state?.status !== "ready" || plan === undefined) {
        throw new TypeError("Loop entry conflicts with the current frontier.");
      }
      publishOp(connection, runId, {
        ...state,
        status: "running",
        attemptsStarted: 1,
        attemptBudgetUsed: 1,
        readyOrder: null,
        retryNotBeforeMs: null,
      });
      let order = nextReadyOrder(frontier);
      for (const target of plan.bodyTargets) {
        const targetState = ops[target]!;
        const remainingDependencies = targetState.remainingDependencies - 1;
        if (targetState.status !== "pending" || remainingDependencies < 0) {
          throw new TypeError("Loop entry conflicts with its body's committed state.");
        }
        publishOp(connection, runId, {
          ...targetState,
          remainingDependencies,
          status: remainingDependencies === 0 ? "ready" : "pending",
          readyOrder: remainingDependencies === 0 ? order++ : null,
        });
      }
    });
  }

  /**
   * Commit a loop's decision once its body finished an iteration: either the next
   * iteration of every body op, or the loop's completion and the work after it.
   */
  private advanceLoop(
    runId: string,
    op: number,
    iteration: number,
    decision: "continue" | "exit",
  ): Promise<void> {
    return this.#database.commit((connection) => {
      const frontier = reconstructExecutionFrontier(connection, runId);
      const ir = frontier.executionIr as unknown as ExecutionIrV1;
      const ops = currentOps(frontier);
      const state = ops[op];
      const plan = loopPlansOf(ir).find((candidate) => candidate.op === op);
      const members =
        plan === undefined ? [] : [...plan.region].sort((left, right) => left - right);
      if (
        frontier.runStatus !== "running" ||
        state?.status !== "running" ||
        plan === undefined ||
        members.some(
          (member) =>
            ops[member]?.iteration !== iteration ||
            !["completed", "skipped"].includes(ops[member].status),
        )
      ) {
        throw new TypeError("Loop decision conflicts with the current frontier.");
      }
      event(
        connection,
        runId,
        "harness.loop.advanced",
        { iteration, decision },
        op,
        null,
        iteration,
      );
      let order = nextReadyOrder(frontier);

      if (decision === "continue") {
        for (const member of members) {
          const remainingDependencies = ir.ops[member]!.dependencies.filter((source) =>
            plan.region.has(source),
          ).length;
          publishOp(connection, runId, {
            opIndex: member,
            iteration: iteration + 1,
            status: remainingDependencies === 0 ? "ready" : "pending",
            remainingDependencies,
            attemptsStarted: 0,
            attemptBudgetUsed: 0,
            readyOrder: remainingDependencies === 0 ? order++ : null,
            retryNotBeforeMs: null,
          });
        }
        return;
      }

      publishOp(connection, runId, { ...state, status: "completed", readyOrder: null });
      for (const target of ops) {
        if (
          target.status !== "pending" ||
          target.opIndex === op ||
          plan.region.has(target.opIndex)
        ) {
          continue;
        }
        const releasedNow = ir.ops[target.opIndex]!.dependencies.filter(
          (source) =>
            source === op || (plan.region.has(source) && ops[source]?.status === "completed"),
        ).length;
        if (releasedNow === 0) continue;
        const remainingDependencies = target.remainingDependencies - releasedNow;
        publishOp(connection, runId, {
          ...target,
          remainingDependencies,
          status: remainingDependencies === 0 ? "ready" : "pending",
          readyOrder: remainingDependencies === 0 ? order++ : null,
        });
      }
    });
  }

  private beginAttempt(
    runId: string,
    op: number,
    iteration: number,
    attempt: number,
    used: number,
  ): Promise<string> {
    return this.#database.commit((connection) => {
      const frontier = reconstructExecutionFrontier(connection, runId);
      const state = currentOps(frontier)[op];
      if (
        frontier.runStatus !== "running" ||
        state === undefined ||
        state.iteration !== iteration ||
        !["ready", "retry-wait"].includes(state.status) ||
        state.attemptsStarted !== attempt - 1 ||
        state.attemptBudgetUsed !== used - 1 ||
        (state.retryNotBeforeMs !== null && state.retryNotBeforeMs > Date.now())
      ) {
        throw new TypeError("Durable attempt admission conflicts with the current frontier.");
      }
      const previous = connection
        .prepare(
          "SELECT logical_effect_id AS id FROM node_invocations WHERE run_id = ? AND op_index = ? AND iteration = ?",
        )
        .get(runId, op, iteration) as { readonly id: string } | undefined;
      const logicalEffectId = previous?.id ?? generateLogicalEffectId();
      if (previous === undefined)
        connection
          .prepare(
            "INSERT INTO node_invocations (run_id, op_index, iteration, logical_effect_id, created_at_ms) VALUES (?, ?, ?, ?, ?)",
          )
          .run(runId, op, iteration, logicalEffectId, Date.now());
      connection
        .prepare(
          `INSERT INTO node_attempts
        (run_id, op_index, iteration, attempt, logical_effect_id, status, input_refs_json, started_at_ms)
        VALUES (?, ?, ?, ?, ?, 'running', '{}', ?)`,
        )
        .run(runId, op, iteration, attempt, logicalEffectId, Date.now());
      event(
        connection,
        runId,
        "harness.attempt.started",
        { logicalEffectId },
        op,
        attempt,
        iteration,
      );
      publishOp(connection, runId, {
        ...state,
        status: "running",
        attemptsStarted: attempt,
        attemptBudgetUsed: used,
        readyOrder: null,
        retryNotBeforeMs: null,
      });
      return logicalEffectId;
    });
  }

  private failAttempt(runId: string, context: PlainDagAttemptFailureContext): Promise<void> {
    return this.#database.commit((connection) => {
      const frontier = reconstructExecutionFrontier(connection, runId);
      const state = currentOps(frontier)[context.op]!;
      const runningAttempt = state.status === "running";
      if (
        state.iteration !== context.iteration ||
        (!runningAttempt &&
          !(
            ["ready", "retry-wait"].includes(state.status) &&
            state.attemptsStarted === context.attempt &&
            state.attemptBudgetUsed === context.attemptBudgetUsed
          ))
      ) {
        throw new TypeError("Failure does not match the durable attempt.");
      }
      const failure = safeFailure(context.error);
      if (runningAttempt && context.attempt > 0) {
        const result = connection
          .prepare(
            "UPDATE node_attempts SET status = 'failed', error_json = ?, finished_at_ms = ? WHERE run_id = ? AND op_index = ? AND iteration = ? AND attempt = ? AND status = 'running'",
          )
          .run(
            canonicalRuntimeJson(failure),
            Date.now(),
            runId,
            context.op,
            context.iteration,
            context.attempt,
          );
        if (result.changes !== 1)
          throw new TypeError("Failure requires exactly one running attempt.");
      }
      event(
        connection,
        runId,
        "harness.attempt.failed",
        failure,
        context.op,
        context.attempt || null,
        context.iteration,
      );
      publishOp(connection, runId, {
        ...state,
        status: context.retryDelayMs === null ? "failed" : "retry-wait",
        attemptsStarted: context.attempt,
        attemptBudgetUsed: context.attemptBudgetUsed,
        readyOrder: null,
        retryNotBeforeMs: context.retryDelayMs === null ? null : Date.now() + context.retryDelayMs,
      });
    });
  }

  private completeAttempt(
    runId: string,
    op: number,
    iteration: number,
    attempt: number,
    used: number,
    result: { readonly json: string; readonly usage: string | null },
  ): Promise<unknown> {
    return commitDurableNodeCompletion(
      {
        commit: (write) =>
          this.#database.commit((connection) => {
            const frontier = reconstructExecutionFrontier(connection, runId);
            const ops = currentOps(frontier);
            const state = ops[op]!;
            if (
              state.status !== "running" ||
              state.iteration !== iteration ||
              state.attemptsStarted !== attempt
            )
              throw new TypeError("Completion conflicts with current attempt.");
            const committed = write(connection);
            publishOp(connection, runId, {
              ...state,
              status: "completed",
              attemptBudgetUsed: used,
            });
            const ir = frontier.executionIr as unknown as ExecutionIrV1;
            if (hasStructuredControl(ir)) {
              publishControlDelta(
                connection,
                runId,
                frontier,
                reduceStructuredControlFrontier(ir, controlFrontierOf(frontier), {
                  kind: "complete",
                  op,
                }),
                op,
              );
              return committed;
            }
            // A body op releases only the rest of its body; the loop's exit releases the rest.
            const body = loopBodyOf(ir, op);
            let order = nextReadyOrder(frontier);
            for (const target of ops) {
              if (
                target.status !== "pending" ||
                !ir.ops[target.opIndex]!.dependencies.includes(op) ||
                (body !== undefined && loopBodyOf(ir, target.opIndex) !== body)
              )
                continue;
              const remainingDependencies = target.remainingDependencies - 1;
              publishOp(connection, runId, {
                ...target,
                remainingDependencies,
                status: remainingDependencies === 0 ? "ready" : "pending",
                readyOrder: remainingDependencies === 0 ? order++ : null,
              });
            }
            return committed;
          }),
      },
      {
        runId,
        opIndex: op,
        iteration,
        attempt,
        outputRefsJson: result.json,
        usageJson: result.usage,
        finishedAtMs: Date.now(),
        terminalEvent: {
          eventType: "harness.attempt.completed",
          eventSchemaVersion: 1,
          occurredAtMs: Date.now(),
          payloadJson: "{}",
        },
      },
    );
  }

  private inputs(
    runId: string,
    ir: ExecutionIrV1,
    execution: {
      readonly operation: ExecutionIrOpV1;
      readonly op?: number;
      readonly iteration?: number;
    },
  ): RuntimeNodeExecution["inputs"] {
    const connection = this.#database.connection();
    const body = execution.op === undefined ? undefined : loopBodyOf(ir, execution.op);
    const bindings = execution.operation.inputs.map((binding) => {
      const source = binding.source;
      let value: unknown;
      switch (source.kind) {
        case "literal":
          value = source.value;
          break;
        case "op-output": {
          // Inside one loop body a value comes from the same iteration. Anywhere else it
          // is the source's latest completed value, such as a body's final iteration.
          const sameIteration = body !== undefined && loopBodyOf(ir, source.op) === body;
          const row = (
            sameIteration
              ? connection
                  .prepare(
                    "SELECT output_refs_json AS refs FROM node_attempts WHERE run_id = ? AND op_index = ? AND iteration = ? AND status = 'completed' ORDER BY attempt DESC LIMIT 1",
                  )
                  .get(runId, source.op, execution.iteration ?? 0)
              : connection
                  .prepare(
                    "SELECT output_refs_json AS refs FROM node_attempts WHERE run_id = ? AND op_index = ? AND status = 'completed' ORDER BY iteration DESC, attempt DESC LIMIT 1",
                  )
                  .get(runId, source.op)
          ) as { readonly refs: string } | undefined;
          const refs =
            row === undefined
              ? undefined
              : (JSON.parse(row.refs) as Record<string, { kind: string; value: SafeJson }>);
          const ref = refs?.[source.port];
          if (ref?.kind !== "inline")
            throw new TypeError("Input requires an available inline committed output.");
          value = ref.value;
          break;
        }
        case "graph-input": {
          const input = ir.graphInputs[source.input];
          if (input?.default === undefined)
            throw new TypeError(
              "A graph input value is required; this dispatcher supports compiled defaults only.",
            );
          value = input.default;
          break;
        }
        case "secret":
          throw new TypeError(
            "Secret bindings require a host secret-aware adapter; material is not exposed as ordinary input.",
          );
      }
      return freeze({
        port: binding.port,
        value: JSON.parse(this.#redaction.assertSafe(value)) as SafeJson,
      });
    });
    return Object.freeze(bindings);
  }

  private terminalize(runId: string, status: "completed" | "failed"): Promise<void> {
    return this.#database.commit((connection) => {
      const changed = connection
        .prepare(
          "UPDATE runs SET status = ?, finished_at_ms = ? WHERE run_id = ? AND status IN ('running', 'waiting')",
        )
        .run(status, Date.now(), runId);
      if (changed.changes === 1) event(connection, runId, `harness.run.${status}`, {});
    });
  }
}
