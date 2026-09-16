import { PROJECTS_TABLE } from "./durable-project-records.js";
import { RUNS_TABLE } from "./durable-run-records.js";
import type { SqliteMigration } from "./migrations.js";
import { SORTABLE_ID_PATTERN } from "./sortable-id.js";

export const PROJECT_MEMORIES_TABLE = "project_memories" as const;
export const MEMORY_TITLE_MAX_LENGTH = 200;
export const MEMORY_BODY_MAX_LENGTH = 8_000;
const LIST_LIMIT = 500;

export const MEMORY_KINDS = ["fact", "preference", "decision", "note"] as const;
export type DurableMemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_SOURCES = ["person", "agent"] as const;
export type DurableMemorySource = (typeof MEMORY_SOURCES)[number];

/**
 * Something worth remembering about a project, beyond any one conversation or run.
 *
 * A memory is small, written text a person or an agent can read back later. It is
 * deliberately not a transcript: conversations already keep those, and a run keeps
 * its own journal.
 */
export interface DurableMemoryRecord {
  /** Sortable UUIDv7. */
  readonly memoryId: string;
  readonly projectId: string;
  readonly kind: DurableMemoryKind;
  readonly title: string;
  readonly body: string;
  /** Pinned memories are offered first, before recent ones. */
  readonly pinned: boolean;
  readonly source: DurableMemorySource;
  /** The run that wrote it, when an agent did. */
  readonly sourceRunId: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** Append new migrations; never edit the already-shipped schemas. */
export const DURABLE_PROJECT_MEMORIES_MIGRATION: SqliteMigration = Object.freeze({
  version: 15,
  name: "durable_project_memories",
  sql: `
CREATE TABLE ${PROJECT_MEMORIES_TABLE} (
  memory_id TEXT PRIMARY KEY CHECK (length(memory_id) = 36),
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'decision', 'note')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND ${String(MEMORY_TITLE_MAX_LENGTH)}),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND ${String(MEMORY_BODY_MAX_LENGTH)}),
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
  source TEXT NOT NULL CHECK (source IN ('person', 'agent')),
  source_run_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (source = 'agent' OR source_run_id IS NULL),
  FOREIGN KEY (project_id)
    REFERENCES ${PROJECTS_TABLE}(project_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (source_run_id)
    REFERENCES ${RUNS_TABLE}(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX project_memories_recall_idx
ON ${PROJECT_MEMORIES_TABLE}(project_id, pinned DESC, updated_at_ms DESC, memory_id DESC);

CREATE TRIGGER project_memories_keep_their_identity
BEFORE UPDATE OF memory_id, project_id, source, created_at_ms ON ${PROJECT_MEMORIES_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'a memory keeps its id, project, source and creation time');
END;
`,
});

export type DurableMemoryErrorCode =
  "MEMORY_INVALID" | "MEMORY_NOT_FOUND" | "PROJECT_NOT_FOUND" | "PROJECT_ARCHIVED";

/** A memory write the harness refuses before it reaches SQLite. */
export class DurableMemoryError extends Error {
  readonly code: DurableMemoryErrorCode;
  /** The input field at fault, when there is one. */
  readonly field: string | undefined;

  constructor(code: DurableMemoryErrorCode, message: string, field?: string) {
    super(message);
    this.name = "DurableMemoryError";
    this.code = code;
    this.field = field;
  }
}

/** Minimal statement surface, so this module does not depend on a driver type. */
export interface MemoryStatementRunner {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): unknown;
    get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
    all(...parameters: readonly unknown[]): Record<string, unknown>[];
  };
}

export interface CreateMemoryInput {
  readonly memoryId: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  /** Defaults to a plain note. */
  readonly kind?: DurableMemoryKind;
  readonly pinned?: boolean;
  /** Defaults to a person writing it. */
  readonly source?: DurableMemorySource;
  /** Only an agent's memory may name the run it came from. */
  readonly sourceRunId?: string | null;
  readonly nowMs: number;
}

