import type { DatabaseSync } from "node:sqlite";
import type { SqliteMigration } from "@zet-harness/db";
import { SORTABLE_ID_PATTERN } from "@zet-harness/db/sortable-id";

const RETENTION_KEY = "session.archivedRetentionDays";
const DAY_MS = 86_400_000;
const TERMINAL = "'completed','failed','cancelled'";
const deletionTriggers = [
  ["conversations_cannot_be_deleted", "conversations", "conversation_id"],
  ["messages_cannot_be_deleted", "messages", "conversation_id"],
  ["agent_steps_cannot_be_deleted", "agent_steps", "conversation_id"],
  ["native_chat_runs_immutable_delete", "native_chat_runs", "conversation_id"],
  ["approvals_reject_delete", "approvals", "run_id"],
  ["file_changes_cannot_be_deleted", "file_changes", "run_id"],
  ["durable_events_reject_delete", "durable_events", "run_id"],
  ["run_checkpoints_reject_delete", "run_checkpoints", "run_id"],
] as const;

/** Existing journals remain append-only except inside a scoped archived-chat deletion. */
export const DURABLE_ARCHIVED_CHAT_DELETION_MIGRATION: SqliteMigration = Object.freeze({
  version: 28,
  name: "scoped-archived-chat-deletion",
  sql: `
CREATE TABLE archived_chat_deletion_guards(conversation_id TEXT PRIMARY KEY) STRICT;
CREATE TABLE archived_chat_run_deletion_guards(run_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES archived_chat_deletion_guards(conversation_id)) STRICT;
CREATE TRIGGER archived_chat_guard_requires_archive BEFORE INSERT ON archived_chat_deletion_guards
WHEN NOT EXISTS(SELECT 1 FROM conversations WHERE conversation_id=NEW.conversation_id AND status='archived')
BEGIN SELECT RAISE(ABORT,'Only archived chats can be permanently deleted'); END;
${deletionTriggers
  .map(([trigger, table, field]) => {
    const guard =
      field === "run_id" ? "archived_chat_run_deletion_guards" : "archived_chat_deletion_guards";
    return `DROP TRIGGER ${trigger};
CREATE TRIGGER ${trigger} BEFORE DELETE ON ${table}
WHEN NOT EXISTS(SELECT 1 FROM ${guard} WHERE ${field}=OLD.${field})
BEGIN SELECT RAISE(ABORT,'Archived chat deletion transaction required'); END;`;
  })
  .join("\n")}
${["checkpoint_op_frontier", "checkpoint_control_edges", "checkpoint_router_selections"]
  .map(
    (table) => `DROP TRIGGER ${table}_reject_delete;
CREATE TRIGGER ${table}_reject_delete BEFORE DELETE ON ${table}
WHEN NOT EXISTS(SELECT 1 FROM run_checkpoints c JOIN archived_chat_run_deletion_guards g ON g.run_id=c.run_id WHERE c.checkpoint_id=OLD.checkpoint_id)
BEGIN SELECT RAISE(ABORT,'Archived chat deletion transaction required'); END;`,
  )
  .join("\n")}
DROP TRIGGER goals_keep_their_identity;
CREATE TRIGGER goals_keep_their_identity BEFORE UPDATE OF goal_id,project_id,conversation_id,created_at_ms ON goals
WHEN NOT(NEW.goal_id=OLD.goal_id AND NEW.project_id=OLD.project_id AND NEW.created_at_ms=OLD.created_at_ms AND NEW.conversation_id IS NULL AND EXISTS(SELECT 1 FROM archived_chat_deletion_guards WHERE conversation_id=OLD.conversation_id))
BEGIN SELECT RAISE(ABORT,'a goal keeps its id, project, conversation and creation time'); END;
`,
});

export class ArchivedChatError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "ArchivedChatError";
  }
}

export function validateArchivedRetentionDays(days: unknown): number {
  if (typeof days !== "number" || !Number.isSafeInteger(days) || (days !== -1 && days <= 0))
    throw new ArchivedChatError(
      "INVALID_ARCHIVED_RETENTION",
      "Enter a positive whole number of days, or -1 to keep archived chats forever.",
    );
  return days;
}

export function readArchivedRetentionDays(db: DatabaseSync): number {
  const row = db.prepare("SELECT value_json FROM app_settings WHERE key=?").get(RETENTION_KEY);
  if (!row) return -1;
  try {
    return validateArchivedRetentionDays(JSON.parse(String(row.value_json)));
  } catch {
    // A corrupt or unsupported setting must never enable deletion.
    return -1;
  }
}

