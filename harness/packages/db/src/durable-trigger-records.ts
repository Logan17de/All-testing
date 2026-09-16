import { GRAPH_COMPILATIONS_TABLE } from "./durable-identity-records.js";
import { PROJECTS_TABLE } from "./durable-project-records.js";
import { RUNS_TABLE } from "./durable-run-records.js";
import type { SqliteMigration } from "./migrations.js";
import { SORTABLE_ID_PATTERN } from "./sortable-id.js";

export const TRIGGERS_TABLE = "triggers" as const;
export const TRIGGER_NAME_MAX_LENGTH = 200;
const LIST_LIMIT = 500;

export const TRIGGER_KINDS = ["manual", "cron", "webhook", "api"] as const;
export type DurableTriggerKind = (typeof TRIGGER_KINDS)[number];

/**
 * A standing reason to start a run of one stored plan.
 *
 * A trigger binds a graph document to the plan compiled from it, exactly as a run
 * does, so firing one never recompiles anything: it creates a `pending` run through
 * the same durable path the editor uses, and the dispatcher admits it like any other.
 */
export interface DurableTriggerRecord {
  /** Sortable UUIDv7. */
  readonly triggerId: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly kind: DurableTriggerKind;
  readonly enabled: boolean;
  readonly documentHash: string;
  readonly compiledPlanId: number;
  /** A five-field UTC cron expression; only a cron trigger has one. */
  readonly cronExpression: string | null;
  /** When this trigger is next due, for cron triggers the scheduler is watching. */
  readonly nextFireAtMs: number | null;
  /** Only a webhook or api trigger has a token, and only its hash is stored. */
  readonly hasToken: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly lastFiredAtMs: number | null;
  readonly lastRunId: string | null;
}

/** Append new migrations; never edit the already-shipped schemas. */
export const DURABLE_TRIGGERS_MIGRATION: SqliteMigration = Object.freeze({
  version: 17,
  name: "durable_triggers",
  sql: `
CREATE TABLE ${TRIGGERS_TABLE} (
  trigger_id TEXT PRIMARY KEY CHECK (length(trigger_id) = 36),
  project_id TEXT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${String(TRIGGER_NAME_MAX_LENGTH)}),
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'cron', 'webhook', 'api')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  document_hash TEXT NOT NULL,
  compiled_plan_id INTEGER NOT NULL,
  cron_expression TEXT,
  next_fire_at_ms INTEGER CHECK (next_fire_at_ms IS NULL OR next_fire_at_ms >= 0),
  token_hash TEXT CHECK (token_hash IS NULL OR length(token_hash) = 64),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  last_fired_at_ms INTEGER CHECK (last_fired_at_ms IS NULL OR last_fired_at_ms >= created_at_ms),
  last_run_id TEXT,
  CHECK ((kind = 'cron') = (cron_expression IS NOT NULL)),
  CHECK (kind IN ('webhook', 'api') OR token_hash IS NULL),
  CHECK (kind = 'cron' OR next_fire_at_ms IS NULL),
  FOREIGN KEY (project_id)
    REFERENCES ${PROJECTS_TABLE}(project_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (document_hash, compiled_plan_id)
    REFERENCES ${GRAPH_COMPILATIONS_TABLE}(document_hash, compiled_plan_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (last_run_id)
    REFERENCES ${RUNS_TABLE}(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX triggers_project_idx ON ${TRIGGERS_TABLE}(project_id, created_at_ms DESC);

CREATE INDEX triggers_due_idx
ON ${TRIGGERS_TABLE}(next_fire_at_ms)
WHERE enabled = 1 AND next_fire_at_ms IS NOT NULL;

CREATE TRIGGER triggers_keep_their_identity
BEFORE UPDATE OF trigger_id, kind, created_at_ms ON ${TRIGGERS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'a trigger keeps its id, kind and creation time');
END;
`,
});

export type DurableTriggerErrorCode =
  "TRIGGER_INVALID" | "TRIGGER_NOT_FOUND" | "PROJECT_NOT_FOUND" | "PROJECT_ARCHIVED";

export class DurableTriggerError extends Error {
  readonly code: DurableTriggerErrorCode;
  readonly field: string | undefined;

  constructor(code: DurableTriggerErrorCode, message: string, field?: string) {
    super(message);
    this.name = "DurableTriggerError";
    this.code = code;
    this.field = field;
  }
}

/** Minimal statement surface, so this module does not depend on a driver type. */
export interface TriggerStatementRunner {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): unknown;
    get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
    all(...parameters: readonly unknown[]): Record<string, unknown>[];
  };
}

export interface CreateTriggerInput {
  readonly triggerId: string;
  readonly name: string;
  readonly kind: DurableTriggerKind;
  readonly documentHash: string;
  readonly compiledPlanId: number;
  readonly projectId?: string | null;
  readonly cronExpression?: string;
  readonly nextFireAtMs?: number;
  /** The sha-256 of the token a webhook or api caller must present. */
  readonly tokenHash?: string;
  readonly enabled?: boolean;
  readonly nowMs: number;
}

