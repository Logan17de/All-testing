import { expect, it } from "vitest";
import type { JsonObject } from "@zet-harness/plugin-api";
import { SqliteDatabase, SQLITE_MEMORY_PATH, runSqliteMigrations } from "@zet-harness/db";
import { createSortableId } from "@zet-harness/db/sortable-id";
import { createProject } from "@zet-harness/db/durable-project-records";
import {
  appendMessage,
  createConversation,
} from "@zet-harness/db/durable-conversation-records";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { createSessionSearchTool } from "./runtime-session-search.js";

it("searches prior chat text only in the current project, excluding reasoning and tool output", async () => {
  const db = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  db.open();
  try {
    runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
    const p1 = createProject(db.connection(), {
      projectId: createSortableId(),
      name: "Primary",
      workspacePath: "/tmp/primary",
      nowMs: 1,
    });
    const p2 = createProject(db.connection(), {
      projectId: createSortableId(),
      name: "Unrelated",
      workspacePath: "/tmp/unrelated",
      nowMs: 1,
    });
    function add(projectId: string, text: string, role: "user" | "assistant" = "user") {
      const c = createConversation(db.connection(), {
        conversationId: createSortableId(),
        projectId,
        title: "Earlier chat",
        nowMs: 2,
      });
      appendMessage(db.connection(), {
        messageId: createSortableId(),
        conversationId: c.conversationId,
        role,
        parts: [{ kind: "text", text }],
        nowMs: 3,
      });
      return c;
    }
    const allowed = add(p1.projectId, "Remember the blue mountain project plan");
    add(p2.projectId, "blue mountain private unrelated account");
    const agent = createSessionSearchTool(db, p1.projectId);
    const invoke = async (input: JsonObject) =>
      agent.invoke(input, {
        runId: "fixture",
        logicalEffectId: "fixture",
        signal: new AbortController().signal,
      } as Parameters<typeof agent.invoke>[1]);
    const result = (await invoke({ query: "blue mountain" })).value as {
      ok: boolean;
      matches: { sessionId: string; excerpt: string }[];
    };
    expect(result.ok).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.sessionId).toBe(allowed.conversationId);
    expect(result.matches[0]?.excerpt).not.toContain("unrelated");

    expect((await invoke({ query: "x" })).value).toMatchObject({ ok: false });
    expect((await invoke({ query: "blue", limit: 11 })).value).toMatchObject({ ok: false });
    expect((await invoke({ query: "blue", unexpected: true })).value).toMatchObject({ ok: false });

    const abort = new AbortController();
    abort.abort();
    await expect(
      agent.invoke({ query: "blue" }, {
        runId: "fixture",
        logicalEffectId: "fixture",
        signal: abort.signal,
      } as Parameters<typeof agent.invoke>[1]),
    ).rejects.toThrow();
  } finally {
    db.close();
  }
});
