import type { DatabaseSync } from "node:sqlite";
import type { SqliteMigration } from "@zet-harness/db";

/** Host-issued provenance. Imported graph names and node configs never establish chat authority. */
export const DURABLE_NATIVE_CHAT_RUNS_MIGRATION: SqliteMigration = Object.freeze({
  version: 26,
  name: "durable-native-chat-run-provenance",
  sql: `
CREATE TABLE native_chat_runs (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id)
) STRICT;
CREATE INDEX native_chat_runs_by_conversation ON native_chat_runs(conversation_id,run_id);
CREATE TRIGGER native_chat_runs_immutable_update BEFORE UPDATE ON native_chat_runs
BEGIN SELECT RAISE(ABORT,'Native chat run provenance is immutable'); END;
CREATE TRIGGER native_chat_runs_immutable_delete BEFORE DELETE ON native_chat_runs
BEGIN SELECT RAISE(ABORT,'Native chat run provenance is immutable'); END;
`,
});

/** Called only by the native coding host inside the same transaction that inserts the run. */
export function attestNativeChatRun(db: DatabaseSync, runId: string, conversationId: string): void {
  db.prepare("INSERT INTO native_chat_runs(run_id,conversation_id) VALUES(?,?)").run(
    runId,
    conversationId,
  );
}
