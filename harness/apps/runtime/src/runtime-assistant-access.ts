import type { DatabaseSync } from "node:sqlite";
import type { SqliteMigration } from "@zet-harness/db";
export type AssistantPermission = "read" | "control";
export interface AssistantGrant {
  readonly chatId: string;
  readonly permissions: readonly AssistantPermission[];
}
export interface AssistantBinding {
  readonly assistantId: string;
  readonly actorChatId: string;
  readonly epoch: number;
}
export const DURABLE_ASSISTANT_ACCESS_MIGRATION: SqliteMigration = Object.freeze({
  version: 25,
  name: "durable-assistant-access",
  sql: `
CREATE TABLE assistant_roots(assistant_id TEXT PRIMARY KEY REFERENCES conversations(conversation_id),epoch INTEGER NOT NULL CHECK(epoch>=0)) STRICT;
CREATE TABLE assistant_actors(assistant_id TEXT NOT NULL REFERENCES assistant_roots(assistant_id),chat_id TEXT NOT NULL REFERENCES conversations(conversation_id),parent_chat_id TEXT,PRIMARY KEY(assistant_id,chat_id)) STRICT;
CREATE TABLE assistant_edges(assistant_id TEXT NOT NULL,actor_chat_id TEXT NOT NULL,chat_id TEXT NOT NULL REFERENCES conversations(conversation_id),permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)),PRIMARY KEY(assistant_id,actor_chat_id,chat_id),FOREIGN KEY(assistant_id,actor_chat_id) REFERENCES assistant_actors(assistant_id,chat_id)) STRICT;
CREATE TABLE assistant_runs(run_id TEXT PRIMARY KEY,assistant_id TEXT NOT NULL REFERENCES assistant_roots(assistant_id),actor_chat_id TEXT NOT NULL,target_chat_id TEXT NOT NULL REFERENCES conversations(conversation_id),epoch INTEGER NOT NULL CHECK(epoch>=0),origin TEXT NOT NULL CHECK(origin IN ('user','delegated'))) STRICT;
CREATE TABLE assistant_context_floors(assistant_id TEXT NOT NULL REFERENCES assistant_roots(assistant_id),actor_chat_id TEXT NOT NULL,epoch INTEGER NOT NULL CHECK(epoch>=0),boundary_message_id TEXT,PRIMARY KEY(assistant_id,actor_chat_id,epoch)) STRICT;
CREATE TABLE assistant_access_audit(sequence INTEGER PRIMARY KEY,assistant_id TEXT NOT NULL,epoch INTEGER NOT NULL,action TEXT NOT NULL,details_json TEXT NOT NULL,created_at_ms INTEGER NOT NULL) STRICT;
`,
});
export function assistantId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value))
    throw new TypeError("Invalid canonical assistant/chat ID.");
}
export function assistantPermissions(value: unknown): readonly AssistantPermission[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 2 ||
    value.some((p) => p !== "read" && p !== "control") ||
    new Set(value).size !== value.length
  )
    throw new TypeError("Invalid assistant permissions.");
  return Object.freeze(Array.from(value as AssistantPermission[]));
}
export class AssistantAccessDenied extends Error {
  constructor() {
    super("Assistant chat access denied or revoked.");
    this.name = "AssistantAccessDenied";
  }
}
export function assistantEpoch(db: DatabaseSync, id: string): number {
  assistantId(id);
  const row = db.prepare("SELECT epoch FROM assistant_roots WHERE assistant_id=?").get(id);
  if (!row) throw new AssistantAccessDenied();
  return Number(row.epoch);
}
export function assistantGrants(
  db: DatabaseSync,
  binding: AssistantBinding,
): readonly AssistantGrant[] {
  assertAssistantBinding(db, binding);
  return Object.freeze(
    db
      .prepare(
        "SELECT chat_id,permissions_json FROM assistant_edges WHERE assistant_id=? AND actor_chat_id=? ORDER BY chat_id",
      )
      .all(binding.assistantId, binding.actorChatId)
      .map((row) =>
        Object.freeze({
          chatId: String(row.chat_id),
          permissions: assistantPermissions(JSON.parse(String(row.permissions_json))),
        }),
      ),
  );
}
export function assertAssistantBinding(db: DatabaseSync, b: AssistantBinding): void {
  assistantId(b.assistantId);
  assistantId(b.actorChatId);
  if (
    !Number.isSafeInteger(b.epoch) ||
    assistantEpoch(db, b.assistantId) !== b.epoch ||
    !db
      .prepare("SELECT 1 FROM assistant_actors WHERE assistant_id=? AND chat_id=?")
      .get(b.assistantId, b.actorChatId)
  )
    throw new AssistantAccessDenied();
  let current = b.actorChatId;
  const seen = new Set<string>();
  while (current !== b.assistantId) {
    if (seen.has(current) || seen.size >= 64) throw new AssistantAccessDenied();
    seen.add(current);
    const actor = db
      .prepare("SELECT parent_chat_id FROM assistant_actors WHERE assistant_id=? AND chat_id=?")
      .get(b.assistantId, current);
    if (!actor || typeof actor.parent_chat_id !== "string") throw new AssistantAccessDenied();
    for (const owner of [b.assistantId, current]) {
      const edge = db
        .prepare(
          "SELECT permissions_json FROM assistant_edges WHERE assistant_id=? AND actor_chat_id=? AND chat_id=?",
        )
        .get(b.assistantId, owner, current);
      if (!edge) throw new AssistantAccessDenied();
      const permissions = assistantPermissions(JSON.parse(String(edge.permissions_json)));
      if (!permissions.includes("read") || !permissions.includes("control"))
        throw new AssistantAccessDenied();
    }
    current = actor.parent_chat_id;
    assistantId(current);
  }
}
export function assertAssistantAccess(
  db: DatabaseSync,
  b: AssistantBinding,
  target: string,
  p: AssistantPermission,
): void {
  assistantId(target);
  assertAssistantBinding(db, b);
  const row = db
    .prepare(
      "SELECT permissions_json FROM assistant_edges WHERE assistant_id=? AND actor_chat_id=? AND chat_id=?",
    )
    .get(b.assistantId, b.actorChatId, target);
  if (!row || !assistantPermissions(JSON.parse(String(row.permissions_json))).includes(p))
    throw new AssistantAccessDenied();
}
