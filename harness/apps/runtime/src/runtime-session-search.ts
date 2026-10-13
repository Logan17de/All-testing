import type { SqliteDatabase } from "@zet-harness/db";
import type { ToolAdapter } from "@zet-harness/plugin-api";

/**
 * Opt-in, project-confined transcript recall. This is not automatic memory
 * extraction: it searches only stored user/assistant text, never reasoning,
 * tool outputs, provider state, image references or another project's chats.
 * The existing project-memory tools remain the curated durable store.
 */
export function createSessionSearchTool(database: SqliteDatabase, projectId: string): ToolAdapter {
  return {
    manifest: {
      id: "harness.memory.session-search",
      version: "1",
      title: "Find earlier conversations",
      description:
        "Search exact words inside this project's saved user and assistant messages across earlier chats. Includes archived chats. Returns brief excerpts and session ids, not private tool outputs or reasoning. Use for finding original evidence rather than inventing past discussions.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 2, maxLength: 120 },
          limit: { type: "integer", minimum: 1, maximum: 10 },
        },
      },
      outputSchema: { type: "object" },
      behavior: {
        primitiveFamily: "effect",
        determinism: "nondeterministic",
        effect: "external-read",
        idempotency: "idempotent",
        recovery: "rerun",
        executionMode: "in-process",
        requiredCapabilities: [],
      },
    },
    async invoke(input, context) {
      // Recheck cancellation at the asynchronous tool boundary before touching SQLite.
      await Promise.resolve();
      context.signal.throwIfAborted();
      if (
        Object.keys(input).some((key) => !["query", "limit"].includes(key)) ||
        typeof input.query !== "string" ||
        input.query.trim().length < 2 ||
        input.query.length > 120 ||
        /[\x00-\x1f\x7f]/u.test(input.query) ||
        (input.limit !== undefined &&
          (!Number.isSafeInteger(input.limit) ||
            (input.limit as number) < 1 ||
            (input.limit as number) > 10))
      ) {
        return { value: { ok: false, error: { code: "SEARCH_INPUT_INVALID" } } };
      }
      const limit = (input.limit as number | undefined) ?? 6;
      const rows = database
        .connection()
        .prepare(
          `SELECT m.message_id AS messageId, m.conversation_id AS sessionId,
                  c.title AS title, m.role AS role, m.created_at_ms AS createdAt,
                  json_extract(part.value, '$.text') AS body
             FROM messages m
             JOIN conversations c ON c.conversation_id = m.conversation_id
             JOIN json_each(m.content_json) AS part
            WHERE c.project_id = ?
              AND m.role IN ('user', 'assistant')
              AND json_extract(part.value, '$.kind') = 'text'
              AND instr(lower(json_extract(part.value, '$.text')), lower(?)) > 0
            ORDER BY m.created_at_ms DESC, m.message_id DESC
            LIMIT ?`,
        )
        .all(projectId, input.query.trim(), limit) as Record<string, unknown>[];
      context.signal.throwIfAborted();
      return {
        value: {
          ok: true,
          matches: rows.map((row) => ({
            sessionId: row.sessionId as string,
            messageId: row.messageId as string,
            title: String(row.title).slice(0, 200),
            role: row.role as string,
            createdAt: row.createdAt as number,
            excerpt: String(row.body).slice(0, 500),
          })),
        },
      };
    },
  };
}