export interface UpdateMemoryInput {
  readonly title?: string;
  readonly body?: string;
  readonly kind?: DurableMemoryKind;
  readonly pinned?: boolean;
  readonly nowMs: number;
}

export interface ListMemoriesOptions {
  /** Only pinned memories. */
  readonly pinnedOnly?: boolean;
  readonly kind?: DurableMemoryKind;
  /** Defaults to and is capped at 500. */
  readonly limit?: number;
}

function fail(code: DurableMemoryErrorCode, message: string, field?: string): never {
  throw new DurableMemoryError(code, message, field);
}

function invalid(field: string, message: string): never {
  return fail("MEMORY_INVALID", message, field);
}

function checkTime(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    invalid("nowMs", "Memory times are UTC epoch milliseconds.");
  }
  return nowMs;
}

function checkId(field: string, id: string): string {
  if (!SORTABLE_ID_PATTERN.test(id)) invalid(field, `${field} must be a sortable UUIDv7.`);
  return id;
}

function checkText(field: string, value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) invalid(field, `A memory needs a ${field}.`);
  if (trimmed.length > maxLength) {
    invalid(field, `A memory's ${field} is at most ${String(maxLength)} characters.`);
  }
  return trimmed;
}

function checkKind(kind: DurableMemoryKind): DurableMemoryKind {
  if (!MEMORY_KINDS.includes(kind))
    invalid("kind", `kind must be one of: ${MEMORY_KINDS.join(", ")}.`);
  return kind;
}

function requireActiveProject(connection: MemoryStatementRunner, projectId: string): void {
  const project = connection
    .prepare(`SELECT status FROM ${PROJECTS_TABLE} WHERE project_id = ?`)
    .get(projectId);
  if (project === undefined) {
    fail("PROJECT_NOT_FOUND", "No project exists with this id.", "projectId");
  }
  if (project["status"] !== "active") {
    fail(
      "PROJECT_ARCHIVED",
      "This project is archived. Restore it before changing what it remembers.",
      "projectId",
    );
  }
}

function toMemory(row: Record<string, unknown>): DurableMemoryRecord {
  return Object.freeze({
    memoryId: row["memory_id"] as string,
    projectId: row["project_id"] as string,
    kind: row["kind"] as DurableMemoryKind,
    title: row["title"] as string,
    body: row["body"] as string,
    pinned: row["pinned"] === 1,
    source: row["source"] as DurableMemorySource,
    sourceRunId: (row["source_run_id"] as string | null) ?? null,
    createdAtMs: row["created_at_ms"] as number,
    updatedAtMs: row["updated_at_ms"] as number,
  });
}

