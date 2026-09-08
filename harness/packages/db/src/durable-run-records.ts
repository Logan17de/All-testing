import { GRAPH_COMPILATIONS_TABLE } from "./durable-identity-records.js";
import type { SqliteMigration } from "./migrations.js";

export const RUNS_TABLE = "runs" as const;

export type DurableRunStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Durable identity/current-state record for one scheduler run.
 *
 * `documentHash + compiledPlanId` binds the run to an exact compatible
 * source-to-plan association created by 4.7. `parentRunId` expresses lineage
 * only; it deliberately does not require the child to reuse the parent's plan.
 * Future checkpoint/fork logic may therefore define compatibility without this
 * storage layer guessing checkpoint identity early.
 */
export interface DurableRunRecord {
  readonly runId: string;
  readonly documentHash: string;
  readonly compiledPlanId: number;
  readonly status: DurableRunStatus;
  readonly parentRunId: string | null;
  readonly forkMetadataJson: string | null;
  readonly createdAtMs: number;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
}

/**
 * Add durable run identity and parent/fork lineage.
 *
 * Fork metadata remains opaque nullable JSON text at this layer. 4.11 owns the
 * checkpoint schema, so this migration intentionally does not invent or weakly
 * reference a checkpoint identifier before that contract exists.
 */
export const DURABLE_RUNS_MIGRATION: SqliteMigration = Object.freeze({
  version: 2,
  name: "durable_runs_and_fork_lineage",
  sql: `
CREATE TABLE ${RUNS_TABLE} (
  run_id TEXT PRIMARY KEY CHECK (length(run_id) > 0),
  document_hash TEXT NOT NULL,
  compiled_plan_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'waiting', 'completed', 'failed', 'cancelled')
  ),
  parent_run_id TEXT,
  fork_metadata_json TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  started_at_ms INTEGER CHECK (started_at_ms IS NULL OR started_at_ms >= 0),
  finished_at_ms INTEGER CHECK (finished_at_ms IS NULL OR finished_at_ms >= 0),
  CHECK (started_at_ms IS NULL OR started_at_ms >= created_at_ms),
  CHECK (finished_at_ms IS NULL OR finished_at_ms >= created_at_ms),
  CHECK (started_at_ms IS NULL OR finished_at_ms IS NULL OR finished_at_ms >= started_at_ms),
  CHECK (parent_run_id IS NULL OR parent_run_id <> run_id),
  CHECK (parent_run_id IS NOT NULL OR fork_metadata_json IS NULL),
  CHECK (fork_metadata_json IS NULL OR length(fork_metadata_json) > 0),
  FOREIGN KEY (document_hash, compiled_plan_id)
    REFERENCES ${GRAPH_COMPILATIONS_TABLE}(document_hash, compiled_plan_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (parent_run_id)
    REFERENCES ${RUNS_TABLE}(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX runs_parent_run_id_idx
ON ${RUNS_TABLE}(parent_run_id)
WHERE parent_run_id IS NOT NULL;
`,
});