export interface UpdateTriggerInput {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly cronExpression?: string;
  readonly nextFireAtMs?: number | null;
  readonly nowMs: number;
}

function fail(code: DurableTriggerErrorCode, message: string, field?: string): never {
  throw new DurableTriggerError(code, message, field);
}

function invalid(field: string, message: string): never {
  return fail("TRIGGER_INVALID", message, field);
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) invalid("name", "A trigger needs a name.");
  if (trimmed.length > TRIGGER_NAME_MAX_LENGTH) {
    invalid("name", `A trigger's name is at most ${String(TRIGGER_NAME_MAX_LENGTH)} characters.`);
  }
  return trimmed;
}

function checkTime(nowMs: number, field = "nowMs"): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    invalid(field, "Trigger times are UTC epoch milliseconds.");
  }
  return nowMs;
}

function requireActiveProject(connection: TriggerStatementRunner, projectId: string): void {
  const project = connection
    .prepare(`SELECT status FROM ${PROJECTS_TABLE} WHERE project_id = ?`)
    .get(projectId);
  if (project === undefined) {
    fail("PROJECT_NOT_FOUND", "No project exists with this id.", "projectId");
  }
  if (project["status"] !== "active") {
    fail("PROJECT_ARCHIVED", "This project is archived. Restore it first.", "projectId");
  }
}

function toTrigger(row: Record<string, unknown>): DurableTriggerRecord {
  return Object.freeze({
    triggerId: row["trigger_id"] as string,
    projectId: (row["project_id"] as string | null) ?? null,
    name: row["name"] as string,
    kind: row["kind"] as DurableTriggerKind,
    enabled: row["enabled"] === 1,
    documentHash: row["document_hash"] as string,
    compiledPlanId: row["compiled_plan_id"] as number,
    cronExpression: (row["cron_expression"] as string | null) ?? null,
    nextFireAtMs: (row["next_fire_at_ms"] as number | null) ?? null,
    hasToken: (row["token_hash"] as string | null) !== null,
    createdAtMs: row["created_at_ms"] as number,
    updatedAtMs: row["updated_at_ms"] as number,
    lastFiredAtMs: (row["last_fired_at_ms"] as number | null) ?? null,
    lastRunId: (row["last_run_id"] as string | null) ?? null,
  });
}

