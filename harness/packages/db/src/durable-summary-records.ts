import {
  CONVERSATIONS_TABLE,
  MESSAGES_TABLE,
  type DurableMessageUsage,
} from "./durable-conversation-records.js";
import { RUNS_TABLE } from "./durable-run-records.js";
import type { SqliteMigration } from "./migrations.js";
import { SORTABLE_ID_PATTERN } from "./sortable-id.js";

export const CONVERSATION_SUMMARIES_TABLE = "conversation_summaries" as const;
export const SUMMARY_MAX_LENGTH = 20_000;

/**
 * A conversation's older messages, compressed into text.
 *
 * A summary covers the branch from its conversation's first message through
 * `throughMessageId`, so a later step can send the summary instead of those
 * messages and keep the rest verbatim.
 */
export interface DurableConversationSummaryRecord {
  /** Sortable UUIDv7. */
  readonly summaryId: string;
  readonly conversationId: string;
  /** The last message this summary covers. */
  readonly throughMessageId: string;
  readonly summary: string;
  /** How many messages were folded into it. */
  readonly messageCount: number;
  /** The model that wrote it, as `id@version`. */
  readonly model: string | null;
  /** The run whose step wrote it, when one did. */
  readonly runId: string | null;
  readonly usage: DurableMessageUsage;
  readonly createdAtMs: number;
}

/** Append new migrations; never edit the already-shipped schemas. */
export const DURABLE_CONVERSATION_SUMMARIES_MIGRATION: SqliteMigration = Object.freeze({
  version: 16,
  name: "durable_conversation_summaries",
  sql: `
CREATE TABLE ${CONVERSATION_SUMMARIES_TABLE} (
  summary_id TEXT PRIMARY KEY CHECK (length(summary_id) = 36),
  conversation_id TEXT NOT NULL,
  through_message_id TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND ${String(SUMMARY_MAX_LENGTH)}),
  message_count INTEGER NOT NULL CHECK (message_count >= 1),
  model TEXT,
  run_id TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (conversation_id, through_message_id),
  FOREIGN KEY (conversation_id)
    REFERENCES ${CONVERSATIONS_TABLE}(conversation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (through_message_id)
    REFERENCES ${MESSAGES_TABLE}(message_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (run_id)
    REFERENCES ${RUNS_TABLE}(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX conversation_summaries_recent_idx
ON ${CONVERSATION_SUMMARIES_TABLE}(conversation_id, created_at_ms DESC);

CREATE TRIGGER conversation_summaries_are_append_only
BEFORE UPDATE ON ${CONVERSATION_SUMMARIES_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'a conversation summary is written once');
END;
`,
});

/** Minimal statement surface, so this module does not depend on a driver type. */
export interface SummaryStatementRunner {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): unknown;
    get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
    all(...parameters: readonly unknown[]): Record<string, unknown>[];
  };
}

export interface RecordSummaryInput {
  readonly summaryId: string;
  readonly conversationId: string;
  readonly throughMessageId: string;
  readonly summary: string;
  readonly messageCount: number;
  readonly model?: string;
  readonly runId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly nowMs: number;
}

export class DurableSummaryError extends Error {
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "DurableSummaryError";
    this.field = field;
  }
}

function toSummary(row: Record<string, unknown>): DurableConversationSummaryRecord {
  const inputTokens = row["input_tokens"] as number | null;
  const outputTokens = row["output_tokens"] as number | null;
  return Object.freeze({
    summaryId: row["summary_id"] as string,
    conversationId: row["conversation_id"] as string,
    throughMessageId: row["through_message_id"] as string,
    summary: row["summary"] as string,
    messageCount: row["message_count"] as number,
    model: (row["model"] as string | null) ?? null,
    runId: (row["run_id"] as string | null) ?? null,
    usage: Object.freeze({
      ...(inputTokens === null ? {} : { inputTokens }),
      ...(outputTokens === null ? {} : { outputTokens }),
    }),
    createdAtMs: row["created_at_ms"] as number,
  });
}

/**
 * Record one summary. Writing the same cut twice keeps the first, so a retried step
 * reuses the summary it already paid for rather than writing a second one.
 */
export function recordConversationSummary(
  connection: SummaryStatementRunner,
  input: RecordSummaryInput,
): DurableConversationSummaryRecord {
  if (!SORTABLE_ID_PATTERN.test(input.summaryId)) {
    throw new DurableSummaryError("summaryId must be a sortable UUIDv7.", "summaryId");
  }
  const summary = input.summary.trim();
  if (summary.length === 0 || summary.length > SUMMARY_MAX_LENGTH) {
    throw new DurableSummaryError(
      `A summary is between 1 and ${String(SUMMARY_MAX_LENGTH)} characters.`,
      "summary",
    );
  }
  if (!Number.isSafeInteger(input.messageCount) || input.messageCount < 1) {
    throw new DurableSummaryError("messageCount must be a positive integer.", "messageCount");
  }
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new DurableSummaryError("Summary times are UTC epoch milliseconds.", "nowMs");
  }

  connection
    .prepare(
      `INSERT INTO ${CONVERSATION_SUMMARIES_TABLE} (
        summary_id, conversation_id, through_message_id, summary, message_count, model, run_id,
        input_tokens, output_tokens, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, through_message_id) DO NOTHING`,
    )
    .run(
      input.summaryId,
      input.conversationId,
      input.throughMessageId,
      summary,
      input.messageCount,
      input.model ?? null,
      input.runId ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.nowMs,
    );

  const stored = connection
    .prepare(
      `SELECT * FROM ${CONVERSATION_SUMMARIES_TABLE}
       WHERE conversation_id = ? AND through_message_id = ?`,
    )
    .get(input.conversationId, input.throughMessageId);
  if (stored === undefined) throw new DurableSummaryError("The summary was not stored.");
  return toSummary(stored);
}

/** Every summary of a conversation, newest first. */
export function listConversationSummaries(
  connection: SummaryStatementRunner,
  conversationId: string,
): readonly DurableConversationSummaryRecord[] {
  const rows = connection
    .prepare(
      `SELECT * FROM ${CONVERSATION_SUMMARIES_TABLE} WHERE conversation_id = ?
       ORDER BY created_at_ms DESC, summary_id DESC`,
    )
    .all(conversationId);
  return Object.freeze(rows.map(toSummary));
}

/**
 * The summary covering the most of one branch.
 *
 * `branchMessageIds` is the branch in order, oldest first. A summary counts only if
 * the message it covers is on this branch, so an edit into a different branch never
 * inherits a summary of messages it does not contain.
 */
export function summaryForBranch(
  connection: SummaryStatementRunner,
  conversationId: string,
  branchMessageIds: readonly string[],
): { readonly summary: DurableConversationSummaryRecord; readonly index: number } | undefined {
  const position = new Map(branchMessageIds.map((id, index) => [id, index]));
  let best: { summary: DurableConversationSummaryRecord; index: number } | undefined;
  for (const summary of listConversationSummaries(connection, conversationId)) {
    const index = position.get(summary.throughMessageId);
    if (index === undefined) continue;
    if (best === undefined || index > best.index) best = { summary, index };
  }
  return best;
}
