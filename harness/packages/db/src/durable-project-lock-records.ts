import { PROJECTS_TABLE } from "./durable-project-records.js";
import { RUNS_TABLE } from "./durable-run-records.js";
import type { SqliteMigration } from "./migrations.js";

export const PROJECT_RUN_LOCKS_TABLE = "project_run_locks" as const;

/** Append new migrations; never edit the already-shipped v1-v13 schemas. */
export const DURABLE_PROJECT_RUN_LOCKS_MIGRATION: SqliteMigration = Object.freeze({
  version: 14,
  name: "durable_project_run_locks",
  sql: `
CREATE TABLE ${PROJECT_RUN_LOCKS_TABLE} (
  project_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
  FOREIGN KEY (project_id) REFERENCES ${PROJECTS_TABLE}(project_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES ${RUNS_TABLE}(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;
`,
});

export interface ProjectRunLockRecord {
  readonly projectId: string;
  readonly runId: string;
  readonly acquiredAtMs: number;
}

export type ProjectRunLockOutcome =
  | {
      readonly acquired: true;
      readonly runId: string;
      /** The finished run the lock was taken over from, if any. */
      readonly replacedRunId: string | null;
    }
  | { readonly acquired: false; readonly holderRunId: string };

/** Minimal statement surface, so this module does not depend on a driver type. */
export interface ProjectLockStatementRunner {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): unknown;
    get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
  };
}

const ACTIVE_RUN_STATUSES: ReadonlySet<unknown> = new Set(["pending", "running", "waiting"]);

export function readProjectRunLock(
  connection: ProjectLockStatementRunner,
  projectId: string,
): ProjectRunLockRecord | undefined {
  const row = connection
    .prepare(`SELECT * FROM ${PROJECT_RUN_LOCKS_TABLE} WHERE project_id = ?`)
    .get(projectId);
  if (row === undefined) return undefined;
  return Object.freeze({
    projectId: typeof row["project_id"] === "string" ? row["project_id"] : "",
    runId: typeof row["run_id"] === "string" ? row["run_id"] : "",
    acquiredAtMs: typeof row["acquired_at_ms"] === "number" ? row["acquired_at_ms"] : 0,
  });
}

/**
 * Take a project's single-writer lock for one run (8.17).
 *
 * Only one pending, running or waiting run holds a project at a time. A run that
 * already holds the lock gets it again, and a lock whose run has completed, failed
 * or been cancelled passes to the next run that asks. Call it inside a serialized
 * commit so the check and the write are a single step.
 */
export function acquireProjectRunLock(
  connection: ProjectLockStatementRunner,
  input: { readonly projectId: string; readonly runId: string; readonly nowMs: number },
): ProjectRunLockOutcome {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new TypeError("Lock times are UTC epoch milliseconds.");
  }
  const held = connection
    .prepare(
      `SELECT lock.run_id AS runId, run.status AS status
       FROM ${PROJECT_RUN_LOCKS_TABLE} AS lock
       JOIN ${RUNS_TABLE} AS run ON run.run_id = lock.run_id
       WHERE lock.project_id = ?`,
    )
    .get(input.projectId);

  if (held === undefined) {
    connection
      .prepare(
        `INSERT INTO ${PROJECT_RUN_LOCKS_TABLE} (project_id, run_id, acquired_at_ms) VALUES (?, ?, ?)`,
      )
      .run(input.projectId, input.runId, input.nowMs);
    return { acquired: true, runId: input.runId, replacedRunId: null };
  }

  const holder = typeof held["runId"] === "string" ? held["runId"] : "";
  if (holder === input.runId) return { acquired: true, runId: input.runId, replacedRunId: null };
  if (ACTIVE_RUN_STATUSES.has(held["status"])) return { acquired: false, holderRunId: holder };

  connection
    .prepare(
      `UPDATE ${PROJECT_RUN_LOCKS_TABLE} SET run_id = ?, acquired_at_ms = ? WHERE project_id = ?`,
    )
    .run(input.runId, input.nowMs, input.projectId);
  return { acquired: true, runId: input.runId, replacedRunId: holder };
}
