import type { DatabaseSync } from "node:sqlite";

import { canonicalRuntimeJson } from "./runtime-redaction.js";
import {
  DURABLE_OP_FRONTIER_EVENT_TYPE,
  type RecoveredControlEdgeFrontier,
  type RecoveredOpFrontier,
  type RecoveredRouterSelection,
} from "./runtime-recovery.js";

/** The frontier a checkpoint captures: every op state, plus control progress. */
export interface FrontierCheckpointSnapshot {
  readonly runId: string;
  readonly ops: readonly RecoveredOpFrontier[];
  readonly controlEdges: readonly RecoveredControlEdgeFrontier[];
  readonly routerSelections: readonly RecoveredRouterSelection[];
}

/**
 * Write a complete quiescent snapshot using the existing v5 sparse-frontier representation.
 *
 * Every op state is journaled first, so the checkpoint's cursor is an event of this
 * run. Unresolved control edges are the default and are not stored. Returns the new
 * checkpoint id.
 */
export function writeFrontierCheckpoint(
  connection: DatabaseSync,
  snapshot: FrontierCheckpointSnapshot,
  now: number,
): number {
  const insertEvent = connection.prepare(
    `INSERT INTO durable_events (
      run_id, event_type, event_schema_version, op_index, iteration, attempt,
      occurred_at_ms, payload_json
    ) VALUES (?, ?, 1, ?, ?, NULL, ?, ?)`,
  );
  let cursor = 0;
  for (const state of snapshot.ops) {
    cursor = Number(
      insertEvent.run(
        snapshot.runId,
        DURABLE_OP_FRONTIER_EVENT_TYPE,
        state.opIndex,
        state.iteration,
        now,
        canonicalRuntimeJson(state),
      ).lastInsertRowid,
    );
  }
  const header = connection
    .prepare(
      `INSERT INTO run_checkpoints (
      run_id, through_event_id, checkpoint_schema_version, created_at_ms
    ) VALUES (?, ?, 1, ?)`,
    )
    .run(snapshot.runId, cursor, now);
  const checkpointId = Number(header.lastInsertRowid);
  const insertOp = connection.prepare(`INSERT INTO checkpoint_op_frontier (
    checkpoint_id, op_index, iteration, status, remaining_dependencies, attempts_started,
    attempt_budget_used, ready_order, retry_not_before_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const state of snapshot.ops) {
    insertOp.run(
      checkpointId,
      state.opIndex,
      state.iteration,
      state.status,
      state.remainingDependencies,
      state.attemptsStarted,
      state.attemptBudgetUsed,
      state.readyOrder,
      state.retryNotBeforeMs,
    );
  }
  const insertEdge = connection.prepare(`INSERT INTO checkpoint_control_edges
    (checkpoint_id, edge_index, iteration, status) VALUES (?, ?, ?, ?)`);
  for (const edge of snapshot.controlEdges) {
    if (edge.status !== "unresolved") {
      insertEdge.run(checkpointId, edge.edgeIndex, edge.iteration, edge.status);
    }
  }
  // Branch choices made before this cursor are only recoverable from the checkpoint.
  const insertSelection = connection.prepare(`INSERT INTO checkpoint_router_selections
    (checkpoint_id, router_op_index, iteration, branch) VALUES (?, ?, ?, ?)`);
  for (const selection of snapshot.routerSelections) {
    insertSelection.run(
      checkpointId,
      selection.routerOpIndex,
      selection.iteration,
      selection.branch,
    );
  }
  return checkpointId;
}
