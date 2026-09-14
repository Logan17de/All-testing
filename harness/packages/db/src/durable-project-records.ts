import { isAbsolute, win32 } from "node:path";

import type { SqliteMigration } from "./migrations.js";
import { SORTABLE_ID_PATTERN } from "./sortable-id.js";

export const PROJECTS_TABLE = "projects" as const;
export const PROJECT_NAME_MAX_LENGTH = 200;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 4_000;
export const PROJECT_WORKSPACE_PATH_MAX_LENGTH = 1_024;

export type DurableProjectStatus = "active" | "archived";
export type ProjectListStatus = DurableProjectStatus | "all";

/** A project: the durable home for conversations, goals and the runs that work on them. */
export interface DurableProjectRecord {
  /** Sortable UUIDv7. */
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
  /** Absolute folder the project's work happens in; null until one is chosen. */
  readonly workspacePath: string | null;
  readonly status: DurableProjectStatus;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** Set exactly while the project is archived. */
  readonly archivedAtMs: number | null;
}

/** Append new migrations; never edit the already-shipped v1-v7 schemas. */
export const DURABLE_PROJECTS_MIGRATION: SqliteMigration = Object.freeze({
  version: 8,
  name: "durable_projects",
  sql: `
CREATE TABLE ${PROJECTS_TABLE} (
  project_id TEXT PRIMARY KEY CHECK (length(project_id) = 36),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${String(PROJECT_NAME_MAX_LENGTH)}),
  description TEXT NOT NULL CHECK (length(description) <= ${String(PROJECT_DESCRIPTION_MAX_LENGTH)}),
  workspace_path TEXT CHECK (
    workspace_path IS NULL
    OR length(workspace_path) BETWEEN 1 AND ${String(PROJECT_WORKSPACE_PATH_MAX_LENGTH)}
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  archived_at_ms INTEGER CHECK (archived_at_ms IS NULL OR archived_at_ms >= created_at_ms),
  CHECK ((status = 'active') = (archived_at_ms IS NULL))
) STRICT;

CREATE INDEX projects_status_updated_idx
ON ${PROJECTS_TABLE}(status, updated_at_ms DESC, project_id DESC);

CREATE TRIGGER projects_cannot_be_deleted
BEFORE DELETE ON ${PROJECTS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'projects are archived, never deleted');
END;

CREATE TRIGGER projects_keep_their_identity
BEFORE UPDATE OF project_id, created_at_ms ON ${PROJECTS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'a project keeps its id and creation time');
END;
`,
});

export type DurableProjectErrorCode = "PROJECT_INVALID" | "PROJECT_ARCHIVED";

/** A project write the harness refuses before it reaches SQLite. */
export class DurableProjectError extends Error {
  readonly code: DurableProjectErrorCode;
  /** The input field at fault, when there is one. */
  readonly field: string | undefined;

  constructor(code: DurableProjectErrorCode, message: string, field?: string) {
    super(message);
    this.name = "DurableProjectError";
    this.code = code;
    this.field = field;
  }
}

/** Minimal statement surface, so this module does not depend on a driver type. */
export interface ProjectStatementRunner {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): unknown;
    get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
    all(...parameters: readonly unknown[]): Record<string, unknown>[];
  };
}

export interface CreateProjectInput {
  readonly projectId: string;
  readonly name: string;
  readonly description?: string;
  readonly workspacePath?: string | null;
  readonly nowMs: number;
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly description?: string;
  readonly workspacePath?: string | null;
  readonly nowMs: number;
}

export interface ListProjectsOptions {
  /** Defaults to active projects. */
  readonly status?: ProjectListStatus;
  /** Defaults to 200, at most 1000. */
  readonly limit?: number;
}

function invalid(field: string, message: string): never {
  throw new DurableProjectError("PROJECT_INVALID", message, field);
}

function checkTime(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    invalid("nowMs", "Project times are UTC epoch milliseconds.");
  }
  return nowMs;
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) invalid("name", "A project needs a name.");
  if (trimmed.length > PROJECT_NAME_MAX_LENGTH) {
    invalid("name", `A project name is at most ${String(PROJECT_NAME_MAX_LENGTH)} characters.`);
  }
  return trimmed;
}

function checkDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length > PROJECT_DESCRIPTION_MAX_LENGTH) {
    invalid(
      "description",
      `A project description is at most ${String(PROJECT_DESCRIPTION_MAX_LENGTH)} characters.`,
    );
  }
  return trimmed;
}

function checkWorkspacePath(path: string | null): string | null {
  if (path === null) return null;
  const trimmed = path.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > PROJECT_WORKSPACE_PATH_MAX_LENGTH) {
    invalid(
      "workspacePath",
      `A workspace path is at most ${String(PROJECT_WORKSPACE_PATH_MAX_LENGTH)} characters.`,
    );
  }
  if (trimmed.includes("\0") || (!isAbsolute(trimmed) && !win32.isAbsolute(trimmed))) {
    invalid("workspacePath", "A workspace path must be an absolute folder path.");
  }
  return trimmed;
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

function optionalInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toRecord(row: Record<string, unknown>): DurableProjectRecord {
  return Object.freeze({
    projectId: text(row["project_id"]),
    name: text(row["name"]),
    description: text(row["description"]),
    workspacePath: optionalText(row["workspace_path"]),
    status: text(row["status"]) as DurableProjectStatus,
    createdAtMs: integer(row["created_at_ms"]),
    updatedAtMs: integer(row["updated_at_ms"]),
    archivedAtMs: optionalInteger(row["archived_at_ms"]),
  });
}

