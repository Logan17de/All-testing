import type { SqliteMigration } from "./migrations.js";

export const MODEL_CONFIGS_TABLE = "model_configs" as const;
export const MODEL_ID_MAX_LENGTH = 64;
export const MODEL_TITLE_MAX_LENGTH = 120;

/**
 * The endpoint families a configured model can speak to.
 *
 * These are configuration shapes, not transports: the harness speaks OpenAI-style
 * Chat Completions to all of them and a profile only records where a particular
 * server differs. `custom` is any other conforming endpoint.
 */
export const MODEL_PROFILES = ["openai", "ollama", "llama-cpp", "custom"] as const;
export type DurableModelProfile = (typeof MODEL_PROFILES)[number];

/** Where a model's key comes from, when it needs one at all. */
export const MODEL_CREDENTIALS = ["none", "stored", "environment"] as const;
export type DurableModelCredential = (typeof MODEL_CREDENTIALS)[number];

/**
 * A model this harness can call.
 *
 * Deliberately not the key itself: a record is safe to return from the API and to
 * show in a page, and the key is read separately by the runtime at the moment it
 * builds a request. A key kept in the environment is never copied into the
 * database at all — the record only remembers which variable to read.
 */
export interface DurableModelRecord {
  /** Adapter id a graph pins with `modelId`; lowercase, provider-safe. */
  readonly modelId: string;
  readonly title: string;
  readonly profile: DurableModelProfile;
  readonly baseUrl: string;
  /** The model name as the endpoint knows it, for example `llama3.1:8b`. */
  readonly model: string;
  readonly credential: DurableModelCredential;
  /** The environment variable holding the key, when the credential is an environment one. */
  readonly credentialEnv: string | null;
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly contextWindowTokens: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** Append new migrations; never edit the already-shipped schemas. */
export const DURABLE_MODEL_CONFIGS_MIGRATION: SqliteMigration = Object.freeze({
  version: 20,
  name: "durable_model_configs",
  sql: `
CREATE TABLE ${MODEL_CONFIGS_TABLE} (
  model_id TEXT PRIMARY KEY CHECK (length(model_id) BETWEEN 1 AND ${String(MODEL_ID_MAX_LENGTH)}),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND ${String(MODEL_TITLE_MAX_LENGTH)}),
  profile TEXT NOT NULL CHECK (profile IN ('openai', 'ollama', 'llama-cpp', 'custom')),
  base_url TEXT NOT NULL CHECK (length(base_url) BETWEEN 1 AND 2048),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  credential TEXT NOT NULL CHECK (credential IN ('none', 'stored', 'environment')),
  credential_env TEXT,
  api_key TEXT,
  tools INTEGER NOT NULL CHECK (tools IN (0, 1)),
  streaming INTEGER NOT NULL CHECK (streaming IN (0, 1)),
  context_window_tokens INTEGER NOT NULL CHECK (context_window_tokens > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (credential != 'stored' OR (api_key IS NOT NULL AND credential_env IS NULL)),
  CHECK (credential != 'environment' OR (credential_env IS NOT NULL AND api_key IS NULL)),
  CHECK (credential != 'none' OR (api_key IS NULL AND credential_env IS NULL))
) STRICT;

CREATE TRIGGER model_configs_keep_their_identity
BEFORE UPDATE OF model_id, created_at_ms ON ${MODEL_CONFIGS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'a model keeps its id and creation time');
END;
`,
});

export type DurableModelErrorCode =
  "MODEL_CONFIG_INVALID" | "MODEL_CONFIG_NOT_FOUND" | "MODEL_CONFIG_EXISTS";

/** A model configuration the harness refuses before it reaches SQLite. */
export class DurableModelError extends Error {
  readonly code: DurableModelErrorCode;
  readonly field: string | undefined;

  constructor(code: DurableModelErrorCode, message: string, field?: string) {
    super(message);
    this.name = "DurableModelError";
    this.code = code;
    this.field = field;
  }
}

/** Minimal statement surface, so this module does not depend on a driver type. */
export interface ModelStatementRunner {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): unknown;
    get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
    all(...parameters: readonly unknown[]): Record<string, unknown>[];
  };
}

export interface SaveModelInput {
  readonly modelId: string;
  readonly title: string;
  readonly profile: DurableModelProfile;
  readonly baseUrl: string;
  readonly model: string;
  /** Defaults to no credential at all, which is how a local endpoint usually runs. */
  readonly credential?: DurableModelCredential;
  readonly credentialEnv?: string | null;
  /** Plaintext, stored in this harness's own database; never returned by a read. */
  readonly apiKey?: string | null;
  readonly tools?: boolean;
  readonly streaming?: boolean;
  readonly contextWindowTokens: number;
  readonly nowMs: number;
}

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function invalid(message: string, field: string): never {
  throw new DurableModelError("MODEL_CONFIG_INVALID", message, field);
}

