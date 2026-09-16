import type { DatabaseSync } from "node:sqlite";

import type { SqliteDatabase } from "@zet-harness/db";
import { createSortableId } from "@zet-harness/db/sortable-id";
import type { ExecutionIrV1 } from "@zet-harness/graph";

import { writeFrontierCheckpoint } from "./runtime-checkpoints.js";
import { RuntimeGraphError } from "./runtime-graphs.js";
import { canonicalRuntimeJson } from "./runtime-redaction.js";
import {
  DURABLE_ROUTER_SELECTION_EVENT_TYPE,
  reconstructExecutionFrontier,
  type RecoveredOpFrontier,
} from "./runtime-recovery.js";

/** The first event of a fork's own history, right after the history it copied. */
export const RUN_FORKED_EVENT_TYPE = "harness.run.forked" as const;
export const RUN_FORK_METADATA_SCHEMA_VERSION = 1 as const;

const FRONTIER_EVENT_PREFIX = "harness.frontier.";

export interface ForkRunOptions {
  /** Fork from this event of the parent's journal; its latest event when omitted. */
  readonly throughEventId?: number;
  readonly now?: number;
}

/** What a fork records about where it came from, stored as its `fork_metadata_json`. */
export interface RunForkMetadata {
  readonly schemaVersion: typeof RUN_FORK_METADATA_SCHEMA_VERSION;
  readonly parentRunId: string;
  /** The parent event the fork was cut after, moved to the end of the commit it fell in. */
  readonly throughEventId: number;
  /** The parent checkpoint the frontier at the cut was rebuilt from, when there was one. */
  readonly parentCheckpointId: number | null;
  /** The fork's own first checkpoint, holding the frontier it starts from. */
  readonly checkpointId: number;
}

export interface ForkedRun extends RunForkMetadata {
  readonly runId: string;
  /** Op iterations whose recorded results the fork keeps. */
  readonly reused: number;
  /** Op iterations the fork runs again. */
  readonly rerun: number;
}

interface ParentEvent {
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly opIndex: number | null;
  readonly iteration: number | null;
  readonly attempt: number | null;
  readonly occurredAtMs: number;
  readonly payload: string;
}

function stateKey(op: number, iteration: number): string {
  return `${String(op)}:${String(iteration)}`;
}

function invalidPoint(message: string): RuntimeGraphError {
  return new RuntimeGraphError("FORK_POINT_INVALID", message, 422);
}

/**
 * Where to cut the parent's history.
 *
 * A commit journals its own event first and then the frontier changes it caused, so
 * the cut moves past any frontier events that follow it. A fork never starts halfway
 * through a commit, with an upstream node finished but its downstream never released.
 */
function forkPoint(connection: DatabaseSync, runId: string, requested: number | undefined): number {
  if (requested === undefined) {
    const latest = connection
      .prepare("SELECT MAX(event_id) AS id FROM durable_events WHERE run_id = ?")
      .get(runId) as { readonly id: number | null } | undefined;
    return latest?.id ?? 0;
  }

  const found = connection
    .prepare("SELECT 1 AS found FROM durable_events WHERE run_id = ? AND event_id = ?")
    .get(runId, requested);
  if (found === undefined) throw invalidPoint("The fork point is not an event of this run.");

  // A fork's copied history carries no frontier of its own; those points belong to its parent.
  const forked = connection
    .prepare("SELECT MIN(event_id) AS id FROM durable_events WHERE run_id = ? AND event_type = ?")
    .get(runId, RUN_FORKED_EVENT_TYPE) as { readonly id: number | null } | undefined;
  if (forked?.id != null && requested < forked.id) {
    throw invalidPoint(
      "This run is a fork, and points before it was forked belong to its parent. Fork the parent run instead.",
    );
  }

  const end = connection
    .prepare(
      `SELECT MAX(event_id) AS id FROM durable_events
       WHERE run_id = ? AND event_id >= ? AND event_id < COALESCE(
         (SELECT MIN(event_id) FROM durable_events
          WHERE run_id = ? AND event_id > ? AND substr(event_type, 1, ?) <> ?),
         ?)`,
    )
    .get(
      runId,
      requested,
      runId,
      requested,
      FRONTIER_EVENT_PREFIX.length,
      FRONTIER_EVENT_PREFIX,
      Number.MAX_SAFE_INTEGER,
    ) as { readonly id: number | null } | undefined;
  return end?.id ?? requested;
}

