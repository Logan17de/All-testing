import type { DatabaseSync } from "node:sqlite";

import { commitDurableNodeCompletion, type SqliteDatabase } from "@zet-harness/db";
import { generateLogicalEffectId } from "@zet-harness/db/durable-node-invocation";
import type { ExecutionIrV1 } from "@zet-harness/graph";
import {
  InvocationPermissionDeniedError,
  PlainDagRun,
  SchedulerConcurrency,
  type PlainDagAttemptFailureContext,
  type PlainDagOpExecution,
  type PlainDagRestoreState,
  type PlainDagRunOptions,
} from "@zet-harness/scheduler";

import type { RuntimeHumanApprovals, RuntimeApprovalAuthority } from "./runtime-human-approvals.js";
import {
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
      op === null ? null : 0,
      attempt,
      Date.now(),
      canonicalRuntimeJson(payload),
    );
}

function publishOp(connection: DatabaseSync, runId: string, state: RecoveredOpFrontier): void {
  event(connection, runId, "harness.frontier.op", state, state.opIndex);
}

function plan(frontier: RecoveredExecutionFrontier): ExecutionIrV1 {
  // This is persisted compiler output, not a new source-validation path. Runtime
  // checks below concern supported execution/recovery states only.
  const ir = freeze(structuredClone(frontier.executionIr)) as unknown as ExecutionIrV1;
  if (
    ir.ops.some((op) => op.control !== undefined) ||
    frontier.ops.some((op) => op.iteration !== 0)
  ) {
    throw new TypeError("Durable dispatch currently requires an iteration-zero plain DAG.");
  }
  return ir;
}