function checkTime(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    invalid("Model times are UTC epoch milliseconds.", "nowMs");
  }
  return nowMs;
}

function checkText(field: string, value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) invalid(`A model needs a ${field}.`, field);
  if (trimmed.length > maxLength) {
    invalid(`A model's ${field} is at most ${String(maxLength)} characters.`, field);
  }
  return trimmed;
}

/**
 * The endpoint a model is called at.
 *
 * Only http and https, because that is all the adapter speaks, and a key is never
 * sent in the clear to another machine: plain http is allowed for a loopback
 * endpoint, which is how a local model server is reached, and refused otherwise
 * when a key would travel with the request.
 */
function checkBaseUrl(value: string, credential: DurableModelCredential): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    invalid("A model's endpoint must be a URL.", "baseUrl");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    invalid("A model endpoint must be http or https.", "baseUrl");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    invalid("A model endpoint must not carry credentials in its URL.", "baseUrl");
  }
  if (url.protocol === "http:" && credential !== "none" && !LOOPBACK.has(url.hostname)) {
    invalid("A key is only sent over https, or to a loopback address on this machine.", "baseUrl");
  }
  return trimmed;
}

function checkKey(value: string): string {
  if (value.length === 0 || value.trim().length === 0) {
    invalid("A stored key must not be empty.", "apiKey");
  }
  if (value.length > 4096 || /[\r\n\u0000]/u.test(value)) {
    invalid("A stored key must be one line and at most 4096 characters.", "apiKey");
  }
  return value.trim();
}

function toModel(row: Record<string, unknown>): DurableModelRecord {
  return Object.freeze({
    modelId: row["model_id"] as string,
    title: row["title"] as string,
    profile: row["profile"] as DurableModelProfile,
    baseUrl: row["base_url"] as string,
    model: row["model"] as string,
    credential: row["credential"] as DurableModelCredential,
    credentialEnv: (row["credential_env"] as string | null) ?? null,
    tools: row["tools"] === 1,
    streaming: row["streaming"] === 1,
    contextWindowTokens: row["context_window_tokens"] as number,
    createdAtMs: row["created_at_ms"] as number,
    updatedAtMs: row["updated_at_ms"] as number,
  });
}

function prepared(
  input: SaveModelInput,
  options: { readonly keepStoredKey?: boolean } = {},
): {
  readonly record: Omit<DurableModelRecord, "createdAtMs" | "updatedAtMs">;
  readonly apiKey: string | null;
  readonly nowMs: number;
} {
  const nowMs = checkTime(input.nowMs);
  const modelId = input.modelId.trim();
  if (!MODEL_ID.test(modelId)) {
    invalid("A model id is lowercase letters, digits, dots, dashes or underscores.", "modelId");
  }
  if (!MODEL_PROFILES.includes(input.profile)) {
    invalid(`profile must be one of: ${MODEL_PROFILES.join(", ")}.`, "profile");
  }
  const credential = input.credential ?? "none";
  if (!MODEL_CREDENTIALS.includes(credential)) {
    invalid(`credential must be one of: ${MODEL_CREDENTIALS.join(", ")}.`, "credential");
  }
  const credentialEnv = input.credentialEnv ?? null;
  if (credential === "environment") {
    if (credentialEnv === null || !ENV_NAME.test(credentialEnv)) {
      invalid("Name the environment variable holding the key.", "credentialEnv");
    }
  } else if (credentialEnv !== null) {
    invalid("Only a model reading its key from the environment names a variable.", "credentialEnv");
  }
  const keyGiven = input.apiKey !== undefined && input.apiKey !== null;
  const apiKey =
    credential === "stored"
      ? keyGiven
        ? checkKey(input.apiKey ?? "")
        : options.keepStoredKey === true
          ? null
          : invalid("Give the key to store.", "apiKey")
      : keyGiven
        ? invalid("Only a model with a stored key carries one.", "apiKey")
        : null;
  const contextWindowTokens = input.contextWindowTokens;
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 1) {
    invalid("A context window is a positive whole number of tokens.", "contextWindowTokens");
  }
  return {
    record: {
      modelId,
      title: checkText("title", input.title, MODEL_TITLE_MAX_LENGTH),
      profile: input.profile,
      baseUrl: checkBaseUrl(input.baseUrl, credential),
      model: checkText("model", input.model, 200),
      credential,
      credentialEnv,
      tools: input.tools ?? true,
      streaming: input.streaming ?? false,
      contextWindowTokens,
    },
    apiKey,
    nowMs,
  };
}

