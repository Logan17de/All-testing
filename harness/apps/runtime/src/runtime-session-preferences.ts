import type { SettingStatementRunner } from "@zet-harness/db/durable-setting-records";
import { SORTABLE_ID_PATTERN } from "@zet-harness/db/sortable-id";
import type {
  DurableConversationRecord,
  DurableMessageRecord,
} from "@zet-harness/db/durable-conversation-records";

function key(sessionId: string): string {
  if (!SORTABLE_ID_PATTERN.test(sessionId)) throw new Error("Invalid session.");
  return `session.pinned.${sessionId}`;
}
/** Uses the existing app_settings table; never modifies conversation timestamps/content. */
export function readSessionPinned(db: SettingStatementRunner, sessionId: string): boolean {
  return (
    db.prepare("SELECT value_json FROM app_settings WHERE key=?").get(key(sessionId))?.[
      "value_json"
    ] === "true"
  );
}
export function writeSessionPinned(
  db: SettingStatementRunner,
  sessionId: string,
  pinned: boolean,
): void {
  if (typeof pinned !== "boolean") throw new Error("Invalid pin state.");
  db.prepare(
    "INSERT INTO app_settings(key,value_json,updated_at_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at_ms=excluded.updated_at_ms",
  ).run(key(sessionId), JSON.stringify(pinned), Date.now());
}
/** Human-readable text only: excludes reasoning, provider state and raw tool payloads. */
export function exportSessionTranscript(
  session: DurableConversationRecord,
  messages: readonly DurableMessageRecord[],
  redact: (value: unknown) => unknown,
) {
  if (messages.some((message) => message.conversationId !== session.conversationId))
    throw new Error("Transcript branch is outside this session.");
  const lines = [
    `# ${session.title.replace(/[\r\n]/gu, " ")}`,
    "",
    `Status: ${session.status}`,
    "Branch: current saved branch",
    "",
  ];
  for (const message of messages) {
    lines.push(`## ${message.role}`, "");
    for (const part of message.parts) {
      if (part.kind === "text") lines.push(part.text, "");
      else if (part.kind === "tool-call") lines.push(`Tool requested: ${part.name}`, "");
      else if (part.kind === "tool-result")
        lines.push(`Tool result: ${part.isError ? "error" : "completed"}`, "");
      else if (part.kind === "image") lines.push("[Image attachment]", "");
    }
  }
  if (!messages.length) lines.push("No messages.", "");
  const content = redact(lines.join("\n"));
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > 8_388_608)
    throw new Error("Transcript export exceeds the supported size.");
  return {
    filename: `chat-${session.conversationId}.md`,
    content,
    mediaType: "text/markdown; charset=utf-8" as const,
  };
}
