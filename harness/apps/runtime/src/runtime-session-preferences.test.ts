import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginHost } from "@zet-harness/core";
import { RuntimeCodingService } from "./runtime-coding-service.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import { SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { createSortableId } from "@zet-harness/db/sortable-id";
import { createProject } from "@zet-harness/db/durable-project-records";
import {
  appendMessage,
  archiveConversation,
  createConversation,
  readConversation,
  readConversationMessages,
} from "@zet-harness/db/durable-conversation-records";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import {
  exportSessionTranscript,
  readSessionPinned,
  writeSessionPinned,
} from "./runtime-session-preferences.js";

describe("durable session preferences and readable export", () => {
  it("keeps older pins beyond recent limit, filters projects/archive, and exports only newest branch", async () => {
    const db = new SqliteDatabase({ path: ":memory:" });
    db.open();
    runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
    const service = new RuntimeCodingService({
      database: db,
      workspace: () => undefined,
      sources: () => ({ host: new PluginHost() }),
      capabilityAuthority: () => ({ evaluate: () => ({ decision: "allow" as const }) }),
      redact: (v) => v,
      dispatch: undefined,
      cancel: async () => {},
      approvals: new RuntimeHumanApprovals(db),
    });
    try {
      const project = createProject(db.connection(), {
        projectId: createSortableId(),
        name: "Fixture",
        nowMs: 1,
      });
      const other = createProject(db.connection(), {
        projectId: createSortableId(),
        name: "Other",
        nowMs: 1,
      });
      const first = createConversation(db.connection(), {
        conversationId: createSortableId(),
        projectId: project.projectId,
        title: "Old pinned",
        nowMs: 1,
      });
      for (let i = 0; i < 205; i++)
        createConversation(db.connection(), {
          conversationId: createSortableId(),
          projectId: project.projectId,
          title: "Recent",
          nowMs: 100 + i,
        });
      await service.action("session/pin", { sessionId: first.conversationId, pinned: true });
      const listed = (await service.action("session/list", { projectId: project.projectId })) as {
        data: { id: string; pinned: boolean }[];
      };
      expect(listed.data).toHaveLength(201);
      expect(listed.data[0]).toMatchObject({ id: first.conversationId, pinned: true });
      expect(await service.action("session/list", { projectId: other.projectId })).toEqual({
        data: [],
      });
      const root = appendMessage(db.connection(), {
        messageId: createSortableId(),
        conversationId: first.conversationId,
        role: "user",
        parts: [{ kind: "text", text: "Question" }],
        nowMs: 400,
      });
      appendMessage(db.connection(), {
        messageId: createSortableId(),
        conversationId: first.conversationId,
        parentMessageId: root.messageId,
        role: "assistant",
        parts: [{ kind: "text", text: "Old retry answer" }],
        nowMs: 401,
      });
      appendMessage(db.connection(), {
        messageId: createSortableId(),
        conversationId: first.conversationId,
        parentMessageId: root.messageId,
        role: "assistant",
        parts: [{ kind: "text", text: "Latest answer" }],
        nowMs: 402,
      });
      const exported = (await service.action("session/export", {
        sessionId: first.conversationId,
      })) as { export: { content: string } };
      expect(exported.export.content).toContain("Latest answer");
      expect(exported.export.content).not.toContain("Old retry answer");
      await service.action("session/archive", { sessionId: first.conversationId });
      expect(
        await service.action("session/list", { projectId: project.projectId, archived: true }),
      ).toMatchObject({ data: [{ id: first.conversationId, pinned: true, status: "archived" }] });
      expect(
        (
          (await service.action("session/list", { projectId: project.projectId })) as {
            data: { id: string }[];
          }
        ).data.some((s) => s.id === first.conversationId),
      ).toBe(false);
      const archivedExport = (await service.action("session/export", {
        sessionId: first.conversationId,
      })) as { export: { content: string } };
      expect(archivedExport.export.content).toContain("Latest answer");
    } finally {
      service.close();
      db.close();
    }
  });
  it("persists pin/unpin on reload, isolates sessions/projects and leaves chats unchanged", async () => {
    const folder = await mkdtemp(join(tmpdir(), "session-pref-"));
    const path = join(folder, "fixture.sqlite");
    let db = new SqliteDatabase({ path });
    db.open();
    runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
    try {
      const make = () => {
        const project = createProject(db.connection(), {
          projectId: createSortableId(),
          name: "Fixture",
          nowMs: 1,
        });
        return createConversation(db.connection(), {
          conversationId: createSortableId(),
          projectId: project.projectId,
          title: "Fixture chat",
          nowMs: 1,
        });
      };
      const first = make();
      const second = make();
      writeSessionPinned(db.connection(), first.conversationId, true);
      expect(readSessionPinned(db.connection(), second.conversationId)).toBe(false);
      expect(readConversation(db.connection(), first.conversationId)).toEqual(first);
      db.close();
      db = new SqliteDatabase({ path });
      db.open();
      expect(readSessionPinned(db.connection(), first.conversationId)).toBe(true);
      archiveConversation(db.connection(), first.conversationId, 2);
      expect(readSessionPinned(db.connection(), first.conversationId)).toBe(true);
      writeSessionPinned(db.connection(), first.conversationId, false);
      expect(readSessionPinned(db.connection(), first.conversationId)).toBe(false);
      const archived = readConversation(db.connection(), first.conversationId)!;
      expect(exportSessionTranscript(archived, [], (v) => v).content).toContain(
        "Status: archived\nBranch: current saved branch\n\nNo messages.",
      );
      expect(readConversation(db.connection(), first.conversationId)).toEqual(archived);
    } finally {
      db.close();
      await rm(folder, { recursive: true, force: true });
    }
  });
  it("exports readable role/text/tool status without raw arguments/results/provider state or reasoning", () => {
    const db = new SqliteDatabase({ path: ":memory:" });
    db.open();
    runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
    try {
      const project = createProject(db.connection(), {
        projectId: createSortableId(),
        name: "Fixture",
        nowMs: 1,
      });
      const session = createConversation(db.connection(), {
        conversationId: createSortableId(),
        projectId: project.projectId,
        title: "Secret title",
        nowMs: 1,
      });
      appendMessage(db.connection(), {
        messageId: createSortableId(),
        conversationId: session.conversationId,
        role: "assistant",
        parts: [
          { kind: "text", text: "Secret answer" },
          { kind: "reasoning", text: "private reasoning" },
          {
            kind: "tool-call",
            callId: "c1",
            name: "fixture.read",
            arguments: { token: "raw-token" },
          },
        ],
        nowMs: 2,
      });
      appendMessage(db.connection(), {
        messageId: createSortableId(),
        conversationId: session.conversationId,
        role: "tool",
        parts: [
          { kind: "tool-result", callId: "c1", value: { token: "raw-token" }, isError: true },
        ],
        nowMs: 3,
      });
      const before = readConversationMessages(db.connection(), session.conversationId);
      const result = exportSessionTranscript(session, before, (v) =>
        String(v).replaceAll("Secret", "[redacted]"),
      );
      expect(result.filename).toBe(`chat-${session.conversationId}.md`);
      expect(result.content).toContain("## assistant");
      expect(result.content).toContain("Tool requested: fixture.read");
      expect(result.content).toContain("Tool result: error");
      expect(result.content).not.toMatch(/raw-token|private reasoning|Secret/u);
      expect(() =>
        exportSessionTranscript(
          session,
          [{ ...before[0]!, conversationId: createSortableId() }],
          (v) => v,
        ),
      ).toThrow("outside this session");
      expect(
        exportSessionTranscript({ ...session, title: "../../unsafe\nfilename" }, before, (v) => v)
          .filename,
      ).toBe(`chat-${session.conversationId}.md`);
      expect(readConversationMessages(db.connection(), session.conversationId)).toEqual(before);
    } finally {
      db.close();
    }
  });
});
