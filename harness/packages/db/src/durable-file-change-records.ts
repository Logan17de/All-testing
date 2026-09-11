import { NODE_INVOCATIONS_TABLE } from "./durable-node-attempt-records.js";
import type { SqliteMigration } from "./migrations.js";

export const FILE_CHANGES_TABLE = "file_changes" as const;

export type DurableFileChangeKind = "created" | "modified" | "deleted";

/**
 * One recorded filesystem mutation, anchored to the logical effect that caused it.
 *
 * The record stores content hashes rather than content. That is enough to prove
 * what a run changed, to detect that something outside the harness changed the
 * same file afterwards, and to decide during recovery whether an ambiguous
 * external write actually landed — without copying possibly sensitive file
 * contents into the journal.
 */
export interface DurableFileChangeRecord {
  readonly fileChangeId: number;
  readonly runId: string;
  readonly opIndex: number;
  readonly iteration: number;
  readonly logicalEffectId: string;
  readonly attempt: number;
  /** Root-relative POSIX-style path. Absolute host paths never enter the journal. */
  readonly workspacePath: string;
  readonly changeKind: DurableFileChangeKind;
  /** Null when the file did not exist before the change. */
  readonly beforeSha256: string | null;
  /** Null only when the change deleted the file. */
  readonly afterSha256: string | null;
  readonly bytesWritten: number;
  readonly recordedAtMs: number;
}

/** Append new migrations; never edit the already-shipped v1-v6 schemas. */
export const DURABLE_FILE_CHANGES_MIGRATION: SqliteMigration = Object.freeze({
  version: 7,
  name: "durable_file_change_records",
  sql: `
CREATE TABLE ${FILE_CHANGES_TABLE} (
  file_change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  op_index INTEGER NOT NULL CHECK (op_index >= 0),
  iteration INTEGER NOT NULL CHECK (iteration >= 0),
  logical_effect_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  workspace_path TEXT NOT NULL CHECK (length(workspace_path) > 0),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('created', 'modified', 'deleted')),
  before_sha256 TEXT CHECK (before_sha256 IS NULL OR length(before_sha256) = 64),
  after_sha256 TEXT CHECK (after_sha256 IS NULL OR length(after_sha256) = 64),
  bytes_written INTEGER NOT NULL CHECK (bytes_written >= 0),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  CHECK (
    (change_kind = 'created'
      AND before_sha256 IS NULL AND after_sha256 IS NOT NULL)
    OR
    (change_kind = 'modified'
      AND before_sha256 IS NOT NULL AND after_sha256 IS NOT NULL)
    OR
    (change_kind = 'deleted'
      AND before_sha256 IS NOT NULL AND after_sha256 IS NULL AND bytes_written = 0)
  ),
  UNIQUE (run_id, op_index, iteration, logical_effect_id, attempt, workspace_path),
  FOREIGN KEY (run_id, op_index, iteration, logical_effect_id)
    REFERENCES ${NODE_INVOCATIONS_TABLE}(run_id, op_index, iteration, logical_effect_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX file_changes_run_path_idx
ON ${FILE_CHANGES_TABLE}(run_id, workspace_path, file_change_id);

CREATE TRIGGER file_changes_are_append_only
BEFORE UPDATE ON ${FILE_CHANGES_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'file change records are append-only');
END;

CREATE TRIGGER file_changes_cannot_be_deleted
BEFORE DELETE ON ${FILE_CHANGES_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'file change records are append-only');
END;
`,
});

export interface RecordFileChangeInput {
  readonly runId: string;
  readonly opIndex: number;
  readonly iteration: number;
  readonly logicalEffectId: string;
  readonly attempt: number;
  readonly workspacePath: string;
  readonly changeKind: DurableFileChangeKind;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly bytesWritten: number;
  readonly recordedAtMs: number;
}

/** Minimal statement surface, so this module does not depend on a driver type. */
export interface FileChangeStatementRunner {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): unknown;
    all(...parameters: readonly unknown[]): Record<string, unknown>[];
  };
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function assertHash(value: string | null, field: string): void {
  if (value === null) return;
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a lowercase hex sha256 digest.`);
  }
}

/**
 * Append one file-change record.
 *
 * Validation happens before the statement so a malformed hash fails with a
 * clear harness error rather than a SQLite constraint message. The table's own
 * CHECK constraints remain the authority: this function is a convenience, not
 * the only thing keeping the invariants true.
 */
export function recordFileChange(
  connection: FileChangeStatementRunner,
  input: RecordFileChangeInput,
): void {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new TypeError("attempt must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(input.bytesWritten) || input.bytesWritten < 0) {
    throw new TypeError("bytesWritten must be a non-negative safe integer.");
  }
  if (input.workspacePath.length === 0) {
    throw new TypeError("workspacePath must not be empty.");
  }
  assertHash(input.beforeSha256, "beforeSha256");
  assertHash(input.afterSha256, "afterSha256");

  connection
    .prepare(
      `INSERT INTO ${FILE_CHANGES_TABLE} (
        run_id, op_index, iteration, logical_effect_id, attempt,
        workspace_path, change_kind, before_sha256, after_sha256,
        bytes_written, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.opIndex,
      input.iteration,
      input.logicalEffectId,
      input.attempt,
      input.workspacePath,
      input.changeKind,
      input.beforeSha256,
      input.afterSha256,
      input.bytesWritten,
      input.recordedAtMs,
    );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toRecord(row: Record<string, unknown>): DurableFileChangeRecord {
  return Object.freeze({
    fileChangeId: integer(row["file_change_id"]),
    runId: text(row["run_id"]),
    opIndex: integer(row["op_index"]),
    iteration: integer(row["iteration"]),
    logicalEffectId: text(row["logical_effect_id"]),
    attempt: integer(row["attempt"]),
    workspacePath: text(row["workspace_path"]),
    changeKind: text(row["change_kind"]) as DurableFileChangeKind,
    beforeSha256: optionalText(row["before_sha256"]),
    afterSha256: optionalText(row["after_sha256"]),
    bytesWritten: integer(row["bytes_written"]),
    recordedAtMs: integer(row["recorded_at_ms"]),
  });
}

/** Every file change one run made, in the order they were recorded. */
export function readRunFileChanges(
  connection: FileChangeStatementRunner,
  runId: string,
): readonly DurableFileChangeRecord[] {
  const rows = connection
    .prepare(`SELECT * FROM ${FILE_CHANGES_TABLE} WHERE run_id = ? ORDER BY file_change_id ASC`)
    .all(runId);
  return Object.freeze(rows.map(toRecord));
}

/** Every recorded change to one path within a run, oldest first. */
export function readFileChangeHistory(
  connection: FileChangeStatementRunner,
  runId: string,
  workspacePath: string,
): readonly DurableFileChangeRecord[] {
  const rows = connection
    .prepare(
      `SELECT * FROM ${FILE_CHANGES_TABLE}
       WHERE run_id = ? AND workspace_path = ?
       ORDER BY file_change_id ASC`,
    )
    .all(runId, workspacePath);
  return Object.freeze(rows.map(toRecord));
}
