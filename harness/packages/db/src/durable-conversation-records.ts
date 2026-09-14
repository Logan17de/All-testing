import { PROJECTS_TABLE } from "./durable-project-records.js";
import { RUNS_TABLE } from "./durable-run-records.js";
import type { SqliteMigration } from "./migrations.js";
import { SORTABLE_ID_PATTERN } from "./sortable-id.js";

export const CONVERSATIONS_TABLE = "conversations" as const;
export const MESSAGES_TABLE = "messages" as const;
export const CONVERSATION_TITLE_MAX_LENGTH = 200;
export const MESSAGE_MAX_PARTS = 256;
/** Upper bound on one message's serialized parts. */
export const MESSAGE_CONTENT_MAX_BYTES = 1_048_576;
const IDENTIFIER_MAX_LENGTH = 200;
const MESSAGE_LIST_LIMIT = 10_000;

export type DurableConversationStatus = "active" | "archived";
export type ConversationListStatus = DurableConversationStatus | "all";

export const MESSAGE_ROLES = ["system", "developer", "user", "assistant", "tool"] as const;
export type DurableMessageRole = (typeof MESSAGE_ROLES)[number];

/** Message parts mirror the model adapter contract, plus reasoning kept apart from text. */
export interface DurableTextPart {
  readonly kind: "text";
  readonly text: string;
}
/** What a model thought, stored separately from what it said. */
export interface DurableReasoningPart {
  readonly kind: "reasoning";
  readonly text: string;
}
export interface DurableImagePart {
  readonly kind: "image";
  readonly artifactRef: string;
  readonly mediaType: string;
}
export interface DurableToolCallPart {
  readonly kind: "tool-call";
  readonly callId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}
export interface DurableToolResultPart {
  readonly kind: "tool-result";
  readonly callId: string;
  readonly value: unknown;
  readonly isError?: boolean;
}
export type DurableMessagePart =
  | DurableTextPart
  | DurableReasoningPart
  | DurableImagePart
  | DurableToolCallPart
  | DurableToolResultPart;

/** Provider-reported usage, captured when the message is stored because it cannot be recovered later. */
export interface DurableMessageUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  /** A decimal string, never a float, and only when the provider reports a price. */
  readonly cost?: { readonly amountDecimal: string; readonly currency: string };
}

export interface DurableConversationRecord {
  /** Sortable UUIDv7. */
  readonly conversationId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: DurableConversationStatus;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly archivedAtMs: number | null;
}

export interface DurableMessageRecord {
  /** Sortable UUIDv7; messages of a conversation sort by it in the order they were stored. */
  readonly messageId: string;
  readonly conversationId: string;
  /** The message this one answers or follows; siblings with one parent are edit/retry branches. */
  readonly parentMessageId: string | null;
  readonly role: DurableMessageRole;
  readonly parts: readonly DurableMessagePart[];
  readonly model: string | null;
  /** The run that produced this message, when one did. */
  readonly runId: string | null;
  readonly usage: DurableMessageUsage;
  readonly createdAtMs: number;
}

