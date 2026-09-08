import { DURABLE_EVENTS_TABLE } from "./durable-event-records.js";
import type { SqliteMigration } from "./migrations.js";

export const RUN_CHECKPOINTS_TABLE = "run_checkpoints" as const;
export const CHECKPOINT_OP_FRONTIER_TABLE = "checkpoint_op_frontier" as const;
export const CHECKPOINT_CONTROL_EDGES_TABLE = "checkpoint_control_edges" as const;
export const CHECKPOINT_ROUTER_SELECTIONS_TABLE = "checkpoint_router_selections" as const;

export type DurableCheckpointOpStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "skipped"
  | "waiting"
  | "retry-wait"
  | "failed"
  | "cancelled";

export type DurableCheckpointControlEdgeStatus = "active" | "skipped" | "completed";

/** One immutable checkpoint header anchored to an exact durable journal cursor. */
export interface DurableRunCheckpointRecord {
  readonly checkpointId: number;
  readonly runId: string;
  readonly throughEventId: number;
  readonly checkpointSchemaVersion: number;
  readonly createdAtMs: number;
}

/**
 * One changed op/iteration entry in a sparse checkpoint frontier.
 *
 * Checkpoints are patches over a freshly constructed scheduler frontier derived
 * from the run's immutable Execution IR. Unchanged iteration-0 op state is omitted.
 * A stored row is therefore a complete replacement for that op/iteration frontier
 * entry, including retry accounting and deterministic FIFO-ready position.
 */
export interface DurableCheckpointOpFrontierRecord {
  readonly checkpointId: number;
  readonly opIndex: number;
  readonly iteration: number;
  readonly status: DurableCheckpointOpStatus;
  readonly remainingDependencies: number;
  readonly attemptsStarted: number;
  readonly attemptBudgetUsed: number;
  readonly readyOrder: number | null;
  readonly retryNotBeforeMs: number | null;
}

/** One non-default control-edge state; unresolved edges are omitted from v1 checkpoints. */
export interface DurableCheckpointControlEdgeRecord {
  readonly checkpointId: number;
  readonly edgeIndex: number;
  readonly iteration: number;
  readonly status: DurableCheckpointControlEdgeStatus;
}

/** One durable router decision needed when edge state alone cannot recover the branch choice. */
export interface DurableCheckpointRouterSelectionRecord {
  readonly checkpointId: number;
  readonly routerOpIndex: number;
  readonly iteration: number;
  readonly branch: string;
}

