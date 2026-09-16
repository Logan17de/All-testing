import { RUNS_TABLE } from "./durable-run-records.js";
import type { SqliteMigration } from "./migrations.js";
import { SORTABLE_ID_PATTERN } from "./sortable-id.js";

export const TRIGGER_FIRES_TABLE = "trigger_fires" as const;
export const DEDUPE_KEY_MAX_LENGTH = 200;
const LIST_LIMIT = 200;

export const TRIGGER_FIRE_REASONS = ["manual", "cron", "webhook", "api"] as const;
export type DurableTriggerFireReason = (typeof TRIGGER_FIRE_REASONS)[number];

/**
 * A receipt for one firing of a trigger.
 *
 * The receipt is claimed before the run is created and is unique per trigger and
 * dedupe key, so a webhook delivered twice, a client that retries, or a scheduler
 * pass that repeats a tick all find the receipt already there and reuse its run
 * instead of starting another.
 */
export interface DurableTriggerFireRecord {
  /** Sortable UUIDv7. */
  readonly fireId: string;
  readonly triggerId: string;
  readonly dedupeKey: string;
  readonly reason: DurableTriggerFireReason;
  /** The run this firing started, once it has one. */
  readonly runId: string | null;
  readonly firedAtMs: number;
}

/** Append new migrations; never edit the already-shipped schemas. */
export const DURABLE_TRIGGER_FIRES_MIGRATION: SqliteMigration = Object.freeze({
  version: 18,
  name: "durable_trigger_fires",
  sql: `
CREATE TABLE ${TRIGGER_FIRES_TABLE} (
  fire_id TEXT PRIMARY KEY CHECK (length(fire_id) = 36),
  trigger_id TEXT NOT NULL CHECK (length(trigger_id) = 36),
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND ${String(DEDUPE_KEY_MAX_LENGTH)}),
  reason TEXT NOT NULL CHECK (reason IN ('manual', 'cron', 'webhook', 'api')),
  run_id TEXT,
  fired_at_ms INTEGER NOT NULL CHECK (fired_at_ms >= 0),
  UNIQUE (trigger_id, dedupe_key),
  FOREIGN KEY (run_id)
    REFERENCES ${RUNS_TABLE}(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX trigger_fires_recent_idx
ON ${TRIGGER_FIRES_TABLE}(trigger_id, fired_at_ms DESC, fire_id DESC);

CREATE TRIGGER trigger_fires_keep_their_claim
BEFORE UPDATE OF fire_id, trigger_id, dedupe_key, reason, fired_at_ms ON ${TRIGGER_FIRES_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'a firing receipt keeps its claim; only its run is filled in');
END;
`,
});

export class DurableTriggerFireError extends Error {
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "DurableTriggerFireError";
    this.field = field;
  }
}

/** Minimal statement surface, so this module does not depend on a driver type. */
export interface TriggerFireStatementRunner {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): unknown;
    get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
    all(...parameters: readonly unknown[]): Record<string, unknown>[];
  };
}

export interface ClaimTriggerFireInput {
  readonly fireId: string;
  readonly triggerId: string;
  readonly dedupeKey: string;
  readonly reason: DurableTriggerFireReason;
  readonly nowMs: number;
}

export interface ClaimedTriggerFire {
  readonly fire: DurableTriggerFireRecord;
  /** False when this call claimed it; true when it was already claimed. */
  readonly duplicate: boolean;
}

function toFire(row: Record<string, unknown>): DurableTriggerFireRecord {
  return Object.freeze({
    fireId: row["fire_id"] as string,
    triggerId: row["trigger_id"] as string,
    dedupeKey: row["dedupe_key"] as string,
    reason: row["reason"] as DurableTriggerFireReason,
    runId: (row["run_id"] as string | null) ?? null,
    firedAtMs: row["fired_at_ms"] as number,
  });
}

/**
 * Claim the right to fire a trigger for one dedupe key.
 *
 * The claim is the first write of a firing, before any run exists, so two callers
 * racing the same key cannot both start one: the loser is told it is a duplicate
 * and gets the receipt that won, whose run id it can wait for.
 */
export function claimTriggerFire(
  connection: TriggerFireStatementRunner,
  input: ClaimTriggerFireInput,
): ClaimedTriggerFire {
  if (!SORTABLE_ID_PATTERN.test(input.fireId)) {
    throw new DurableTriggerFireError("fireId must be a sortable UUIDv7.", "fireId");
  }
  const dedupeKey = input.dedupeKey.trim();
  if (dedupeKey.length === 0 || dedupeKey.length > DEDUPE_KEY_MAX_LENGTH) {
    throw new DurableTriggerFireError(
      `A dedupe key is between 1 and ${String(DEDUPE_KEY_MAX_LENGTH)} characters.`,
      "dedupeKey",
    );
  }
  if (!TRIGGER_FIRE_REASONS.includes(input.reason)) {
    throw new DurableTriggerFireError("reason is not a way a trigger fires.", "reason");
  }
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new DurableTriggerFireError("Firing times are UTC epoch milliseconds.", "nowMs");
  }

  const result = connection
    .prepare(
      `INSERT INTO ${TRIGGER_FIRES_TABLE} (
        fire_id, trigger_id, dedupe_key, reason, run_id, fired_at_ms
      ) VALUES (?, ?, ?, ?, NULL, ?)
      ON CONFLICT(trigger_id, dedupe_key) DO NOTHING`,
    )
    .run(input.fireId, input.triggerId, dedupeKey, input.reason, input.nowMs) as {
    readonly changes?: number | bigint;
  };
  const stored = connection
    .prepare(`SELECT * FROM ${TRIGGER_FIRES_TABLE} WHERE trigger_id = ? AND dedupe_key = ?`)
    .get(input.triggerId, dedupeKey);
  if (stored === undefined) throw new DurableTriggerFireError("The firing was not claimed.");
  return Object.freeze({ fire: toFire(stored), duplicate: Number(result.changes ?? 0) === 0 });
}

/** Record the run a claimed firing started. */
export function recordTriggerFireRun(
  connection: TriggerFireStatementRunner,
  fireId: string,
  runId: string,
): void {
  connection
    .prepare(`UPDATE ${TRIGGER_FIRES_TABLE} SET run_id = ? WHERE fire_id = ? AND run_id IS NULL`)
    .run(runId, fireId);
}

export function readTriggerFire(
  connection: TriggerFireStatementRunner,
  fireId: string,
): DurableTriggerFireRecord | undefined {
  const row = connection
    .prepare(`SELECT * FROM ${TRIGGER_FIRES_TABLE} WHERE fire_id = ?`)
    .get(fireId);
  return row === undefined ? undefined : toFire(row);
}

/** One trigger's firings, most recent first. */
export function listTriggerFires(
  connection: TriggerFireStatementRunner,
  triggerId: string,
  limit = LIST_LIMIT,
): readonly DurableTriggerFireRecord[] {
  const bounded = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(limit, LIST_LIMIT))
    : LIST_LIMIT;
  const rows = connection
    .prepare(
      `SELECT * FROM ${TRIGGER_FIRES_TABLE} WHERE trigger_id = ?
       ORDER BY fired_at_ms DESC, fire_id DESC LIMIT ?`,
    )
    .all(triggerId, bounded);
  return Object.freeze(rows.map(toFire));
}