/** Configure a model this harness can call. */
export function saveModelConfig(
  connection: ModelStatementRunner,
  input: SaveModelInput,
): DurableModelRecord {
  const { record, apiKey, nowMs } = prepared(input);
  if (readModelConfig(connection, record.modelId) !== undefined) {
    throw new DurableModelError(
      "MODEL_CONFIG_EXISTS",
      "A model with this id is already configured.",
      "modelId",
    );
  }
  connection
    .prepare(
      `INSERT INTO ${MODEL_CONFIGS_TABLE} (
        model_id, title, profile, base_url, model, credential, credential_env, api_key,
        tools, streaming, context_window_tokens, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.modelId,
      record.title,
      record.profile,
      record.baseUrl,
      record.model,
      record.credential,
      record.credentialEnv,
      apiKey,
      record.tools ? 1 : 0,
      record.streaming ? 1 : 0,
      record.contextWindowTokens,
      nowMs,
      nowMs,
    );
  const saved = readModelConfig(connection, record.modelId);
  if (saved === undefined) {
    throw new DurableModelError("MODEL_CONFIG_NOT_FOUND", "The model was not stored.");
  }
  return saved;
}

/** Replace a configured model, keeping its id and creation time. */
export function replaceModelConfig(
  connection: ModelStatementRunner,
  input: SaveModelInput,
): DurableModelRecord {
  const { record, apiKey, nowMs } = prepared(input, { keepStoredKey: true });
  const existing = readModelConfig(connection, record.modelId);
  if (existing === undefined) {
    throw new DurableModelError("MODEL_CONFIG_NOT_FOUND", "No model with this id is configured.");
  }
  if (
    record.credential === "stored" &&
    apiKey === null &&
    readModelApiKey(connection, record.modelId) === undefined
  ) {
    // Keeping a key only works when there is one to keep.
    invalid("Give the key to store.", "apiKey");
  }
  connection
    .prepare(
      `UPDATE ${MODEL_CONFIGS_TABLE}
       SET title = ?, profile = ?, base_url = ?, model = ?, credential = ?, credential_env = ?,
           api_key = CASE WHEN ? THEN ? ELSE api_key END,
           tools = ?, streaming = ?, context_window_tokens = ?, updated_at_ms = ?
       WHERE model_id = ?`,
    )
    .run(
      record.title,
      record.profile,
      record.baseUrl,
      record.model,
      record.credential,
      record.credentialEnv,
      // A replace that names no key keeps the stored one, so editing an endpoint
      // does not ask someone to paste their key again.
      record.credential === "stored" && apiKey === null ? 0 : 1,
      record.credential === "stored" ? apiKey : null,
      record.tools ? 1 : 0,
      record.streaming ? 1 : 0,
      record.contextWindowTokens,
      nowMs,
      record.modelId,
    );
  const saved = readModelConfig(connection, record.modelId);
  if (saved === undefined) {
    throw new DurableModelError("MODEL_CONFIG_NOT_FOUND", "The model was not stored.");
  }
  return saved;
}

export function readModelConfig(
  connection: ModelStatementRunner,
  modelId: string,
): DurableModelRecord | undefined {
  const row = connection
    .prepare(`SELECT * FROM ${MODEL_CONFIGS_TABLE} WHERE model_id = ?`)
    .get(modelId);
  return row === undefined ? undefined : toModel(row);
}

/** Every configured model, by id. Keys are never part of this answer. */
export function listModelConfigs(connection: ModelStatementRunner): readonly DurableModelRecord[] {
  return Object.freeze(
    connection
      .prepare(`SELECT * FROM ${MODEL_CONFIGS_TABLE} ORDER BY model_id`)
      .all()
      .map((row) => toModel(row)),
  );
}

/**
 * The key a model was configured with, read at the moment a request is built.
 *
 * Stored keys live in this harness's own database file, which is the boundary that
 * protects them: anyone who can read that file can read the key, exactly as with a
 * `.env`. A model can instead name an environment variable, and then nothing is
 * written here at all.
 */
export function readModelApiKey(
  connection: ModelStatementRunner,
  modelId: string,
): string | undefined {
  const row = connection
    .prepare(`SELECT api_key AS key FROM ${MODEL_CONFIGS_TABLE} WHERE model_id = ?`)
    .get(modelId);
  const key = row?.["key"];
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

/** Forget a configured model. Runs that already used it keep their own records. */
export function deleteModelConfig(connection: ModelStatementRunner, modelId: string): boolean {
  if (readModelConfig(connection, modelId) === undefined) return false;
  connection.prepare(`DELETE FROM ${MODEL_CONFIGS_TABLE} WHERE model_id = ?`).run(modelId);
  return true;
}
