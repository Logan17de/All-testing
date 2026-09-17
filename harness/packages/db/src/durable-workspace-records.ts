import type { SqliteMigration } from "./migrations.js";

export const WORKSPACES_TABLE = "workspaces" as const;

const MAX_PATH_LENGTH = 4096;

/**
 * A folder this harness works in.
 *
 * One of them is open at a time — that is the `workspace.root` setting — and this
 * table is the list a person chooses from, so moving between two pieces of work
 * does not mean finding a path again.
 */
export interface DurableWorkspaceRecord {
  readonly path: string;
  readonly addedAtMs: number;
  /** When it was last opened, so the list leads with where someone has been.  */
  readonly openedAtMs: number;
}

/** Append new migrations; never edit the already-shipped schemas. */
export const DURABLE_WORKSPACES_MIGRATION: SqliteMigration = Object.freeze({
  version: 23,
  name: "durable_workspaces",
  sql: `
CREATE TABLE ${WORKSPACES_TABLE} (
  path TEXT PRIMARY KEY CHECK (length(path) BETWEEN 1 AND ${String(MAX_PATH_LENGTH)}),
  added_at_ms INTEGER NOT NULL CHECK (added_at_ms >= 0),
  opened_at_ms INTEGER NOT NULL CHECK (opened_at_ms >= 0)
) STRICT;

CREATE INDEX ${WORKSPACES_TABLE}_by_opened ON ${WORKSPACES_TABLE} (opened_at_ms DESC);
`,
});

/** Minimal statement surface, so this module does not depend on a driver type. */
export interface WorkspaceStatementRunner {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): { changes?: number | bigint };
    get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
    all(...parameters: readonly unknown[]): Record<string, unknown>[];
  };
}

function rowToRecord(row: Record<string, unknown>): DurableWorkspaceRecord {
  return Object.freeze({
    path: row["path"] as string,
    addedAtMs: row["added_at_ms"] as number,
    openedAtMs: row["opened_at_ms"] as number,
  });
}

/** Every folder this harness knows, the most recently opened first. */
export function listWorkspaces(
  connection: WorkspaceStatementRunner,
): readonly DurableWorkspaceRecord[] {
  return connection
    .prepare(
      `SELECT path, added_at_ms, opened_at_ms FROM ${WORKSPACES_TABLE}
       ORDER BY opened_at_ms DESC, path ASC`,
    )
    .all()
    .map(rowToRecord);
}

/** Keep a folder in the list, and record that it was just opened. */
export function rememberWorkspace(
  connection: WorkspaceStatementRunner,
  path: string,
  nowMs: number,
): DurableWorkspaceRecord {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw new TypeError("A workspace path is between 1 and 4096 characters.");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("Workspace times are UTC epoch milliseconds.");
  }
  connection
    .prepare(
      `INSERT INTO ${WORKSPACES_TABLE} (path, added_at_ms, opened_at_ms) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET opened_at_ms = excluded.opened_at_ms`,
    )
    .run(path, nowMs, nowMs);
  const row = connection
    .prepare(`SELECT path, added_at_ms, opened_at_ms FROM ${WORKSPACES_TABLE} WHERE path = ?`)
    .get(path);
  if (row === undefined) throw new Error("The workspace was not stored.");
  return rowToRecord(row);
}

/** Take a folder out of the list. Nothing on disk is touched. */
export function forgetWorkspace(connection: WorkspaceStatementRunner, path: string): boolean {
  const result = connection.prepare(`DELETE FROM ${WORKSPACES_TABLE} WHERE path = ?`).run(path);
  return Number(result.changes ?? 0) > 0;
}
