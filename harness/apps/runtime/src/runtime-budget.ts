import type { DatabaseSync } from "node:sqlite";

import type { ExecutionIrV1 } from "@zet-harness/graph";

export type RuntimeBudget = "node-executions" | "run-wall-time";

/** A run spent one of its hard limits. The run fails; nothing is retried. */
export class RuntimeBudgetExceededError extends Error {
  readonly code = "RUNTIME_BUDGET_EXCEEDED" as const;
  readonly budget: RuntimeBudget;
  readonly limit: number;

  constructor(budget: RuntimeBudget, limit: number) {
    super(
      budget === "node-executions"
        ? `The run used its limit of ${String(limit)} node executions.`
        : `The run passed its wall-time limit of ${String(limit)} ms.`,
    );
    this.name = "RuntimeBudgetExceededError";
    this.budget = budget;
    this.limit = limit;
  }
}

/**
 * Refuse another node attempt once a run's hard limits are spent.
 *
 * Every attempt counts toward `maxNodeExecutions`, across all ops, retries and
 * loop iterations. `maxWallTimeMs` counts from the moment the run started,
 * including time spent waiting for a person. Routers, joins and loop decisions
 * start no attempt, so they are not charged.
 */
export function assertRunBudget(
  connection: DatabaseSync,
  runId: string,
  ir: ExecutionIrV1,
  now: number,
): void {
  const { maxNodeExecutions, maxWallTimeMs } = ir.policies;
  if (maxNodeExecutions !== undefined) {
    const row = connection
      .prepare("SELECT COUNT(*) AS count FROM node_attempts WHERE run_id = ?")
      .get(runId) as { readonly count: number };
    if (row.count >= maxNodeExecutions) {
      throw new RuntimeBudgetExceededError("node-executions", maxNodeExecutions);
    }
  }
  if (maxWallTimeMs !== undefined) {
    const row = connection
      .prepare("SELECT started_at_ms AS startedAtMs FROM runs WHERE run_id = ?")
      .get(runId) as { readonly startedAtMs: number | null } | undefined;
    if (row?.startedAtMs != null && now - row.startedAtMs > maxWallTimeMs) {
      throw new RuntimeBudgetExceededError("run-wall-time", maxWallTimeMs);
    }
  }
}

/**
 * When a loop op started running, from its committed entry event. A fork that carries
 * a running loop over gives it a fresh wall-time window starting at the fork.
 */
export function loopEnteredAtMs(
  connection: DatabaseSync,
  runId: string,
  op: number,
): number | undefined {
  const row = connection
    .prepare(
      `SELECT MIN(occurred_at_ms) AS enteredAtMs,
        (SELECT MAX(occurred_at_ms) FROM durable_events
         WHERE run_id = ? AND event_type = 'harness.run.forked') AS forkedAtMs
       FROM durable_events
       WHERE run_id = ? AND op_index = ? AND event_type = 'harness.loop.entered'`,
    )
    .get(runId, runId, op) as
    { readonly enteredAtMs: number | null; readonly forkedAtMs: number | null } | undefined;
  if (row?.enteredAtMs == null) return undefined;
  return Math.max(row.enteredAtMs, row.forkedAtMs ?? 0);
}
