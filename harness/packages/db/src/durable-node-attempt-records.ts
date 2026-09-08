import { RUNS_TABLE } from "./durable-run-records.js";
import type { SqliteMigration } from "./migrations.js";

export const NODE_INVOCATIONS_TABLE = "node_invocations" as const;
export const NODE_ATTEMPTS_TABLE = "node_attempts" as const;

export type DurableNodeAttemptStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * One logical node invocation inside a run.
 *
 * `iteration` is zero-based and reserved now so bounded loop execution can land
 * later without changing retry identity. `logicalEffectId` is harness-owned and
 * stable for the full logical invocation; retries must reuse it. Phase 5 decides
 * when/how that identity is exposed as an external idempotency key and whether a
 * particular effect is safe to repeat.
 */
export interface DurableNodeInvocationRecord {
  readonly runId: string;
  readonly opIndex: number;
  readonly iteration: number;
  readonly logicalEffectId: string;
  readonly createdAtMs: number;
}

/**
 * One concrete executor attempt for a logical node invocation.
 *
 * `attempt` is one-based. Scheduler-only states such as `ready`, `waiting`,
 * `retry-wait`, and `skipped` are not executor attempts and therefore do not
 * belong in this table. Input/output refs, errors, and usage remain opaque JSON
 * text at this layer; later blob/event work defines their referenced payloads.
 */
export interface DurableNodeAttemptRecord {
  readonly attemptId: number;
  readonly runId: string;
  readonly opIndex: number;
  readonly iteration: number;
  readonly attempt: number;
  readonly logicalEffectId: string;
  readonly status: DurableNodeAttemptStatus;
  readonly inputRefsJson: string;
  readonly outputRefsJson: string | null;
  readonly errorJson: string | null;
  readonly usageJson: string | null;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
}

/**
 * Add durable logical invocation and concrete node-attempt identity.
 *
 * The separate invocation row makes the retry-stable effect/idempotency identity
 * a relational invariant instead of a caller convention: exactly one
 * `logical_effect_id` belongs to each (run, op, iteration), and every retry row
 * must reference that exact tuple plus ID.
 */
export const DURABLE_NODE_ATTEMPTS_MIGRATION: SqliteMigration = Object.freeze({
  version: 3,
  name: "durable_node_attempts_and_effect_identity",
  sql: `
CREATE TABLE ${NODE_INVOCATIONS_TABLE} (
  run_id TEXT NOT NULL,
  op_index INTEGER NOT NULL CHECK (op_index >= 0),
  iteration INTEGER NOT NULL CHECK (iteration >= 0),
  logical_effect_id TEXT NOT NULL CHECK (length(logical_effect_id) > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (run_id, op_index, iteration),
  UNIQUE (run_id, logical_effect_id),
  UNIQUE (run_id, op_index, iteration, logical_effect_id),
  FOREIGN KEY (run_id)
    REFERENCES ${RUNS_TABLE}(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE ${NODE_ATTEMPTS_TABLE} (
  attempt_id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  op_index INTEGER NOT NULL CHECK (op_index >= 0),
  iteration INTEGER NOT NULL CHECK (iteration >= 0),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  logical_effect_id TEXT NOT NULL CHECK (length(logical_effect_id) > 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  input_refs_json TEXT NOT NULL CHECK (length(input_refs_json) > 0),
  output_refs_json TEXT CHECK (output_refs_json IS NULL OR length(output_refs_json) > 0),
  error_json TEXT CHECK (error_json IS NULL OR length(error_json) > 0),
  usage_json TEXT CHECK (usage_json IS NULL OR length(usage_json) > 0),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  finished_at_ms INTEGER CHECK (finished_at_ms IS NULL OR finished_at_ms >= 0),
  UNIQUE (run_id, op_index, iteration, attempt),
  CHECK (finished_at_ms IS NULL OR finished_at_ms >= started_at_ms),
  CHECK (
    (status = 'running'
      AND finished_at_ms IS NULL
      AND output_refs_json IS NULL
      AND error_json IS NULL)
    OR
    (status = 'completed'
      AND finished_at_ms IS NOT NULL
      AND output_refs_json IS NOT NULL
      AND error_json IS NULL)
    OR
    (status = 'failed'
      AND finished_at_ms IS NOT NULL
      AND output_refs_json IS NULL
      AND error_json IS NOT NULL)
    OR
    (status = 'cancelled'
      AND finished_at_ms IS NOT NULL
      AND output_refs_json IS NULL)
  ),
  FOREIGN KEY (run_id, op_index, iteration, logical_effect_id)
    REFERENCES ${NODE_INVOCATIONS_TABLE}(run_id, op_index, iteration, logical_effect_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX node_attempts_run_status_idx
ON ${NODE_ATTEMPTS_TABLE}(run_id, status);

CREATE INDEX node_attempts_logical_effect_idx
ON ${NODE_ATTEMPTS_TABLE}(run_id, logical_effect_id, attempt);
`,
});
