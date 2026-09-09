import { randomUUID } from "node:crypto";

import type { SerializedSqliteCommitPath } from "./durable-node-completion.js";
import {
  NODE_INVOCATIONS_TABLE,
  type DurableNodeInvocationRecord,
} from "./durable-node-attempt-records.js";

// Versioned and opaque so external adapters never need to parse execution coordinates.
export const LOGICAL_EFFECT_ID_PREFIX = "zet-effect-v1:" as const;

export interface DurableNodeInvocationIdentityInput {
  readonly runId: string;
  readonly opIndex: number;
  readonly iteration: number;
  /** Used only when the logical invocation is first created. */
  readonly createdAtMs: number;
}

interface DurableNodeInvocationRow {
  readonly runId: string;
  readonly opIndex: number;
  readonly iteration: number;
  readonly logicalEffectId: string;
  readonly createdAtMs: number;
}

/**
 * Generate a fresh Harness-owned logical effect identity.
 *
 * The value is intentionally opaque: adapters may later use it as the basis for
 * an external idempotency key without exposing run IDs, op indexes, or other
 * execution coordinates. Stability comes from persisting the generated value on
 * the logical invocation row, not from regenerating it for each attempt.
 */
export function generateLogicalEffectId(): string {
  return `${LOGICAL_EFFECT_ID_PREFIX}${randomUUID()}`;
}

/**
 * Return the one durable logical invocation identity for `(run, op, iteration)`.
 *
 * The first caller creates the Harness-owned ID inside the serialized SQLite
 * commit path. Retry attempts, concurrent callers, and post-restart callers read
 * and reuse the already-persisted value. The scheduler attempt number is
 * deliberately absent from this API so retry attempts cannot accidentally mint
 * new effect identities.
 *
 * Identity stability is not retry authorization; Phase 5.3 owns effect-aware
 * repeat safety. Fresh runs naturally create fresh identities. Recorded
 * replay/fork semantics remain a later Phase 9 decision; this helper does not
 * rewrite or reinterpret an invocation row that already exists.
 */
export function ensureDurableNodeInvocation(
  database: SerializedSqliteCommitPath,
  input: DurableNodeInvocationIdentityInput,
): Promise<DurableNodeInvocationRecord> {
  assertIdentityInput(input);

  return database.commit((connection) => {
    const existing = connection
      .prepare(
        `SELECT
           run_id AS runId,
           op_index AS opIndex,
           iteration,
           logical_effect_id AS logicalEffectId,
           created_at_ms AS createdAtMs
         FROM ${NODE_INVOCATIONS_TABLE}
         WHERE run_id = ? AND op_index = ? AND iteration = ?`,
      )
      .get(input.runId, input.opIndex, input.iteration) as DurableNodeInvocationRow | undefined;

    if (existing !== undefined) {
      return freezeInvocationRecord(existing);
    }

    const record = Object.freeze({
      runId: input.runId,
      opIndex: input.opIndex,
      iteration: input.iteration,
      logicalEffectId: generateLogicalEffectId(),
      createdAtMs: input.createdAtMs,
    }) satisfies DurableNodeInvocationRecord;

    connection
      .prepare(
        `INSERT INTO ${NODE_INVOCATIONS_TABLE}(
          run_id,
          op_index,
          iteration,
          logical_effect_id,
          created_at_ms
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.runId,
        record.opIndex,
        record.iteration,
        record.logicalEffectId,
        record.createdAtMs,
      );

    return record;
  });
}

function freezeInvocationRecord(row: DurableNodeInvocationRow): DurableNodeInvocationRecord {
  return Object.freeze({
    runId: row.runId,
    opIndex: row.opIndex,
    iteration: row.iteration,
    logicalEffectId: row.logicalEffectId,
    createdAtMs: row.createdAtMs,
  });
}

function assertIdentityInput(input: DurableNodeInvocationIdentityInput): void {
  if (input.runId.trim().length === 0) {
    throw new TypeError("Durable node invocation runId must not be empty.");
  }
  assertNonNegativeSafeInteger("opIndex", input.opIndex);
  assertNonNegativeSafeInteger("iteration", input.iteration);
  assertNonNegativeSafeInteger("createdAtMs", input.createdAtMs);
}

function assertNonNegativeSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Durable node invocation ${label} must be a non-negative safe integer.`);
  }
}
