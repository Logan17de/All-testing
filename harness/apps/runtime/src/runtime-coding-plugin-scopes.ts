import type { DatabaseSync } from "node:sqlite";
import type { SqliteMigration } from "@zet-harness/db";

export interface NativeChatToolScopes {
  /** Tools offered by the model node: null means all already granted; [] means none. */
  readonly model: string[] | null;
  /** Tools executable by the tool node: null means all already granted; [] means none. */
  readonly tools: string[] | null;
}

/** Durable per-conversation restrictions. This table never grants capabilities. */
export const DURABLE_NATIVE_CHAT_SCOPES_MIGRATION: SqliteMigration = Object.freeze({
  version: 24,
  name: "durable-native-chat-tool-scopes",
  sql: `
CREATE TABLE native_chat_tool_scopes (
  conversation_id TEXT PRIMARY KEY NOT NULL
    REFERENCES conversations(conversation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  model_allowlist_json TEXT CHECK (
    model_allowlist_json IS NULL OR
    (json_valid(model_allowlist_json) AND json_type(model_allowlist_json) = 'array'
      AND json_array_length(model_allowlist_json) <= 200)
  ),
  tools_allowlist_json TEXT CHECK (
    tools_allowlist_json IS NULL OR
    (json_valid(tools_allowlist_json) AND json_type(tools_allowlist_json) = 'array'
      AND json_array_length(tools_allowlist_json) <= 200)
  ),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;
`,
});

const invalid = (): TypeError => new TypeError("Invalid native chat tool scopes.");
function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > 200 ||
    /[\x00-\x1f\x7f-\x9f]/u.test(value)
  )
    throw invalid();
}
function allowlist(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 200) throw invalid();
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    identifier(id);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(id)) throw invalid();
    if (seen.has(id)) throw invalid();
    seen.add(id);
    result.push(id);
  }
  return result;
}
function scopes(value: unknown): NativeChatToolScopes {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    !Object.hasOwn(value, "model") ||
    !Object.hasOwn(value, "tools")
  )
    throw invalid();
  const input = value as Record<string, unknown>;
  return { model: allowlist(input.model), tools: allowlist(input.tools) };
}

export function readNativeChatToolScopes(
  connection: DatabaseSync,
  conversationId: string,
): NativeChatToolScopes {
  identifier(conversationId);
  const row = connection
    .prepare(
      "SELECT model_allowlist_json AS model, tools_allowlist_json AS tools FROM native_chat_tool_scopes WHERE conversation_id = ?",
    )
    .get(conversationId);
  if (!row) return { model: null, tools: null };
  try {
    return scopes({
      model: row.model === null ? null : (JSON.parse(row.model as string) as unknown),
      tools: row.tools === null ? null : (JSON.parse(row.tools as string) as unknown),
    });
  } catch {
    throw invalid();
  }
}

/** One UPSERT participates in the caller's transaction; validates before any write. */
export function saveNativeChatToolScopes(
  connection: DatabaseSync,
  conversationId: string,
  input: unknown,
  updatedAtMs: number,
): NativeChatToolScopes {
  identifier(conversationId);
  const normalized = scopes(input);
  if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) throw invalid();
  connection
    .prepare(
      `INSERT INTO native_chat_tool_scopes(conversation_id, model_allowlist_json, tools_allowlist_json, updated_at_ms)
    VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET
    model_allowlist_json = excluded.model_allowlist_json,
    tools_allowlist_json = excluded.tools_allowlist_json,
    updated_at_ms = excluded.updated_at_ms`,
    )
    .run(
      conversationId,
      normalized.model === null ? null : JSON.stringify(normalized.model),
      normalized.tools === null ? null : JSON.stringify(normalized.tools),
      updatedAtMs,
    );
  return normalized;
}