export function writeArchivedRetentionDays(db: DatabaseSync, days: unknown): number {
  const value = validateArchivedRetentionDays(days);
  db.prepare(
    "INSERT INTO app_settings(key,value_json,updated_at_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at_ms=excluded.updated_at_ms",
  ).run(RETENTION_KEY, JSON.stringify(value), Date.now());
  return value;
}

export function archivedRetentionCutoff(days: number, nowMs: number): number | undefined {
  validateArchivedRetentionDays(days);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("Invalid retention time.");
  if (days === -1) return undefined;
  // Comparing division first avoids overflow for a very large user-entered policy.
  return days > nowMs / DAY_MS ? undefined : nowMs - days * DAY_MS;
}

function associatedRuns(db: DatabaseSync, sessionId: string): string[] {
  return db
    .prepare(
      `
SELECT run_id FROM native_chat_runs WHERE conversation_id=?
UNION SELECT run_id FROM messages WHERE conversation_id=? AND run_id IS NOT NULL
UNION SELECT run_id FROM agent_steps WHERE conversation_id=?
UNION SELECT run_id FROM conversation_summaries WHERE conversation_id=? AND run_id IS NOT NULL
UNION SELECT r.run_id FROM runs r JOIN graph_sources g ON g.document_hash=r.document_hash
WHERE EXISTS(SELECT 1 FROM json_tree(g.normalized_document_json) j WHERE j.key='conversationId' AND j.value=?)
`,
    )
    .all(sessionId, sessionId, sessionId, sessionId, sessionId)
    .map((row) => String(row.run_id));
}

function removeAssistantReferences(db: DatabaseSync, sessionId: string): void {
  const roots = db
    .prepare(
      `SELECT assistant_id FROM assistant_actors WHERE chat_id=? OR parent_chat_id=?
UNION SELECT assistant_id FROM assistant_edges WHERE chat_id=?
UNION SELECT assistant_id FROM assistant_roots WHERE assistant_id=?`,
    )
    .all(sessionId, sessionId, sessionId, sessionId);
  for (const root of roots) {
    const id = String(root.assistant_id);
    // Invalidate every surviving graph binding before removing its referenced actor.
    db.prepare("UPDATE assistant_roots SET epoch=epoch+1 WHERE assistant_id=?").run(id);
    const actors = db
      .prepare(
        `WITH RECURSIVE removed(chat_id) AS (
      SELECT chat_id FROM assistant_actors WHERE assistant_id=? AND (chat_id=? OR ?=?)
      UNION SELECT a.chat_id FROM assistant_actors a JOIN removed r ON a.parent_chat_id=r.chat_id WHERE a.assistant_id=?
    ) SELECT chat_id FROM removed`,
      )
      .all(id, sessionId, id, sessionId, id)
      .map((row) => String(row.chat_id));
    for (const actor of actors) {
      db.prepare(
        "DELETE FROM assistant_tool_requests WHERE assistant_id=? AND (child_chat_id=? OR parent_chat_id=?)",
      ).run(id, actor, actor);
      db.prepare(
        "DELETE FROM assistant_tool_assignments WHERE assistant_id=? AND (child_chat_id=? OR authority_actor_chat_id=?)",
      ).run(id, actor, actor);
      db.prepare(
        "DELETE FROM assistant_tool_authorities WHERE assistant_id=? AND actor_chat_id=?",
      ).run(id, actor);
      db.prepare(
        "DELETE FROM assistant_edges WHERE assistant_id=? AND (actor_chat_id=? OR chat_id=?)",
      ).run(id, actor, actor);
      db.prepare(
        "DELETE FROM assistant_runs WHERE assistant_id=? AND (actor_chat_id=? OR target_chat_id=?)",
      ).run(id, actor, actor);
      db.prepare(
        "DELETE FROM assistant_context_floors WHERE assistant_id=? AND actor_chat_id=?",
      ).run(id, actor);
      db.prepare("DELETE FROM assistant_actors WHERE assistant_id=? AND chat_id=?").run(id, actor);
    }
    if (id !== sessionId) {
      const epoch = db
        .prepare("SELECT epoch FROM assistant_roots WHERE assistant_id=?")
        .get(id)?.epoch;
      const surviving = db
        .prepare(
          "SELECT chat_id FROM assistant_actors WHERE assistant_id=? UNION SELECT target_chat_id AS chat_id FROM assistant_runs WHERE assistant_id=?",
        )
        .all(id, id);
      for (const actor of surviving) {
        const chatId = String(actor.chat_id);
        const latest = db
          .prepare(
            "SELECT message_id FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
          )
          .get(chatId);
        db.prepare(
          "INSERT INTO assistant_context_floors VALUES(?,?,?,?) ON CONFLICT(assistant_id,actor_chat_id,epoch) DO UPDATE SET boundary_message_id=excluded.boundary_message_id",
        ).run(id, chatId, Number(epoch), latest ? String(latest.message_id) : null);
      }
    }
  }
  db.prepare("DELETE FROM assistant_edges WHERE chat_id=?").run(sessionId);
  db.prepare("DELETE FROM assistant_runs WHERE target_chat_id=?").run(sessionId);
  db.prepare(
    "DELETE FROM assistant_context_floors WHERE boundary_message_id IN (SELECT message_id FROM messages WHERE conversation_id=?)",
  ).run(sessionId);
  db.prepare("DELETE FROM assistant_roots WHERE assistant_id=?").run(sessionId);
  db.prepare(
    "DELETE FROM assistant_access_audit WHERE assistant_id=? OR instr(details_json,?)>0",
  ).run(sessionId, sessionId);
}