function writeFork(
  connection: DatabaseSync,
  parentRunId: string,
  requested: number | undefined,
  now: number,
): ForkedRun {
  const parent = connection
    .prepare(
      "SELECT document_hash AS documentHash, compiled_plan_id AS compiledPlanId FROM runs WHERE run_id = ?",
    )
    .get(parentRunId) as
    { readonly documentHash: string; readonly compiledPlanId: number } | undefined;
  if (parent === undefined) {
    throw new RuntimeGraphError("RUN_NOT_FOUND", "No run exists with this id.", 404);
  }

  const throughEventId = forkPoint(connection, parentRunId, requested);
  const frontier = reconstructExecutionFrontier(connection, parentRunId, { throughEventId });
  const ir = frontier.executionIr as unknown as ExecutionIrV1;
  const loops = new Set(
    ir.ops.flatMap((operation, index) => (operation.control?.kind === "loop" ? [index] : [])),
  );
  const statusAt = new Map(
    frontier.ops.map((state) => [stateKey(state.opIndex, state.iteration), state.status]),
  );

  const reused: RecoveredOpFrontier[] = [];
  let rerun = 0;
  let readyOrder = Math.max(-1, ...frontier.ops.map((state) => state.readyOrder ?? -1)) + 1;
  const ops = frontier.ops.map((state): RecoveredOpFrontier => {
    if (state.status === "completed") reused.push(state);
    if (
      state.status === "completed" ||
      state.status === "skipped" ||
      ((state.status === "pending" || state.status === "ready") && state.attemptsStarted === 0)
    ) {
      return state;
    }
    if (loops.has(state.opIndex)) {
      // A running loop op has no attempt of its own; its body's states carry it on.
      if (state.status === "running") return state;
      throw new RuntimeGraphError(
        "FORK_UNSUPPORTED",
        "A loop that failed or was cancelled cannot be forked yet.",
        422,
      );
    }
    // Unfinished work runs again from the start, with a fresh attempt budget.
    rerun += 1;
    const ready = state.remainingDependencies === 0;
    return {
      ...state,
      status: ready ? "ready" : "pending",
      attemptsStarted: 0,
      attemptBudgetUsed: 0,
      readyOrder: ready ? readyOrder++ : null,
      retryNotBeforeMs: null,
    };
  });
  const reusedKeys = new Set(reused.map((state) => stateKey(state.opIndex, state.iteration)));

  const runId = `run-${createSortableId()}`;
  connection
    .prepare(
      `INSERT INTO runs (run_id, document_hash, compiled_plan_id, status, parent_run_id,
        fork_metadata_json, created_at_ms, started_at_ms, finished_at_ms)
       VALUES (?, ?, ?, 'pending', ?, NULL, ?, NULL, NULL)`,
    )
    .run(runId, parent.documentHash, parent.compiledPlanId, parentRunId, now);

  // Finished work keeps its logical effect ids: the fork reuses those effects, never repeats them.
  const copyInvocation = connection.prepare(
    `INSERT INTO node_invocations (run_id, op_index, iteration, logical_effect_id, created_at_ms)
     SELECT ?, op_index, iteration, logical_effect_id, created_at_ms FROM node_invocations
     WHERE run_id = ? AND op_index = ? AND iteration = ?`,
  );
  const copyAttempts = connection.prepare(
    `INSERT INTO node_attempts (run_id, op_index, iteration, attempt, logical_effect_id, status,
       input_refs_json, output_refs_json, error_json, usage_json, started_at_ms, finished_at_ms)
     SELECT ?, op_index, iteration, attempt, logical_effect_id, status, input_refs_json,
       output_refs_json, error_json, usage_json, started_at_ms, finished_at_ms
     FROM node_attempts
     WHERE run_id = ? AND op_index = ? AND iteration = ? AND status <> 'running'
     ORDER BY attempt`,
  );
  for (const state of reused) {
    copyInvocation.run(runId, parentRunId, state.opIndex, state.iteration);
    copyAttempts.run(runId, parentRunId, state.opIndex, state.iteration);
  }

  const carried = (event: ParentEvent): boolean => {
    // The parent's lifecycle stays with the parent, and the checkpoint below replaces its
    // frontier bookkeeping. Branch choices stay so a replay of the fork still shows them.
    if (event.eventType.startsWith("harness.run.")) return false;
    if (
      event.eventType.startsWith(FRONTIER_EVENT_PREFIX) &&
      event.eventType !== DURABLE_ROUTER_SELECTION_EVENT_TYPE
    ) {
      return false;
    }
    if (event.opIndex === null) return true;
    if (loops.has(event.opIndex)) {
      const loop = statusAt.get(stateKey(event.opIndex, 0));
      return loop === "running" || loop === "completed";
    }
    return reusedKeys.has(stateKey(event.opIndex, event.iteration ?? 0));
  };
  const insertEvent = connection.prepare(
    `INSERT INTO durable_events (run_id, event_type, event_schema_version, op_index, iteration,
       attempt, occurred_at_ms, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const history = connection
    .prepare(
      `SELECT event_type AS eventType, event_schema_version AS schemaVersion,
        op_index AS opIndex, iteration, attempt, occurred_at_ms AS occurredAtMs,
        payload_json AS payload
       FROM durable_events WHERE run_id = ? AND event_id <= ? ORDER BY event_id`,
    )
    .all(parentRunId, throughEventId) as unknown as ParentEvent[];
  for (const event of history) {
    if (!carried(event)) continue;
    insertEvent.run(
      runId,
      event.eventType,
      event.schemaVersion,
      event.opIndex,
      event.iteration,
      event.attempt,
      event.occurredAtMs,
      event.payload,
    );
  }
  insertEvent.run(
    runId,
    RUN_FORKED_EVENT_TYPE,
    1,
    null,
    null,
    null,
    now,
    canonicalRuntimeJson({ parentRunId, throughEventId }),
  );

  const checkpointId = writeFrontierCheckpoint(
    connection,
    {
      runId,
      ops,
      controlEdges: frontier.controlEdges,
      routerSelections: frontier.routerSelections,
    },
    now,
  );
  const metadata: RunForkMetadata = {
    schemaVersion: RUN_FORK_METADATA_SCHEMA_VERSION,
    parentRunId,
    throughEventId,
    parentCheckpointId: frontier.checkpoint?.checkpointId ?? null,
    checkpointId,
  };
  connection
    .prepare("UPDATE runs SET fork_metadata_json = ? WHERE run_id = ?")
    .run(canonicalRuntimeJson(metadata), runId);

  return Object.freeze({ runId, ...metadata, reused: reused.length, rerun });
}

/**
 * Fork a new run from a point in another run's history.
 *
 * The fork runs the same compiled plan. Work that had finished by the fork point keeps
 * its recorded attempts, results, logical effect ids and journal events; everything
 * else starts again as ready or pending with a fresh attempt budget, so a failed node
 * is retried, a waiting approval is asked again and a running loop carries on. The
 * fork starts from its own checkpoint as an ordinary `pending` run the dispatcher
 * admits like any other. Nothing of the parent is written.
 */
export function forkRun(
  database: SqliteDatabase,
  parentRunId: string,
  options: ForkRunOptions = {},
): Promise<ForkedRun> {
  const { throughEventId } = options;
  if (
    throughEventId !== undefined &&
    (!Number.isSafeInteger(throughEventId) || throughEventId < 1)
  ) {
    return Promise.reject(invalidPoint("throughEventId must be a positive whole number."));
  }
  const now = options.now ?? Date.now();
  return database.commit((connection) => writeFork(connection, parentRunId, throughEventId, now));
}