/** Remember something about a project. */
export function createMemory(
  connection: MemoryStatementRunner,
  input: CreateMemoryInput,
): DurableMemoryRecord {
  const memoryId = checkId("memoryId", input.memoryId);
  const nowMs = checkTime(input.nowMs);
  const title = checkText("title", input.title, MEMORY_TITLE_MAX_LENGTH);
  const body = checkText("body", input.body, MEMORY_BODY_MAX_LENGTH);
  const kind = checkKind(input.kind ?? "note");
  const source = input.source ?? "person";
  const sourceRunId = input.sourceRunId ?? null;
  if (source !== "agent" && sourceRunId !== null) {
    invalid("sourceRunId", "Only a memory an agent wrote names the run it came from.");
  }
  requireActiveProject(connection, input.projectId);

  connection
    .prepare(
      `INSERT INTO ${PROJECT_MEMORIES_TABLE} (
        memory_id, project_id, kind, title, body, pinned, source, source_run_id,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      memoryId,
      input.projectId,
      kind,
      title,
      body,
      input.pinned === true ? 1 : 0,
      source,
      sourceRunId,
      nowMs,
      nowMs,
    );

  return Object.freeze({
    memoryId,
    projectId: input.projectId,
    kind,
    title,
    body,
    pinned: input.pinned === true,
    source,
    sourceRunId,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
}

export function readMemory(
  connection: MemoryStatementRunner,
  memoryId: string,
): DurableMemoryRecord | undefined {
  const row = connection
    .prepare(`SELECT * FROM ${PROJECT_MEMORIES_TABLE} WHERE memory_id = ?`)
    .get(memoryId);
  return row === undefined ? undefined : toMemory(row);
}

/**
 * What a project remembers: pinned memories first, then the most recently changed.
 *
 * This ordering is the retrieval order too, so a caller with a budget can stop
 * reading at any point and still hold the memories that matter most.
 */
export function listMemories(
  connection: MemoryStatementRunner,
  projectId: string,
  options: ListMemoriesOptions = {},
): readonly DurableMemoryRecord[] {
  const requested = options.limit ?? LIST_LIMIT;
  const limit = Number.isSafeInteger(requested)
    ? Math.max(1, Math.min(requested, LIST_LIMIT))
    : LIST_LIMIT;
  const conditions = ["project_id = ?"];
  const parameters: unknown[] = [projectId];
  if (options.pinnedOnly === true) conditions.push("pinned = 1");
  if (options.kind !== undefined) {
    conditions.push("kind = ?");
    parameters.push(checkKind(options.kind));
  }
  const rows = connection
    .prepare(
      `SELECT * FROM ${PROJECT_MEMORIES_TABLE} WHERE ${conditions.join(" AND ")}
       ORDER BY pinned DESC, updated_at_ms DESC, memory_id DESC LIMIT ?`,
    )
    .all(...parameters, limit);
  return Object.freeze(rows.map(toMemory));
}

/** Change what a memory says, or pin and unpin it. */
export function updateMemory(
  connection: MemoryStatementRunner,
  memoryId: string,
  input: UpdateMemoryInput,
): DurableMemoryRecord | undefined {
  const nowMs = checkTime(input.nowMs);
  const existing = readMemory(connection, memoryId);
  if (existing === undefined) return undefined;
  if (
    input.title === undefined &&
    input.body === undefined &&
    input.kind === undefined &&
    input.pinned === undefined
  ) {
    invalid("title", "Changing a memory needs a title, body, kind or pinned state.");
  }
  requireActiveProject(connection, existing.projectId);

  const title =
    input.title === undefined
      ? existing.title
      : checkText("title", input.title, MEMORY_TITLE_MAX_LENGTH);
  const body =
    input.body === undefined
      ? existing.body
      : checkText("body", input.body, MEMORY_BODY_MAX_LENGTH);
  const kind = input.kind === undefined ? existing.kind : checkKind(input.kind);
  const pinned = input.pinned ?? existing.pinned;

  connection
    .prepare(
      `UPDATE ${PROJECT_MEMORIES_TABLE}
       SET title = ?, body = ?, kind = ?, pinned = ?, updated_at_ms = ?
       WHERE memory_id = ?`,
    )
    .run(title, body, kind, pinned ? 1 : 0, Math.max(nowMs, existing.createdAtMs), memoryId);

  return Object.freeze({
    ...existing,
    title,
    body,
    kind,
    pinned,
    updatedAtMs: Math.max(nowMs, existing.createdAtMs),
  });
}

/**
 * Forget one memory.
 *
 * Memories are the one durable record a person may simply remove: keeping a
 * "forgotten" copy would defeat the point of asking for it to be forgotten.
 */
export function forgetMemory(connection: MemoryStatementRunner, memoryId: string): boolean {
  const existing = readMemory(connection, memoryId);
  if (existing === undefined) return false;
  connection.prepare(`DELETE FROM ${PROJECT_MEMORIES_TABLE} WHERE memory_id = ?`).run(memoryId);
  return true;
}
