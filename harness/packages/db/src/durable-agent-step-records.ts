import { CONVERSATIONS_TABLE, MESSAGES_TABLE } from "./durable-conversation-records.js";
import { RUNS_TABLE } from "./durable-run-records.js";
import type { SqliteMigration } from "./migrations.js";

export const AGENT_STEPS_TABLE = "agent_steps" as const;

export type DurableAgentStepKind = "model" | "tools";

/** One completed agent step, keyed by the logical effect id of the op invocation. */
export interface DurableAgentStepRecord {
  readonly logicalEffectId: string;
  readonly runId: string;
  readonly opIndex: number;
  readonly iteration: number;
  readonly kind: DurableAgentStepKind;
  readonly conversationId: string;
  /** The message the step appended, or null when it had nothing to append. */
  readonly messageId: string | null;
  readonly outputs: unknown;
  /** Null when the step reported no usage. */
  readonly usage: unknown;
  readonly recordedAtMs: number;
}

/** Append new migrations; never edit the already-shipped v1-v11 schemas. */
export const DURABLE_AGENT_STEPS_MIGRATION: SqliteMigration = Object.freeze({
  version: 12,
  name: "durable_agent_steps",
  sql: `
CREATE TABLE ${AGENT_STEPS_TABLE} (
  logical_effect_id TEXT PRIMARY KEY CHECK (length(logical_effect_id) > 0),
  run_id TEXT NOT NULL,
  op_index INTEGER NOT NULL CHECK (op_index >= 0),
  iteration INTEGER NOT NULL CHECK (iteration >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('model', 'tools')),
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  outputs_json TEXT NOT NULL CHECK (json_valid(outputs_json)),
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  FOREIGN KEY (run_id) REFERENCES ${RUNS_TABLE}(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (conversation_id) REFERENCES ${CONVERSATIONS_TABLE}(conversation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (message_id) REFERENCES ${MESSAGES_TABLE}(message_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX agent_steps_run_idx ON ${AGENT_STEPS_TABLE}(run_id, op_index, iteration);

CREATE TRIGGER agent_steps_are_append_only
BEFORE UPDATE ON ${AGENT_STEPS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'agent steps are append-only');
END;

CREATE TRIGGER agent_steps_cannot_be_deleted
BEFORE DELETE ON ${AGENT_STEPS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'agent steps are append-only');
END;
`,
});

/** Minimal statement surface, so this module does not depend on a driver type. */
export interface AgentStepStatementRunner {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): unknown;
    get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
    all(...parameters: readonly unknown[]): Record<string, unknown>[];
  };
}

export interface RecordAgentStepInput {
  readonly logicalEffectId: string;
  readonly runId: string;
  readonly opIndex: number;
  readonly iteration: number;
  readonly kind: DurableAgentStepKind;
  readonly conversationId: string;
  readonly messageId: string | null;
  readonly outputs: unknown;
  readonly usage?: unknown;
  readonly nowMs: number;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toRecord(row: Record<string, unknown>): DurableAgentStepRecord {
  const usage = row["usage_json"];
  return Object.freeze({
    logicalEffectId: text(row["logical_effect_id"]),
    runId: text(row["run_id"]),
    opIndex: integer(row["op_index"]),
    iteration: integer(row["iteration"]),
    kind: text(row["kind"]) as DurableAgentStepKind,
    conversationId: text(row["conversation_id"]),
    messageId: typeof row["message_id"] === "string" ? row["message_id"] : null,
    outputs: JSON.parse(text(row["outputs_json"])) as unknown,
    usage: typeof usage === "string" ? (JSON.parse(usage) as unknown) : null,
    recordedAtMs: integer(row["recorded_at_ms"]),
  });
}

export function readAgentStep(
  connection: AgentStepStatementRunner,
  logicalEffectId: string,
): DurableAgentStepRecord | undefined {
  const row = connection
    .prepare(`SELECT * FROM ${AGENT_STEPS_TABLE} WHERE logical_effect_id = ?`)
    .get(logicalEffectId);
  return row === undefined ? undefined : toRecord(row);
}

/** Every recorded step of a run, in op and iteration order. */
export function listRunAgentSteps(
  connection: AgentStepStatementRunner,
  runId: string,
): readonly DurableAgentStepRecord[] {
  return Object.freeze(
    connection
      .prepare(
        `SELECT * FROM ${AGENT_STEPS_TABLE} WHERE run_id = ?
         ORDER BY iteration ASC, op_index ASC, recorded_at_ms ASC`,
      )
      .all(runId)
      .map(toRecord),
  );
}

export function recordAgentStep(
  connection: AgentStepStatementRunner,
  input: RecordAgentStepInput,
): void {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new TypeError("Agent step times are UTC epoch milliseconds.");
  }
  if (input.kind !== "model" && input.kind !== "tools") {
    throw new TypeError("An agent step is a model step or a tools step.");
  }
  connection
    .prepare(
      `INSERT INTO ${AGENT_STEPS_TABLE} (
        logical_effect_id, run_id, op_index, iteration, kind, conversation_id, message_id,
        outputs_json, usage_json, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.logicalEffectId,
      input.runId,
      input.opIndex,
      input.iteration,
      input.kind,
      input.conversationId,
      input.messageId,
      JSON.stringify(input.outputs),
      input.usage === undefined || input.usage === null ? null : JSON.stringify(input.usage),
      input.nowMs,
    );
}
