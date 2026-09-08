import { NODE_ATTEMPTS_TABLE } from "./durable-node-attempt-records.js";
import { RUNS_TABLE } from "./durable-run-records.js";
import type { SqliteMigration } from "./migrations.js";

export const DURABLE_EVENTS_TABLE = "durable_events" as const;

/**
 * One append-only durable runtime event.
 *
 * `eventId` is the database-generated global journal cursor and therefore the
 * authoritative ordering key. `occurredAtMs` is timeline metadata only and must
 * not be used to reconstruct journal order. `eventSchemaVersion` versions the
 * payload contract independently from database migration versions.
 *
 * Op/iteration scope is optional so run-level events and scheduler states that do
 * not create executor attempts can still be recorded. When `attempt` is present,
 * the database requires the referenced concrete attempt to exist.
 */
export interface DurableEventRecord {
  readonly eventId: number;
  readonly runId: string;
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly opIndex: number | null;
  readonly iteration: number | null;
  readonly attempt: number | null;
  readonly occurredAtMs: number;
  readonly payloadJson: string;
}

/** Add the append-only versioned durable event journal. */
export const DURABLE_EVENTS_MIGRATION: SqliteMigration = Object.freeze({
  version: 4,
  name: "append_only_versioned_durable_events",
  sql: `
CREATE TABLE ${DURABLE_EVENTS_TABLE} (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (length(event_type) > 0),
  event_schema_version INTEGER NOT NULL CHECK (event_schema_version >= 1),
  op_index INTEGER CHECK (op_index IS NULL OR op_index >= 0),
  iteration INTEGER CHECK (iteration IS NULL OR iteration >= 0),
  attempt INTEGER CHECK (attempt IS NULL OR attempt >= 1),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  payload_json TEXT NOT NULL CHECK (length(payload_json) > 0),
  CHECK (
    (op_index IS NULL AND iteration IS NULL AND attempt IS NULL)
    OR
    (op_index IS NOT NULL AND iteration IS NOT NULL)
  ),
  FOREIGN KEY (run_id)
    REFERENCES ${RUNS_TABLE}(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (run_id, op_index, iteration, attempt)
    REFERENCES ${NODE_ATTEMPTS_TABLE}(run_id, op_index, iteration, attempt)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX durable_events_run_cursor_idx
ON ${DURABLE_EVENTS_TABLE}(run_id, event_id);

CREATE INDEX durable_events_run_type_cursor_idx
ON ${DURABLE_EVENTS_TABLE}(run_id, event_type, event_id);

CREATE TRIGGER durable_events_reject_update
BEFORE UPDATE ON ${DURABLE_EVENTS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'durable_events is append-only');
END;

CREATE TRIGGER durable_events_reject_delete
BEFORE DELETE ON ${DURABLE_EVENTS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'durable_events is append-only');
END;
`,
});