/** Append new migrations; never edit the already-shipped v1-v8 schemas. */
export const DURABLE_CONVERSATIONS_MIGRATION: SqliteMigration = Object.freeze({
  version: 9,
  name: "durable_conversations_and_messages",
  sql: `
CREATE TABLE ${CONVERSATIONS_TABLE} (
  conversation_id TEXT PRIMARY KEY CHECK (length(conversation_id) = 36),
  project_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) <= ${String(CONVERSATION_TITLE_MAX_LENGTH)}),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  archived_at_ms INTEGER CHECK (archived_at_ms IS NULL OR archived_at_ms >= created_at_ms),
  CHECK ((status = 'active') = (archived_at_ms IS NULL)),
  FOREIGN KEY (project_id) REFERENCES ${PROJECTS_TABLE}(project_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX conversations_project_status_updated_idx
ON ${CONVERSATIONS_TABLE}(project_id, status, updated_at_ms DESC, conversation_id DESC);

CREATE TRIGGER conversations_cannot_be_deleted
BEFORE DELETE ON ${CONVERSATIONS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'conversations are archived, never deleted');
END;

CREATE TRIGGER conversations_keep_their_identity
BEFORE UPDATE OF conversation_id, project_id, created_at_ms ON ${CONVERSATIONS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'a conversation keeps its id, project and creation time');
END;

CREATE TABLE ${MESSAGES_TABLE} (
  message_id TEXT PRIMARY KEY CHECK (length(message_id) = 36),
  conversation_id TEXT NOT NULL,
  parent_message_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('system', 'developer', 'user', 'assistant', 'tool')),
  content_json TEXT NOT NULL CHECK (
    json_valid(content_json)
    AND json_type(content_json) = 'array'
    AND json_array_length(content_json) >= 1
    AND length(CAST(content_json AS BLOB)) <= ${String(MESSAGE_CONTENT_MAX_BYTES)}
  ),
  model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND ${String(IDENTIFIER_MAX_LENGTH)}),
  run_id TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  cost_amount_decimal TEXT CHECK (
    cost_amount_decimal IS NULL OR length(cost_amount_decimal) BETWEEN 1 AND 64
  ),
  cost_currency TEXT CHECK (cost_currency IS NULL OR length(cost_currency) = 3),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  CHECK (parent_message_id IS NULL OR parent_message_id <> message_id),
  CHECK ((cost_amount_decimal IS NULL) = (cost_currency IS NULL)),
  UNIQUE (message_id, conversation_id),
  FOREIGN KEY (conversation_id) REFERENCES ${CONVERSATIONS_TABLE}(conversation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (parent_message_id, conversation_id)
    REFERENCES ${MESSAGES_TABLE}(message_id, conversation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES ${RUNS_TABLE}(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX messages_conversation_idx ON ${MESSAGES_TABLE}(conversation_id, message_id);
CREATE INDEX messages_parent_idx ON ${MESSAGES_TABLE}(parent_message_id);

CREATE TRIGGER messages_are_append_only
BEFORE UPDATE ON ${MESSAGES_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'messages are append-only');
END;

CREATE TRIGGER messages_cannot_be_deleted
BEFORE DELETE ON ${MESSAGES_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'messages are append-only');
END;
`,
});

export type DurableConversationErrorCode =
  | "CONVERSATION_INVALID"
  | "CONVERSATION_NOT_FOUND"
  | "CONVERSATION_ARCHIVED"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ARCHIVED";

/** A conversation or message write the harness refuses before it reaches SQLite. */
export class DurableConversationError extends Error {
  readonly code: DurableConversationErrorCode;
  /** The input field at fault, when there is one. */
  readonly field: string | undefined;

  constructor(code: DurableConversationErrorCode, message: string, field?: string) {
    super(message);
    this.name = "DurableConversationError";
    this.code = code;
    this.field = field;
  }
}

/** Minimal statement surface, so this module does not depend on a driver type. */
export interface ConversationStatementRunner {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): unknown;
    get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
    all(...parameters: readonly unknown[]): Record<string, unknown>[];
  };
}

export interface CreateConversationInput {
  readonly conversationId: string;
  readonly projectId: string;
  readonly title?: string;
  readonly nowMs: number;
}

export interface ListConversationsOptions {
  /** Defaults to active conversations. */
  readonly status?: ConversationListStatus;
  /** Defaults to 200, at most 1000. */
  readonly limit?: number;
}

export interface AppendMessageInput {
  readonly messageId: string;
  readonly conversationId: string;
  /**
   * Omit to continue from the conversation's latest message. Name an earlier
   * message to branch from it (an edit or a retry), or pass null to start a new root.
   */
  readonly parentMessageId?: string | null;
  readonly role: DurableMessageRole;
  /** Validated in full: every part is checked against its kind and the message role. */
  readonly parts: readonly DurableMessagePart[];
  readonly model?: string | null;
  readonly runId?: string | null;
  readonly usage?: DurableMessageUsage;
  readonly nowMs: number;
}

const MEDIA_TYPE_PATTERN = /^image\/[a-z0-9.+-]+$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,30})(?:\.[0-9]{1,18})?$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

function invalid(field: string, message: string): never {
  throw new DurableConversationError("CONVERSATION_INVALID", message, field);
}

function checkTime(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    invalid("nowMs", "Conversation times are UTC epoch milliseconds.");
  }
  return nowMs;
}

function checkId(field: string, id: string): string {
  if (!SORTABLE_ID_PATTERN.test(id)) invalid(field, `${field} must be a sortable UUIDv7.`);
  return id;
}

function checkTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length > CONVERSATION_TITLE_MAX_LENGTH) {
    invalid(
      "title",
      `A conversation title is at most ${String(CONVERSATION_TITLE_MAX_LENGTH)} characters.`,
    );
  }
  return trimmed;
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    invalid(field, `${field} must be a non-empty string of at most ${String(max)} characters.`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function jsonValue(value: unknown, field: string): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid(field, `${field} must be JSON data.`);
  }
  if (serialized === undefined) invalid(field, `${field} must be JSON data.`);
  return JSON.parse(serialized) as unknown;
}