function restore(frontier: RecoveredExecutionFrontier): PlainDagRestoreState {
  const now = Date.now();
  return {
    readiness: {
      ops: frontier.ops.map((op) => ({ op: op.opIndex, status: op.status })),
      remainingDependencies: frontier.ops.map((op) => op.remainingDependencies),
      readyQueue: frontier.readyQueue.map((op) => op.opIndex),
    },
    attempts: frontier.ops.map((op) => op.attemptsStarted),
    attemptBudgetUsed: frontier.ops.map((op) => op.attemptBudgetUsed),
    retryDelaysMs: frontier.ops.map((op) =>
      op.retryNotBeforeMs === null ? null : Math.max(0, op.retryNotBeforeMs - now),
    ),
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
    if (
      frontier.preCrashRunningAttempts.length > 0 ||
      frontier.ops.some((op) => op.status === "running")
    ) {
      return { runId, status: "recovery-required", code: "RUNTIME_RECOVERY_REQUIRED" };
    }
    if (frontier.ops.some((op) => op.status === "waiting")) return { runId, status: "waiting" };
    if (frontier.ops.some((op) => op.status === "failed")) {
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
              inputs: this.inputs(runId, execution),
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
        ...(this.#authority === undefined ? {} : { capabilityAuthority: this.#authority }),
        ...(this.#options.retry === undefined ? {} : { retry: this.#options.retry }),
        ...(this.#options.effectRetry === undefined
          ? {}
          : { effectRetry: this.#options.effectRetry }),
        durability: {
          beforeAttempt: async ({ op, attempt }) => {
            const id = await critical(this.beginAttempt(runId, op, attempt, used(op)));
            effectIds.set(op, id);
          },
          attemptFailed: async (context) => {
            await critical(this.failAttempt(runId, context));
          },
          suspend: async ({ op, operation }) => {
            await critical(
              this.#approvals.suspend({ runId, opIndex: op, request: operation.config }),
            );
          },
        },
        completionBarrier: async ({ op, attempt }) => {
          const result = outputs.get(op);
          if (result === undefined)
            throw new TypeError("Successful executor has no prepared outputs.");
          await critical(this.completeAttempt(runId, op, attempt, used(op), result));
          outputs.delete(op);
        },
      },
    );
    this.#runs.set(runId, run);
    if (this.#stopping) run.pause();
    try {
      const snapshot = await run.execute();
      const recovered = reconstructExecutionFrontier(this.#database.connection(), runId);
      if (recovered.ops.every((op) => op.status === "completed")) {
        await this.terminalize(runId, "completed");
        return { runId, status: "completed" };
      }
      return {
        runId,
        status:
          snapshot.suspended && !recovered.ops.some((op) => op.status === "waiting")
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

  private beginAttempt(runId: string, op: number, attempt: number, used: number): Promise<string> {
    return this.#database.commit((connection) => {
      const frontier = reconstructExecutionFrontier(connection, runId);
      const state = frontier.ops[op];
      if (
        frontier.runStatus !== "running" ||
        state === undefined ||
        !["ready", "retry-wait"].includes(state.status) ||
        state.attemptsStarted !== attempt - 1 ||
        state.attemptBudgetUsed !== used - 1 ||
        (state.retryNotBeforeMs !== null && state.retryNotBeforeMs > Date.now())
      ) {
        throw new TypeError("Durable attempt admission conflicts with the current frontier.");
      }
      const previous = connection
        .prepare(
          "SELECT logical_effect_id AS id FROM node_invocations WHERE run_id = ? AND op_index = ? AND iteration = 0",
        )
        .get(runId, op) as { readonly id: string } | undefined;
      const logicalEffectId = previous?.id ?? generateLogicalEffectId();
      if (previous === undefined)
        connection
          .prepare(
            "INSERT INTO node_invocations (run_id, op_index, iteration, logical_effect_id, created_at_ms) VALUES (?, ?, 0, ?, ?)",
          )
          .run(runId, op, logicalEffectId, Date.now());
      connection
        .prepare(
          `INSERT INTO node_attempts
        (run_id, op_index, iteration, attempt, logical_effect_id, status, input_refs_json, started_at_ms)
        VALUES (?, ?, 0, ?, ?, 'running', '{}', ?)`,
        )
        .run(runId, op, attempt, logicalEffectId, Date.now());
      event(connection, runId, "harness.attempt.started", { logicalEffectId }, op, attempt);
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
      const state = frontier.ops[context.op]!;
      const runningAttempt = state.status === "running";
      if (
        !runningAttempt &&
        !(
          ["ready", "retry-wait"].includes(state.status) &&
          state.attemptsStarted === context.attempt &&
          state.attemptBudgetUsed === context.attemptBudgetUsed
        )
      ) {
        throw new TypeError("Failure does not match the durable attempt.");
      }
      const failure = safeFailure(context.error);
      if (runningAttempt && context.attempt > 0) {
        const result = connection
          .prepare(
            "UPDATE node_attempts SET status = 'failed', error_json = ?, finished_at_ms = ? WHERE run_id = ? AND op_index = ? AND iteration = 0 AND attempt = ? AND status = 'running'",
          )
          .run(canonicalRuntimeJson(failure), Date.now(), runId, context.op, context.attempt);
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
    attempt: number,
    used: number,
    result: { readonly json: string; readonly usage: string | null },
  ): Promise<unknown> {
    return commitDurableNodeCompletion(
      {
        commit: (write) =>
          this.#database.commit((connection) => {
            const frontier = reconstructExecutionFrontier(connection, runId);
            const state = frontier.ops[op]!;
            if (state.status !== "running" || state.attemptsStarted !== attempt)
              throw new TypeError("Completion conflicts with current attempt.");
            const committed = write(connection);
            publishOp(connection, runId, {
              ...state,
              status: "completed",
              attemptBudgetUsed: used,
            });
            let order =
              frontier.ops.reduce((max, item) => Math.max(max, item.readyOrder ?? -1), -1) + 1;
            for (const target of frontier.ops) {
              if (
                target.status !== "pending" ||
                !frontier.executionIr.ops[target.opIndex]!.dependencies.includes(op)
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
        iteration: 0,
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

  private inputs(runId: string, execution: PlainDagOpExecution): RuntimeNodeExecution["inputs"] {
    const bindings = execution.operation.inputs.map((binding) => {
      const source = binding.source;
      let value: unknown;
      switch (source.kind) {
        case "literal":
          value = source.value;
          break;
        case "op-output": {
          const row = this.#database
            .connection()
            .prepare(
              "SELECT output_refs_json AS refs FROM node_attempts WHERE run_id = ? AND op_index = ? AND iteration = 0 AND status = 'completed' ORDER BY attempt DESC LIMIT 1",
            )
            .get(runId, source.op) as { readonly refs: string } | undefined;
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
          const frontier = reconstructExecutionFrontier(this.#database.connection(), runId);
          const input = (frontier.executionIr as unknown as ExecutionIrV1).graphInputs[
            source.input
          ];
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