/** Add immutable sparse checkpoint/frontier storage. */
export const DURABLE_CHECKPOINTS_MIGRATION: SqliteMigration = Object.freeze({
  version: 5,
  name: "sparse_checkpoint_frontier_state",
  sql: `
CREATE UNIQUE INDEX durable_events_run_event_identity_idx
ON ${DURABLE_EVENTS_TABLE}(run_id, event_id);

CREATE TABLE ${RUN_CHECKPOINTS_TABLE} (
  checkpoint_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  through_event_id INTEGER NOT NULL CHECK (through_event_id >= 1),
  checkpoint_schema_version INTEGER NOT NULL CHECK (checkpoint_schema_version >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (run_id, through_event_id),
  FOREIGN KEY (run_id, through_event_id)
    REFERENCES ${DURABLE_EVENTS_TABLE}(run_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX run_checkpoints_run_cursor_idx
ON ${RUN_CHECKPOINTS_TABLE}(run_id, through_event_id DESC);

CREATE TABLE ${CHECKPOINT_OP_FRONTIER_TABLE} (
  checkpoint_id INTEGER NOT NULL,
  op_index INTEGER NOT NULL CHECK (op_index >= 0),
  iteration INTEGER NOT NULL CHECK (iteration >= 0),
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'ready',
      'running',
      'completed',
      'skipped',
      'waiting',
      'retry-wait',
      'failed',
      'cancelled'
    )
  ),
  remaining_dependencies INTEGER NOT NULL CHECK (remaining_dependencies >= 0),
  attempts_started INTEGER NOT NULL CHECK (attempts_started >= 0),
  attempt_budget_used INTEGER NOT NULL CHECK (
    attempt_budget_used >= 0 AND attempt_budget_used >= attempts_started
  ),
  ready_order INTEGER CHECK (ready_order IS NULL OR ready_order >= 0),
  retry_not_before_ms INTEGER CHECK (retry_not_before_ms IS NULL OR retry_not_before_ms >= 0),
  PRIMARY KEY (checkpoint_id, op_index, iteration),
  CHECK (
    (status = 'ready' AND ready_order IS NOT NULL)
    OR
    (status <> 'ready' AND ready_order IS NULL)
  ),
  CHECK (
    (status = 'retry-wait' AND retry_not_before_ms IS NOT NULL)
    OR
    (status <> 'retry-wait' AND retry_not_before_ms IS NULL)
  ),
  CHECK (
    status IN ('pending', 'skipped', 'cancelled')
    OR remaining_dependencies = 0
  ),
  CHECK (
    status NOT IN ('running', 'retry-wait')
    OR attempts_started >= 1
  ),
  FOREIGN KEY (checkpoint_id)
    REFERENCES ${RUN_CHECKPOINTS_TABLE}(checkpoint_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX checkpoint_op_frontier_ready_order_idx
ON ${CHECKPOINT_OP_FRONTIER_TABLE}(checkpoint_id, ready_order)
WHERE ready_order IS NOT NULL;

CREATE TABLE ${CHECKPOINT_CONTROL_EDGES_TABLE} (
  checkpoint_id INTEGER NOT NULL,
  edge_index INTEGER NOT NULL CHECK (edge_index >= 0),
  iteration INTEGER NOT NULL CHECK (iteration >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'skipped', 'completed')),
  PRIMARY KEY (checkpoint_id, edge_index, iteration),
  FOREIGN KEY (checkpoint_id)
    REFERENCES ${RUN_CHECKPOINTS_TABLE}(checkpoint_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE ${CHECKPOINT_ROUTER_SELECTIONS_TABLE} (
  checkpoint_id INTEGER NOT NULL,
  router_op_index INTEGER NOT NULL CHECK (router_op_index >= 0),
  iteration INTEGER NOT NULL CHECK (iteration >= 0),
  branch TEXT NOT NULL CHECK (length(branch) > 0),
  PRIMARY KEY (checkpoint_id, router_op_index, iteration),
  FOREIGN KEY (checkpoint_id)
    REFERENCES ${RUN_CHECKPOINTS_TABLE}(checkpoint_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER run_checkpoints_reject_update
BEFORE UPDATE ON ${RUN_CHECKPOINTS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'run_checkpoints is append-only');
END;

CREATE TRIGGER run_checkpoints_reject_delete
BEFORE DELETE ON ${RUN_CHECKPOINTS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'run_checkpoints is append-only');
END;

CREATE TRIGGER checkpoint_op_frontier_reject_update
BEFORE UPDATE ON ${CHECKPOINT_OP_FRONTIER_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'checkpoint_op_frontier is append-only');
END;

CREATE TRIGGER checkpoint_op_frontier_reject_delete
BEFORE DELETE ON ${CHECKPOINT_OP_FRONTIER_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'checkpoint_op_frontier is append-only');
END;

CREATE TRIGGER checkpoint_control_edges_reject_update
BEFORE UPDATE ON ${CHECKPOINT_CONTROL_EDGES_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'checkpoint_control_edges is append-only');
END;

CREATE TRIGGER checkpoint_control_edges_reject_delete
BEFORE DELETE ON ${CHECKPOINT_CONTROL_EDGES_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'checkpoint_control_edges is append-only');
END;

CREATE TRIGGER checkpoint_router_selections_reject_update
BEFORE UPDATE ON ${CHECKPOINT_ROUTER_SELECTIONS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'checkpoint_router_selections is append-only');
END;

CREATE TRIGGER checkpoint_router_selections_reject_delete
BEFORE DELETE ON ${CHECKPOINT_ROUTER_SELECTIONS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'checkpoint_router_selections is append-only');
END;
`,
});
