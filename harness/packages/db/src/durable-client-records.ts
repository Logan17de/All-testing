import type { SqliteMigration } from "./migrations.js";
import { SORTABLE_ID_PATTERN } from "./sortable-id.js";

export const CLIENT_SESSIONS_TABLE = "client_sessions" as const;
export const CLIENT_NAME_MAX_LENGTH = 200;
const LIST_LIMIT = 200;

/**
 * What a client is allowed to do.
 *
 * `read` sees runs, conversations and pending approvals. `messages` adds to a
 * conversation and wakes a run. `approvals` answers a human gate. They are separate
 * because a client that only needs to watch should not be able to answer for a person.
 */
export const CLIENT_SCOPES = ["read", "messages", "approvals"] as const;
export type DurableClientScope = (typeof CLIENT_SCOPES)[number];

/**
 * A client that reaches the harness from outside the editor.
 *
 * The client holds a token; only its hash is stored, so a lost token can be revoked
 * but never recovered. A session is never deleted: revoking it keeps the record of
 * what once had access.
 */
export interface DurableClientRecord {
  /** Sortable UUIDv7. */
  readonly clientId: string;
  readonly name: string;
  readonly scopes: readonly DurableClientScope[];
  readonly createdAtMs: number;
  readonly lastSeenAtMs: number | null;
  readonly revokedAtMs: number | null;
}

/** Append new migrations; never edit the already-shipped schemas. */
export const DURABLE_CLIENT_SESSIONS_MIGRATION: SqliteMigration = Object.freeze({
  version: 19,
  name: "durable_client_sessions",
  sql: `
CREATE TABLE ${CLIENT_SESSIONS_TABLE} (
  client_id TEXT PRIMARY KEY CHECK (length(client_id) = 36),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${String(CLIENT_NAME_MAX_LENGTH)}),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  scopes_json TEXT NOT NULL CHECK (length(scopes_json) > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  last_seen_at_ms INTEGER CHECK (last_seen_at_ms IS NULL OR last_seen_at_ms >= created_at_ms),
  revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX client_sessions_recent_idx
ON ${CLIENT_SESSIONS_TABLE}(created_at_ms DESC, client_id DESC);

CREATE TRIGGER client_sessions_keep_their_identity
BEFORE UPDATE OF client_id, token_hash, scopes_json, created_at_ms ON ${CLIENT_SESSIONS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'a client session keeps its id, token, scopes and creation time');
END;

CREATE TRIGGER client_sessions_cannot_be_deleted
BEFORE DELETE ON ${CLIENT_SESSIONS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'client sessions are revoked, never deleted');
END;
`,
});

export class DurableClientError extends Error {
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "DurableClientError";
    this.field = field;
  }
}

/** Minimal statement surface, so this module does not depend on a driver type. */
export interface ClientStatementRunner {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): unknown;
    get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
    all(...parameters: readonly unknown[]): Record<string, unknown>[];
  };
}

export interface CreateClientInput {
  readonly clientId: string;
  readonly name: string;
  /** The sha-256 of the token this client will present. */
  readonly tokenHash: string;
  readonly scopes: readonly DurableClientScope[];
  readonly nowMs: number;
}

function toClient(row: Record<string, unknown>): DurableClientRecord {
  const scopes = JSON.parse(row["scopes_json"] as string) as DurableClientScope[];
  return Object.freeze({
    clientId: row["client_id"] as string,
    name: row["name"] as string,
    scopes: Object.freeze(scopes),
    createdAtMs: row["created_at_ms"] as number,
    lastSeenAtMs: (row["last_seen_at_ms"] as number | null) ?? null,
    revokedAtMs: (row["revoked_at_ms"] as number | null) ?? null,
  });
}

export function createClientSession(
  connection: ClientStatementRunner,
  input: CreateClientInput,
): DurableClientRecord {
  if (!SORTABLE_ID_PATTERN.test(input.clientId)) {
    throw new DurableClientError("clientId must be a sortable UUIDv7.", "clientId");
  }
  const name = input.name.trim();
  if (name.length === 0 || name.length > CLIENT_NAME_MAX_LENGTH) {
    throw new DurableClientError(
      `A client's name is between 1 and ${String(CLIENT_NAME_MAX_LENGTH)} characters.`,
      "name",
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(input.tokenHash)) {
    throw new DurableClientError("tokenHash must be a sha-256 hex digest.", "tokenHash");
  }
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0 || scopes.some((scope) => !CLIENT_SCOPES.includes(scope))) {
    throw new DurableClientError(
      `scopes must be a non-empty selection of: ${CLIENT_SCOPES.join(", ")}.`,
      "scopes",
    );
  }
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new DurableClientError("Client times are UTC epoch milliseconds.", "nowMs");
  }

  connection
    .prepare(
      `INSERT INTO ${CLIENT_SESSIONS_TABLE} (
        client_id, name, token_hash, scopes_json, created_at_ms, last_seen_at_ms, revoked_at_ms
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(input.clientId, name, input.tokenHash, JSON.stringify(scopes), input.nowMs);

  return Object.freeze({
    clientId: input.clientId,
    name,
    scopes: Object.freeze(scopes),
    createdAtMs: input.nowMs,
    lastSeenAtMs: null,
    revokedAtMs: null,
  });
}

export function readClientSession(
  connection: ClientStatementRunner,
  clientId: string,
): DurableClientRecord | undefined {
  const row = connection
    .prepare(`SELECT * FROM ${CLIENT_SESSIONS_TABLE} WHERE client_id = ?`)
    .get(clientId);
  return row === undefined ? undefined : toClient(row);
}

/** The client holding this token hash, revoked or not; the caller decides. */
export function readClientSessionByTokenHash(
  connection: ClientStatementRunner,
  tokenHash: string,
): DurableClientRecord | undefined {
  const row = connection
    .prepare(`SELECT * FROM ${CLIENT_SESSIONS_TABLE} WHERE token_hash = ?`)
    .get(tokenHash);
  return row === undefined ? undefined : toClient(row);
}

export function listClientSessions(
  connection: ClientStatementRunner,
  limit = LIST_LIMIT,
): readonly DurableClientRecord[] {
  const bounded = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(limit, LIST_LIMIT))
    : LIST_LIMIT;
  const rows = connection
    .prepare(
      `SELECT * FROM ${CLIENT_SESSIONS_TABLE} ORDER BY created_at_ms DESC, client_id DESC LIMIT ?`,
    )
    .all(bounded);
  return Object.freeze(rows.map(toClient));
}

/** Note that a client used its token, so a person can see what is still in use. */
export function touchClientSession(
  connection: ClientStatementRunner,
  clientId: string,
  nowMs: number,
): void {
  connection
    .prepare(
      `UPDATE ${CLIENT_SESSIONS_TABLE} SET last_seen_at_ms = ?
       WHERE client_id = ? AND (last_seen_at_ms IS NULL OR last_seen_at_ms < ?)`,
    )
    .run(nowMs, clientId, nowMs);
}

/** Take a client's access away. Revoking twice keeps the first time. */
export function revokeClientSession(
  connection: ClientStatementRunner,
  clientId: string,
  nowMs: number,
): DurableClientRecord | undefined {
  const existing = readClientSession(connection, clientId);
  if (existing === undefined) return undefined;
  if (existing.revokedAtMs !== null) return existing;
  connection
    .prepare(`UPDATE ${CLIENT_SESSIONS_TABLE} SET revoked_at_ms = ? WHERE client_id = ?`)
    .run(Math.max(nowMs, existing.createdAtMs), clientId);
  return readClientSession(connection, clientId);
}
