import type { DatabaseSync } from "node:sqlite";

import { DURABLE_EVENTS_TABLE } from "./durable-event-records.js";
import { NODE_ATTEMPTS_TABLE } from "./durable-node-attempt-records.js";

type NonPromise<T> = T extends PromiseLike<unknown> ? never : unknown;

/** Small structural boundary implemented by `SqliteDatabase.commit(...)`. */
export interface SerializedSqliteCommitPath {
  commit<T>(write: (connection: DatabaseSync) => T & NonPromise<T>): Promise<T>;
}

export interface DurableNodeCompletionTerminalEventInput {
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly occurredAtMs: number;
  readonly payloadJson: string;
}

/**
 * Durable data required to make one concrete executor attempt completed.
 *
 * Blob bytes, model/tool work, and other async preparation must finish before
 * this input enters the SQLite commit path. Output and usage references remain
 * opaque JSON at this layer, matching the durable-attempt schema boundary.
 */
export interface DurableNodeCompletionInput {
  readonly runId: string;
  readonly opIndex: number;
  readonly iteration: number;
  readonly attempt: number;
  readonly outputRefsJson: string;
  readonly usageJson?: string | null;
  readonly finishedAtMs: number;
  readonly terminalEvent: DurableNodeCompletionTerminalEventInput;
}

export interface DurableNodeCompletionCommitResult {
  readonly eventId: number;
}

/**
 * Atomically complete one running durable attempt and append its terminal event.
 *
 * The event scope is derived from the attempt identity rather than caller input,
 * so a successful commit cannot attach the terminal event to a different node
 * attempt. Any failed update or event insert rejects the serialized transaction
 * and leaves the attempt running with no terminal event committed.
 */
export function commitDurableNodeCompletion(
  database: SerializedSqliteCommitPath,
  input: DurableNodeCompletionInput,
): Promise<DurableNodeCompletionCommitResult> {
  return database.commit((connection) => {
    const completion = connection
      .prepare(
        `UPDATE ${NODE_ATTEMPTS_TABLE}
         SET status = 'completed',
             output_refs_json = ?,
             usage_json = ?,
             finished_at_ms = ?
         WHERE run_id = ?
           AND op_index = ?
           AND iteration = ?
           AND attempt = ?
           AND status = 'running'`,
      )
      .run(
        input.outputRefsJson,
        input.usageJson ?? null,
        input.finishedAtMs,
        input.runId,
        input.opIndex,
        input.iteration,
        input.attempt,
      );

    if (completion.changes !== 1) {
      throw new TypeError("Durable node completion requires exactly one matching running attempt.");
    }

    const terminalEvent = connection
      .prepare(
        `INSERT INTO ${DURABLE_EVENTS_TABLE}(
          run_id,
          event_type,
          event_schema_version,
          op_index,
          iteration,
          attempt,
          occurred_at_ms,
          payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.terminalEvent.eventType,
        input.terminalEvent.eventSchemaVersion,
        input.opIndex,
        input.iteration,
        input.attempt,
        input.terminalEvent.occurredAtMs,
        input.terminalEvent.payloadJson,
      );

    return Object.freeze({ eventId: Number(terminalEvent.lastInsertRowid) });
  });
}