function checkKeys(part: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(part)) {
    if (!allowed.includes(key)) invalid(field, `Message part field '${key}' is not allowed here.`);
  }
}

function checkPart(value: unknown, index: number, role: DurableMessageRole): DurableMessagePart {
  const field = `parts[${String(index)}]`;
  if (!isPlainObject(value)) invalid(field, "Each message part must be an object.");
  switch (value["kind"]) {
    case "text": {
      checkKeys(value, ["kind", "text"], field);
      if (role === "tool") invalid(field, "A tool message carries only tool results.");
      const text = value["text"];
      if (typeof text !== "string") invalid(`${field}.text`, "A text part needs text.");
      return { kind: "text", text };
    }
    case "reasoning": {
      checkKeys(value, ["kind", "text"], field);
      if (role !== "assistant") invalid(field, "Only assistant messages carry reasoning.");
      const text = value["text"];
      if (typeof text !== "string") invalid(`${field}.text`, "A reasoning part needs text.");
      return { kind: "reasoning", text };
    }
    case "image": {
      checkKeys(value, ["kind", "artifactRef", "mediaType"], field);
      if (role !== "user" && role !== "assistant") {
        invalid(field, "Only user and assistant messages carry images.");
      }
      const artifactRef = boundedString(value["artifactRef"], `${field}.artifactRef`, 512);
      const mediaType = boundedString(value["mediaType"], `${field}.mediaType`, 100);
      if (!MEDIA_TYPE_PATTERN.test(mediaType)) {
        invalid(`${field}.mediaType`, "An image part needs an image media type.");
      }
      return { kind: "image", artifactRef, mediaType };
    }
    case "tool-call": {
      checkKeys(value, ["kind", "callId", "name", "arguments"], field);
      if (role !== "assistant") invalid(field, "Only assistant messages call tools.");
      const callId = boundedString(value["callId"], `${field}.callId`, IDENTIFIER_MAX_LENGTH);
      const name = boundedString(value["name"], `${field}.name`, IDENTIFIER_MAX_LENGTH);
      const args = value["arguments"];
      if (!isPlainObject(args)) {
        invalid(`${field}.arguments`, "Tool call arguments must be a JSON object.");
      }
      return {
        kind: "tool-call",
        callId,
        name,
        arguments: jsonValue(args, `${field}.arguments`) as Record<string, unknown>,
      };
    }
    case "tool-result": {
      checkKeys(value, ["kind", "callId", "value", "isError"], field);
      if (role !== "tool") invalid(field, "Only tool messages carry tool results.");
      const callId = boundedString(value["callId"], `${field}.callId`, IDENTIFIER_MAX_LENGTH);
      if (!("value" in value)) invalid(`${field}.value`, "A tool result needs a value.");
      const result = jsonValue(value["value"], `${field}.value`);
      const isError = value["isError"];
      if (isError !== undefined && typeof isError !== "boolean") {
        invalid(`${field}.isError`, "isError must be a boolean.");
      }
      return {
        kind: "tool-result",
        callId,
        value: result,
        ...(isError === undefined ? {} : { isError }),
      };
    }
    default:
      return invalid(`${field}.kind`, "Unknown message part kind.");
  }
}

function checkParts(parts: unknown, role: DurableMessageRole): readonly DurableMessagePart[] {
  if (!Array.isArray(parts) || parts.length === 0) {
    invalid("parts", "A message needs at least one part.");
  }
  if (parts.length > MESSAGE_MAX_PARTS) {
    invalid("parts", `A message has at most ${String(MESSAGE_MAX_PARTS)} parts.`);
  }
  const checked = parts.map((part: unknown, index) => checkPart(part, index, role));
  if (Buffer.byteLength(JSON.stringify(checked), "utf8") > MESSAGE_CONTENT_MAX_BYTES) {
    invalid("parts", `A message's parts are at most ${String(MESSAGE_CONTENT_MAX_BYTES)} bytes.`);
  }
  return Object.freeze(checked);
}

interface StoredUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly costAmountDecimal: string | null;
  readonly costCurrency: string | null;
}

function tokenCount(value: number | undefined, field: string): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(field, "Token counts are non-negative integers.");
  }
  return value;
}