/** Synchronous and transaction-only, so validation and removal cannot race a restore/write. */
export function deleteArchivedChat(
  db: DatabaseSync,
  sessionId: string,
  isRunActive?: (runId: string) => boolean,
): { sessionId: string; runIds: string[] } {
  if (!db.isTransaction)
    throw new TypeError("Archived chat deletion requires a serialized transaction.");
  if (!SORTABLE_ID_PATTERN.test(sessionId))
    throw new ArchivedChatError("INVALID_SESSION", "Invalid chat.");
  const session = db
    .prepare("SELECT status FROM conversations WHERE conversation_id=?")
    .get(sessionId);
  if (!session) throw new ArchivedChatError("SESSION_NOT_FOUND", "This chat no longer exists.");
  if (session.status !== "archived")
    throw new ArchivedChatError(
      "SESSION_NOT_ARCHIVED",
      "Archive this chat before deleting it permanently.",
    );
  const runIds = associatedRuns(db, sessionId);
  const busy = () => {
    throw new ArchivedChatError(
      "SESSION_BUSY",
      "This chat has unfinished activity. Stop its turns before deleting it permanently.",
    );
  };
  for (const runId of runIds) {
    if (isRunActive?.(runId)) busy();
    if (db.prepare(`SELECT 1 FROM runs WHERE run_id=? AND status NOT IN (${TERMINAL})`).get(runId))
      busy();
    // Shared execution is project data; never erase another chat's journal.
    for (const table of ["native_chat_runs", "messages", "agent_steps", "conversation_summaries"])
      if (
        db
          .prepare(`SELECT 1 FROM ${table} WHERE run_id=? AND conversation_id<>? LIMIT 1`)
          .get(runId, sessionId)
      )
        throw new ArchivedChatError(
          "SESSION_SHARED_ACTIVITY",
          "This chat shares saved activity with another chat and cannot be deleted yet.",
        );
    if (
      db
        .prepare(
          `SELECT 1 FROM runs r JOIN graph_sources g ON g.document_hash=r.document_hash
      JOIN json_tree(g.normalized_document_json) j ON j.key='conversationId'
      JOIN conversations c ON c.conversation_id=j.value
      WHERE r.run_id=? AND c.conversation_id<>? LIMIT 1`,
        )
        .get(runId, sessionId)
    )
      throw new ArchivedChatError(
        "SESSION_SHARED_ACTIVITY",
        "This chat shares saved activity with another chat and cannot be deleted yet.",
      );
  }
  // Removing an assistant actor revokes its descendants; no active graph may lose authority mid-turn.
  if (
    db
      .prepare(
        `SELECT 1 FROM assistant_runs a JOIN runs r ON r.run_id=a.run_id
WHERE r.status NOT IN (${TERMINAL}) AND a.assistant_id IN (
 SELECT assistant_id FROM assistant_actors WHERE chat_id=? OR parent_chat_id=?
 UNION SELECT assistant_id FROM assistant_edges WHERE chat_id=?
) LIMIT 1`,
      )
      .get(sessionId, sessionId, sessionId)
  )
    busy();
  if (isRunActive) {
    const related = db
      .prepare(
        `SELECT a.run_id FROM assistant_runs a WHERE a.assistant_id IN (
      SELECT assistant_id FROM assistant_actors WHERE chat_id=? OR parent_chat_id=?
      UNION SELECT assistant_id FROM assistant_edges WHERE chat_id=?
    )`,
      )
      .all(sessionId, sessionId, sessionId);
    if (related.some((row) => isRunActive(String(row.run_id)))) busy();
  }
  db.prepare("INSERT INTO archived_chat_deletion_guards(conversation_id) VALUES(?)").run(sessionId);
  for (const runId of runIds)
    db.prepare(
      "INSERT INTO archived_chat_run_deletion_guards(run_id,conversation_id) VALUES(?,?)",
    ).run(runId, sessionId);
  removeAssistantReferences(db, sessionId);
  db.prepare("UPDATE goals SET conversation_id=NULL WHERE conversation_id=?").run(sessionId);
  db.prepare("DELETE FROM agent_steps WHERE conversation_id=?").run(sessionId);
  db.prepare("DELETE FROM conversation_summaries WHERE conversation_id=?").run(sessionId);
  // Parents were inserted before children. Delete children first for RESTRICT self references.
  for (const row of db
    .prepare("SELECT message_id FROM messages WHERE conversation_id=? ORDER BY rowid DESC")
    .all(sessionId))
    db.prepare("DELETE FROM messages WHERE message_id=?").run(String(row.message_id));
  db.prepare("DELETE FROM native_chat_runs WHERE conversation_id=?").run(sessionId);
  db.prepare("DELETE FROM native_chat_tool_scopes WHERE conversation_id=?").run(sessionId);
  db.prepare("DELETE FROM app_settings WHERE key=?").run(`session.pinned.${sessionId}`);
  for (const runId of runIds) {
    db.prepare("UPDATE project_memories SET source_run_id=NULL WHERE source_run_id=?").run(runId);
    db.prepare("UPDATE triggers SET last_run_id=NULL WHERE last_run_id=?").run(runId);
    db.prepare("UPDATE trigger_fires SET run_id=NULL WHERE run_id=?").run(runId);
    db.prepare(
      "UPDATE runs SET parent_run_id=NULL,fork_metadata_json=NULL WHERE parent_run_id=?",
    ).run(runId);
    db.prepare("DELETE FROM assistant_runs WHERE run_id=?").run(runId);
    for (const table of ["approvals", "file_changes", "project_run_locks"])
      db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(runId);
    for (const table of [
      "checkpoint_op_frontier",
      "checkpoint_control_edges",
      "checkpoint_router_selections",
    ])
      db.prepare(
        `DELETE FROM ${table} WHERE checkpoint_id IN (SELECT checkpoint_id FROM run_checkpoints WHERE run_id=?)`,
      ).run(runId);
    for (const table of [
      "run_checkpoints",
      "durable_events",
      "node_attempts",
      "node_invocations",
      "runs",
    ])
      db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(runId);
  }
  const sources = db
    .prepare("SELECT document_hash FROM graph_sources WHERE graph_id=?")
    .all(`native-chat:${sessionId}`);
  const planIds = new Set<number>();
  for (const source of sources) {
    const hash = String(source.document_hash);
    const links = db
      .prepare("SELECT compiled_plan_id FROM graph_compilations WHERE document_hash=?")
      .all(hash);
    for (const link of links) {
      const planId = Number(link.compiled_plan_id);
      if (
        db
          .prepare(
            "SELECT 1 FROM runs WHERE document_hash=? AND compiled_plan_id=? UNION SELECT 1 FROM triggers WHERE document_hash=? AND compiled_plan_id=?",
          )
          .get(hash, planId, hash, planId)
      )
        continue;
      db.prepare("DELETE FROM graph_compilations WHERE document_hash=? AND compiled_plan_id=?").run(
        hash,
        planId,
      );
      planIds.add(planId);
    }
    if (!db.prepare("SELECT 1 FROM graph_compilations WHERE document_hash=?").get(hash))
      db.prepare("DELETE FROM graph_sources WHERE document_hash=?").run(hash);
  }
  for (const planId of planIds)
    if (!db.prepare("SELECT 1 FROM graph_compilations WHERE compiled_plan_id=?").get(planId))
      db.prepare("DELETE FROM compiled_plans WHERE compiled_plan_id=?").run(planId);
  db.prepare("DELETE FROM conversations WHERE conversation_id=?").run(sessionId);
  db.prepare("DELETE FROM archived_chat_run_deletion_guards WHERE conversation_id=?").run(
    sessionId,
  );
  db.prepare("DELETE FROM archived_chat_deletion_guards WHERE conversation_id=?").run(sessionId);
  return { sessionId, runIds };
}