export function createTrigger(
  connection: TriggerStatementRunner,
  input: CreateTriggerInput,
): DurableTriggerRecord {
  if (!SORTABLE_ID_PATTERN.test(input.triggerId)) {
    invalid("triggerId", "triggerId must be a sortable UUIDv7.");
  }
  const nowMs = checkTime(input.nowMs);
  const name = checkName(input.name);
  if (!TRIGGER_KINDS.includes(input.kind)) {
    invalid("kind", `kind must be one of: ${TRIGGER_KINDS.join(", ")}.`);
  }
  if ((input.kind === "cron") !== (input.cronExpression !== undefined)) {
    invalid("cron", "A cron trigger needs a cron expression, and only a cron trigger has one.");
  }
  if (input.tokenHash !== undefined && input.kind !== "webhook" && input.kind !== "api") {
    invalid("token", "Only a webhook or api trigger has a token.");
  }
  if ((input.kind === "webhook" || input.kind === "api") && input.tokenHash === undefined) {
    invalid("token", "A webhook or api trigger needs a token.");
  }
  if (input.projectId != null) requireActiveProject(connection, input.projectId);

  connection
    .prepare(
      `INSERT INTO ${TRIGGERS_TABLE} (
        trigger_id, project_id, name, kind, enabled, document_hash, compiled_plan_id,
        cron_expression, next_fire_at_ms, token_hash, created_at_ms, updated_at_ms,
        last_fired_at_ms, last_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      input.triggerId,
      input.projectId ?? null,
      name,
      input.kind,
      input.enabled === false ? 0 : 1,
      input.documentHash,
      input.compiledPlanId,
      input.cronExpression ?? null,
      input.nextFireAtMs === undefined ? null : checkTime(input.nextFireAtMs, "nextFireAtMs"),
      input.tokenHash ?? null,
      nowMs,
      nowMs,
    );
  const stored = readTrigger(connection, input.triggerId);
  if (stored === undefined) fail("TRIGGER_NOT_FOUND", "The trigger was not stored.");
  return stored;
}

export function readTrigger(
  connection: TriggerStatementRunner,
  triggerId: string,
): DurableTriggerRecord | undefined {
  const row = connection
    .prepare(`SELECT * FROM ${TRIGGERS_TABLE} WHERE trigger_id = ?`)
    .get(triggerId);
  return row === undefined ? undefined : toTrigger(row);
}

/** The stored hash of a trigger's token, for checking a caller's. */
export function readTriggerTokenHash(
  connection: TriggerStatementRunner,
  triggerId: string,
): string | undefined {
  const row = connection
    .prepare(`SELECT token_hash AS hash FROM ${TRIGGERS_TABLE} WHERE trigger_id = ?`)
    .get(triggerId);
  const hash = row?.["hash"];
  return typeof hash === "string" ? hash : undefined;
}

export function listTriggers(
  connection: TriggerStatementRunner,
  options: { readonly projectId?: string; readonly limit?: number } = {},
): readonly DurableTriggerRecord[] {
  const requested = options.limit ?? LIST_LIMIT;
  const limit = Number.isSafeInteger(requested)
    ? Math.max(1, Math.min(requested, LIST_LIMIT))
    : LIST_LIMIT;
  const rows =
    options.projectId === undefined
      ? connection
          .prepare(
            `SELECT * FROM ${TRIGGERS_TABLE} ORDER BY created_at_ms DESC, trigger_id DESC LIMIT ?`,
          )
          .all(limit)
      : connection
          .prepare(
            `SELECT * FROM ${TRIGGERS_TABLE} WHERE project_id = ?
             ORDER BY created_at_ms DESC, trigger_id DESC LIMIT ?`,
          )
          .all(options.projectId, limit);
  return Object.freeze(rows.map(toTrigger));
}

export function updateTrigger(
  connection: TriggerStatementRunner,
  triggerId: string,
  input: UpdateTriggerInput,
): DurableTriggerRecord | undefined {
  const nowMs = checkTime(input.nowMs);
  const existing = readTrigger(connection, triggerId);
  if (existing === undefined) return undefined;
  if (
    input.name === undefined &&
    input.enabled === undefined &&
    input.cronExpression === undefined &&
    input.nextFireAtMs === undefined
  ) {
    invalid("name", "Changing a trigger needs a name, enabled state, cron or next fire time.");
  }
  if (input.cronExpression !== undefined && existing.kind !== "cron") {
    invalid("cron", "Only a cron trigger has a cron expression.");
  }

  const name = input.name === undefined ? existing.name : checkName(input.name);
  const enabled = input.enabled ?? existing.enabled;
  const cron = input.cronExpression ?? existing.cronExpression;
  const nextFireAtMs =
    input.nextFireAtMs === undefined ? existing.nextFireAtMs : input.nextFireAtMs;
  connection
    .prepare(
      `UPDATE ${TRIGGERS_TABLE}
       SET name = ?, enabled = ?, cron_expression = ?, next_fire_at_ms = ?, updated_at_ms = ?
       WHERE trigger_id = ?`,
    )
    .run(
      name,
      enabled ? 1 : 0,
      cron,
      nextFireAtMs === null ? null : checkTime(nextFireAtMs, "nextFireAtMs"),
      Math.max(nowMs, existing.createdAtMs),
      triggerId,
    );
  return readTrigger(connection, triggerId);
}

/** Record that a trigger started a run. */
export function recordTriggerFired(
  connection: TriggerStatementRunner,
  triggerId: string,
  runId: string,
  nowMs: number,
  nextFireAtMs?: number | null,
): void {
  checkTime(nowMs);
  connection
    .prepare(
      `UPDATE ${TRIGGERS_TABLE}
       SET last_fired_at_ms = ?, last_run_id = ?, updated_at_ms = ?
         ${nextFireAtMs === undefined ? "" : ", next_fire_at_ms = ?"}
       WHERE trigger_id = ?`,
    )
    .run(
      ...(nextFireAtMs === undefined
        ? [nowMs, runId, nowMs, triggerId]
        : [nowMs, runId, nowMs, nextFireAtMs, triggerId]),
    );
}

/**
 * Move a trigger's next due time without claiming a firing.
 *
 * A tick that turned out to be a duplicate still has to move the trigger on, or it
 * would stay due and be reconsidered on every pass.
 */
export function rescheduleTrigger(
  connection: TriggerStatementRunner,
  triggerId: string,
  nextFireAtMs: number | null,
  nowMs: number,
): void {
  checkTime(nowMs);
  connection
    .prepare(
      `UPDATE ${TRIGGERS_TABLE} SET next_fire_at_ms = ?, updated_at_ms = ? WHERE trigger_id = ?`,
    )
    .run(nextFireAtMs === null ? null : checkTime(nextFireAtMs, "nextFireAtMs"), nowMs, triggerId);
}

export function deleteTrigger(connection: TriggerStatementRunner, triggerId: string): boolean {
  if (readTrigger(connection, triggerId) === undefined) return false;
  connection.prepare(`DELETE FROM ${TRIGGERS_TABLE} WHERE trigger_id = ?`).run(triggerId);
  return true;
}
