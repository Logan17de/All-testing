import type { SqliteMigration } from "./migrations.js";

export const APPROVALS_TABLE = "approvals" as const;
export type DurableApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

/** A human decision is scoped to one immutable plan and logical invocation, never a grant. */
export interface DurableApprovalRecord {
  readonly approvalId: string;
  readonly runId: string;
  readonly compiledPlanId: number;
  readonly opIndex: number;
  readonly iteration: number;
  readonly logicalEffectId: string;
  readonly checkpointId: number;
  readonly status: DurableApprovalStatus;
  readonly requestJson: string;
  readonly responseJson: string | null;
  readonly createdAtMs: number;
  readonly expiresAtMs: number | null;
  readonly resolvedAtMs: number | null;
}

/** Append new migrations; never edit the already-shipped v1-v5 schemas. */
export const DURABLE_APPROVALS_MIGRATION: SqliteMigration = Object.freeze({
  version: 6,
  name: "durable_human_approvals",
  sql: `
CREATE UNIQUE INDEX runs_plan_identity_idx ON runs(run_id, compiled_plan_id);
CREATE UNIQUE INDEX checkpoints_run_identity_idx ON run_checkpoints(run_id, checkpoint_id);

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY CHECK (length(approval_id) > 0),
  run_id TEXT NOT NULL,
  compiled_plan_id INTEGER NOT NULL,
  op_index INTEGER NOT NULL CHECK (op_index >= 0),
  iteration INTEGER NOT NULL CHECK (iteration >= 0),
  logical_effect_id TEXT NOT NULL,
  checkpoint_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  resume_token_hash TEXT NOT NULL UNIQUE CHECK (length(resume_token_hash) = 64),
  response_hash TEXT CHECK (response_hash IS NULL OR length(response_hash) = 64),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms > created_at_ms),
  resolved_at_ms INTEGER CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= created_at_ms),
  UNIQUE (run_id, op_index, iteration),
  CHECK (
    (status = 'pending' AND response_hash IS NULL AND response_json IS NULL
      AND resolved_at_ms IS NULL)
    OR
    (status <> 'pending' AND response_hash IS NOT NULL AND response_json IS NOT NULL
      AND resolved_at_ms IS NOT NULL)
  ),
  FOREIGN KEY (run_id, compiled_plan_id)
    REFERENCES runs(run_id, compiled_plan_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (run_id, op_index, iteration, logical_effect_id)
    REFERENCES node_invocations(run_id, op_index, iteration, logical_effect_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (run_id, checkpoint_id)
    REFERENCES run_checkpoints(run_id, checkpoint_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX approvals_pending_idx ON approvals(status, created_at_ms, approval_id);

CREATE TRIGGER approvals_preserve_identity
BEFORE UPDATE ON approvals
WHEN OLD.approval_id IS NOT NEW.approval_id
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.compiled_plan_id IS NOT NEW.compiled_plan_id
  OR OLD.op_index IS NOT NEW.op_index
  OR OLD.iteration IS NOT NEW.iteration
  OR OLD.logical_effect_id IS NOT NEW.logical_effect_id
  OR OLD.checkpoint_id IS NOT NEW.checkpoint_id
  OR OLD.request_json IS NOT NEW.request_json
  OR OLD.created_at_ms IS NOT NEW.created_at_ms
  OR OLD.expires_at_ms IS NOT NEW.expires_at_ms
  OR OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'approval identity and resolved decisions are immutable');
END;

CREATE TRIGGER approvals_reject_delete
BEFORE DELETE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals are retained audit records');
END;
`,
});