function checkUsage(usage: DurableMessageUsage | undefined): StoredUsage {
  const cost = usage?.cost;
  if (cost !== undefined) {
    if (typeof cost.amountDecimal !== "string" || !DECIMAL_PATTERN.test(cost.amountDecimal)) {
      invalid("usage.cost.amountDecimal", "A cost is a non-negative decimal string.");
    }
    if (typeof cost.currency !== "string" || !CURRENCY_PATTERN.test(cost.currency)) {
      invalid("usage.cost.currency", "A cost currency is a three-letter ISO 4217 code.");
    }
  }
  return {
    inputTokens: tokenCount(usage?.inputTokens, "usage.inputTokens"),
    outputTokens: tokenCount(usage?.outputTokens, "usage.outputTokens"),
    cachedInputTokens: tokenCount(usage?.cachedInputTokens, "usage.cachedInputTokens"),
    reasoningTokens: tokenCount(usage?.reasoningTokens, "usage.reasoningTokens"),
    costAmountDecimal: cost?.amountDecimal ?? null,
    costCurrency: cost?.currency ?? null,
  };
}

function usageRecord(usage: StoredUsage): DurableMessageUsage {
  return Object.freeze({
    ...(usage.inputTokens === null ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === null ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cachedInputTokens === null ? {} : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.reasoningTokens === null ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(usage.costAmountDecimal === null || usage.costCurrency === null
      ? {}
      : {
          cost: Object.freeze({
            amountDecimal: usage.costAmountDecimal,
            currency: usage.costCurrency,
          }),
        }),
  });
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

function toConversation(row: Record<string, unknown>): DurableConversationRecord {
  return Object.freeze({
    conversationId: text(row["conversation_id"]),
    projectId: text(row["project_id"]),
    title: text(row["title"]),
    status: text(row["status"]) as DurableConversationStatus,
    createdAtMs: integer(row["created_at_ms"]),
    updatedAtMs: integer(row["updated_at_ms"]),
    archivedAtMs: optionalInteger(row["archived_at_ms"]),
  });
}

function toMessage(row: Record<string, unknown>): DurableMessageRecord {
  return Object.freeze({
    messageId: text(row["message_id"]),
    conversationId: text(row["conversation_id"]),
    parentMessageId: optionalText(row["parent_message_id"]),
    role: text(row["role"]) as DurableMessageRole,
    parts: Object.freeze(JSON.parse(text(row["content_json"])) as DurableMessagePart[]),
    model: optionalText(row["model"]),
    runId: optionalText(row["run_id"]),
    usage: usageRecord({
      inputTokens: optionalInteger(row["input_tokens"]),
      outputTokens: optionalInteger(row["output_tokens"]),
      cachedInputTokens: optionalInteger(row["cached_input_tokens"]),
      reasoningTokens: optionalInteger(row["reasoning_tokens"]),
      costAmountDecimal: optionalText(row["cost_amount_decimal"]),
      costCurrency: optionalText(row["cost_currency"]),
    }),
    createdAtMs: integer(row["created_at_ms"]),
  });
}

/** Conversations and messages only change inside an active project. */
function requireActiveProject(connection: ConversationStatementRunner, projectId: string): void {
  const project = connection
    .prepare(`SELECT status FROM ${PROJECTS_TABLE} WHERE project_id = ?`)
    .get(projectId);
  if (project === undefined) {
    throw new DurableConversationError(
      "PROJECT_NOT_FOUND",
      "No project exists with this id.",
      "projectId",
    );
  }
  if (project["status"] !== "active") {
    throw new DurableConversationError(
      "PROJECT_ARCHIVED",
      "This project is archived. Restore it before changing its conversations.",
      "projectId",
    );
  }
}

/** Start an active conversation in an active project. */
export function createConversation(
  connection: ConversationStatementRunner,
  input: CreateConversationInput,
): DurableConversationRecord {
  const conversationId = checkId("conversationId", input.conversationId);
  const nowMs = checkTime(input.nowMs);
  const title = checkTitle(input.title ?? "");
  requireActiveProject(connection, input.projectId);

  connection
    .prepare(
      `INSERT INTO ${CONVERSATIONS_TABLE} (
        conversation_id, project_id, title, status, created_at_ms, updated_at_ms, archived_at_ms
      ) VALUES (?, ?, ?, 'active', ?, ?, NULL)`,
    )
    .run(conversationId, input.projectId, title, nowMs, nowMs);

  return Object.freeze({
    conversationId,
    projectId: input.projectId,
    title,
    status: "active",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    archivedAtMs: null,
  });
}

export function readConversation(
  connection: ConversationStatementRunner,
  conversationId: string,
): DurableConversationRecord | undefined {
  const row = connection
    .prepare(`SELECT * FROM ${CONVERSATIONS_TABLE} WHERE conversation_id = ?`)
    .get(conversationId);
  return row === undefined ? undefined : toConversation(row);
}

/** A project's conversations, most recently changed first. */
export function listConversations(
  connection: ConversationStatementRunner,
  projectId: string,
  options: ListConversationsOptions = {},
): readonly DurableConversationRecord[] {
  const status = options.status ?? "active";
  const requested = options.limit ?? 200;
  const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(requested, 1_000)) : 200;
  const rows =
    status === "all"
      ? connection
          .prepare(
            `SELECT * FROM ${CONVERSATIONS_TABLE} WHERE project_id = ?
             ORDER BY updated_at_ms DESC, conversation_id DESC LIMIT ?`,
          )
          .all(projectId, limit)
      : connection
          .prepare(
            `SELECT * FROM ${CONVERSATIONS_TABLE} WHERE project_id = ? AND status = ?
             ORDER BY updated_at_ms DESC, conversation_id DESC LIMIT ?`,
          )
          .all(projectId, status, limit);
  return Object.freeze(rows.map(toConversation));
}

function writableConversation(
  connection: ConversationStatementRunner,
  conversationId: string,
): DurableConversationRecord | undefined {
  const current = readConversation(connection, conversationId);
  if (current === undefined) return undefined;
  requireActiveProject(connection, current.projectId);
  return current;
}

/** Retitle an active conversation. Returns undefined when no conversation has this id. */
export function renameConversation(
  connection: ConversationStatementRunner,
  conversationId: string,
  title: string,
  nowMs: number,
): DurableConversationRecord | undefined {
  const time = checkTime(nowMs);
  const nextTitle = checkTitle(title);
  const current = writableConversation(connection, conversationId);
  if (current === undefined) return undefined;
  if (current.status === "archived") {
    throw new DurableConversationError(
      "CONVERSATION_ARCHIVED",
      "This conversation is archived. Restore it before changing it.",
    );
  }
  const updatedAtMs = Math.max(time, current.updatedAtMs);
  connection
    .prepare(
      `UPDATE ${CONVERSATIONS_TABLE} SET title = ?, updated_at_ms = ? WHERE conversation_id = ?`,
    )
    .run(nextTitle, updatedAtMs, conversationId);
  return Object.freeze({ ...current, title: nextTitle, updatedAtMs });
}

function setConversationStatus(
  connection: ConversationStatementRunner,
  conversationId: string,
  status: DurableConversationStatus,
  nowMs: number,
): DurableConversationRecord | undefined {
  const time = checkTime(nowMs);
  const current = writableConversation(connection, conversationId);
  if (current === undefined) return undefined;
  if (current.status === status) return current;
  const updatedAtMs = Math.max(time, current.updatedAtMs);
  const archivedAtMs = status === "archived" ? updatedAtMs : null;
  connection
    .prepare(
      `UPDATE ${CONVERSATIONS_TABLE}
       SET status = ?, archived_at_ms = ?, updated_at_ms = ?
       WHERE conversation_id = ?`,
    )
    .run(status, archivedAtMs, updatedAtMs, conversationId);
  return Object.freeze({ ...current, status, archivedAtMs, updatedAtMs });
}

/** Archive a conversation. Archiving an archived conversation changes nothing. */
export function archiveConversation(
  connection: ConversationStatementRunner,
  conversationId: string,
  nowMs: number,
): DurableConversationRecord | undefined {
  return setConversationStatus(connection, conversationId, "archived", nowMs);
}

/** Make an archived conversation active again. */
export function restoreConversation(
  connection: ConversationStatementRunner,
  conversationId: string,
  nowMs: number,
): DurableConversationRecord | undefined {
  return setConversationStatus(connection, conversationId, "active", nowMs);
}

/**
 * Append one message to an active conversation.
 *
 * Messages are never edited or deleted. Editing a message or retrying a reply
 * appends a sibling that shares the original's parent, so every branch stays
 * readable with `readMessagePath`.
 */
export function appendMessage(
  connection: ConversationStatementRunner,
  input: AppendMessageInput,
): DurableMessageRecord {
  const messageId = checkId("messageId", input.messageId);
  const nowMs = checkTime(input.nowMs);
  if (!(MESSAGE_ROLES as readonly string[]).includes(input.role)) {
    invalid("role", `role must be one of ${MESSAGE_ROLES.join(", ")}.`);
  }
  const parts = checkParts(input.parts, input.role);
  const model =
    input.model === undefined || input.model === null
      ? null
      : boundedString(input.model, "model", IDENTIFIER_MAX_LENGTH);
  const runId =
    input.runId === undefined || input.runId === null
      ? null
      : boundedString(input.runId, "runId", IDENTIFIER_MAX_LENGTH);
  const usage = checkUsage(input.usage);

  const conversation = readConversation(connection, input.conversationId);
  if (conversation === undefined) {
    throw new DurableConversationError(
      "CONVERSATION_NOT_FOUND",
      "No conversation exists with this id.",
      "conversationId",
    );
  }
  if (conversation.status === "archived") {
    throw new DurableConversationError(
      "CONVERSATION_ARCHIVED",
      "This conversation is archived. Restore it before adding messages.",
    );
  }
  requireActiveProject(connection, conversation.projectId);

  let parentMessageId: string | null;
  if (input.parentMessageId === undefined) {
    const latest = connection
      .prepare(
        `SELECT message_id FROM ${MESSAGES_TABLE} WHERE conversation_id = ?
         ORDER BY message_id DESC LIMIT 1`,
      )
      .get(conversation.conversationId);
    parentMessageId = latest === undefined ? null : text(latest["message_id"]);
  } else if (input.parentMessageId === null) {
    parentMessageId = null;
  } else {
    const parent = connection
      .prepare(
        `SELECT message_id FROM ${MESSAGES_TABLE} WHERE message_id = ? AND conversation_id = ?`,
      )
      .get(input.parentMessageId, conversation.conversationId);
    if (parent === undefined) {
      invalid("parentMessageId", "The parent message is not part of this conversation.");
    }
    parentMessageId = input.parentMessageId;
  }

  connection
    .prepare(
      `INSERT INTO ${MESSAGES_TABLE} (
        message_id, conversation_id, parent_message_id, role, content_json, model, run_id,
        input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
        cost_amount_decimal, cost_currency, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      messageId,
      conversation.conversationId,
      parentMessageId,
      input.role,
      JSON.stringify(parts),
      model,
      runId,
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedInputTokens,
      usage.reasoningTokens,
      usage.costAmountDecimal,
      usage.costCurrency,
      nowMs,
    );
  connection
    .prepare(`UPDATE ${CONVERSATIONS_TABLE} SET updated_at_ms = ? WHERE conversation_id = ?`)
    .run(Math.max(nowMs, conversation.updatedAtMs), conversation.conversationId);

  return Object.freeze({
    messageId,
    conversationId: conversation.conversationId,
    parentMessageId,
    role: input.role,
    parts,
    model,
    runId,
    usage: usageRecord(usage),
    createdAtMs: nowMs,
  });
}

/** Every message of a conversation, across all branches, in the order they were stored. */
export function readConversationMessages(
  connection: ConversationStatementRunner,
  conversationId: string,
): readonly DurableMessageRecord[] {
  const rows = connection
    .prepare(
      `SELECT * FROM ${MESSAGES_TABLE} WHERE conversation_id = ?
       ORDER BY message_id ASC LIMIT ${String(MESSAGE_LIST_LIMIT)}`,
    )
    .all(conversationId);
  return Object.freeze(rows.map(toMessage));
}

/**
 * One branch: the messages from the root down to `messageId`, oldest first.
 * Empty when no message has this id.
 */
export function readMessagePath(
  connection: ConversationStatementRunner,
  messageId: string,
): readonly DurableMessageRecord[] {
  const rows = connection
    .prepare(
      `WITH RECURSIVE branch(message_id, parent_message_id, depth) AS (
         SELECT message_id, parent_message_id, 0 FROM ${MESSAGES_TABLE} WHERE message_id = ?
         UNION ALL
         SELECT m.message_id, m.parent_message_id, branch.depth + 1
         FROM ${MESSAGES_TABLE} AS m JOIN branch ON m.message_id = branch.parent_message_id
       )
       SELECT m.* FROM branch JOIN ${MESSAGES_TABLE} AS m ON m.message_id = branch.message_id
       ORDER BY branch.depth DESC`,
    )
    .all(messageId);
  return Object.freeze(rows.map(toMessage));
}