/**
 * Create an active project.
 *
 * Validation happens before the statement so bad input fails with a clear harness
 * error rather than a SQLite constraint message. The table's own CHECK constraints
 * and triggers remain the authority.
 */
export function createProject(
  connection: ProjectStatementRunner,
  input: CreateProjectInput,
): DurableProjectRecord {
  if (!SORTABLE_ID_PATTERN.test(input.projectId)) {
    invalid("projectId", "A project id must be a sortable UUIDv7.");
  }
  const nowMs = checkTime(input.nowMs);
  const name = checkName(input.name);
  const description = checkDescription(input.description ?? "");
  const workspacePath = checkWorkspacePath(input.workspacePath ?? null);

  connection
    .prepare(
      `INSERT INTO ${PROJECTS_TABLE} (
        project_id, name, description, workspace_path, status,
        created_at_ms, updated_at_ms, archived_at_ms
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)`,
    )
    .run(input.projectId, name, description, workspacePath, nowMs, nowMs);

  return Object.freeze({
    projectId: input.projectId,
    name,
    description,
    workspacePath,
    status: "active",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    archivedAtMs: null,
  });
}

export function readProject(
  connection: ProjectStatementRunner,
  projectId: string,
): DurableProjectRecord | undefined {
  const row = connection
    .prepare(`SELECT * FROM ${PROJECTS_TABLE} WHERE project_id = ?`)
    .get(projectId);
  return row === undefined ? undefined : toRecord(row);
}

/** Projects, most recently changed first. */
export function listProjects(
  connection: ProjectStatementRunner,
  options: ListProjectsOptions = {},
): readonly DurableProjectRecord[] {
  const status = options.status ?? "active";
  const requested = options.limit ?? 200;
  const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(requested, 1_000)) : 200;
  const rows =
    status === "all"
      ? connection
          .prepare(
            `SELECT * FROM ${PROJECTS_TABLE}
             ORDER BY updated_at_ms DESC, project_id DESC LIMIT ?`,
          )
          .all(limit)
      : connection
          .prepare(
            `SELECT * FROM ${PROJECTS_TABLE} WHERE status = ?
             ORDER BY updated_at_ms DESC, project_id DESC LIMIT ?`,
          )
          .all(status, limit);
  return Object.freeze(rows.map(toRecord));
}

/**
 * Change an active project's name, description or workspace path.
 *
 * Returns undefined when no project has this id. An archived project is refused:
 * restore it first, so an archive is a stable record of what the project was.
 */
export function updateProject(
  connection: ProjectStatementRunner,
  projectId: string,
  input: UpdateProjectInput,
): DurableProjectRecord | undefined {
  const nowMs = checkTime(input.nowMs);
  const current = readProject(connection, projectId);
  if (current === undefined) return undefined;
  if (current.status === "archived") {
    throw new DurableProjectError(
      "PROJECT_ARCHIVED",
      "This project is archived. Restore it before changing it.",
    );
  }
  const name = input.name === undefined ? current.name : checkName(input.name);
  const description =
    input.description === undefined ? current.description : checkDescription(input.description);
  const workspacePath =
    input.workspacePath === undefined
      ? current.workspacePath
      : checkWorkspacePath(input.workspacePath);
  // A clock that stepped backwards never moves a project back in the list.
  const updatedAtMs = Math.max(nowMs, current.updatedAtMs);

  connection
    .prepare(
      `UPDATE ${PROJECTS_TABLE}
       SET name = ?, description = ?, workspace_path = ?, updated_at_ms = ?
       WHERE project_id = ?`,
    )
    .run(name, description, workspacePath, updatedAtMs, projectId);

  return Object.freeze({ ...current, name, description, workspacePath, updatedAtMs });
}

function setProjectStatus(
  connection: ProjectStatementRunner,
  projectId: string,
  status: DurableProjectStatus,
  nowMs: number,
): DurableProjectRecord | undefined {
  const time = checkTime(nowMs);
  const current = readProject(connection, projectId);
  if (current === undefined) return undefined;
  if (current.status === status) return current;
  const updatedAtMs = Math.max(time, current.updatedAtMs);
  const archivedAtMs = status === "archived" ? updatedAtMs : null;

  connection
    .prepare(
      `UPDATE ${PROJECTS_TABLE}
       SET status = ?, archived_at_ms = ?, updated_at_ms = ?
       WHERE project_id = ?`,
    )
    .run(status, archivedAtMs, updatedAtMs, projectId);

  return Object.freeze({ ...current, status, archivedAtMs, updatedAtMs });
}

/** Archive a project. Archiving an archived project changes nothing. */
export function archiveProject(
  connection: ProjectStatementRunner,
  projectId: string,
  nowMs: number,
): DurableProjectRecord | undefined {
  return setProjectStatus(connection, projectId, "archived", nowMs);
}

/** Make an archived project active again. Restoring an active project changes nothing. */
export function restoreProject(
  connection: ProjectStatementRunner,
  projectId: string,
  nowMs: number,
): DurableProjectRecord | undefined {
  return setProjectStatus(connection, projectId, "active", nowMs);
}
