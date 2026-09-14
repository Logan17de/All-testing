import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  CONVERSATIONS_TABLE,
  DURABLE_CONVERSATIONS_MIGRATION,
  DurableConversationError,
  MESSAGES_TABLE,
  appendMessage,
  archiveConversation,
  createConversation,
  listConversations,
  readConversation,
  readConversationMessages,
  readMessagePath,
  renameConversation,
  restoreConversation,
  type DurableMessagePart,
  type DurableMessageRole,
} from "./durable-conversation-records.js";
import {
  DURABLE_PROJECTS_MIGRATION,
  archiveProject,
  createProject,
} from "./durable-project-records.js";
import {
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  runSqliteMigrations,
} from "./index.js";
import { SortableIdGenerator } from "./sortable-id.js";

interface Fixture {
  readonly connection: DatabaseSync;
  readonly ids: SortableIdGenerator;
  readonly projectId: string;
}

const withDatabase = (run: (fixture: Fixture) => void): void => {
  const connection = new DatabaseSync(":memory:", {
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });
  try {
    runSqliteMigrations(
      connection,
      [
        DURABLE_GRAPH_IDENTITY_MIGRATION,
        DURABLE_RUNS_MIGRATION,
        DURABLE_PROJECTS_MIGRATION,
        DURABLE_CONVERSATIONS_MIGRATION,
      ],
      { now: () => 1 },
    );
    const ids = new SortableIdGenerator({ now: () => 1_000 });
    const { projectId } = createProject(connection, {
      projectId: ids.next(),
      name: "Project",
      nowMs: 1,
    });
    run({ connection, ids, projectId });
  } finally {
    connection.close();
  }
};

function failure(action: () => unknown): DurableConversationError {
  try {
    action();
  } catch (error) {
    if (error instanceof DurableConversationError) return error;
    throw error;
  }
  throw new Error("Expected the conversation write to be refused.");
}

const say = (text: string): DurableMessagePart[] => [{ kind: "text", text }];

describe("durable conversations", () => {
  it("starts conversations in active projects and lists them by most recent change", () => {
    withDatabase(({ connection, ids, projectId }) => {
      const first = createConversation(connection, {
        conversationId: ids.next(),
        projectId,
        title: "  Plan  ",
        nowMs: 10,
      });
      expect(first).toEqual({
        conversationId: first.conversationId,
        projectId,
        title: "Plan",
        status: "active",
        createdAtMs: 10,
        updatedAtMs: 10,
        archivedAtMs: null,
      });
      const second = createConversation(connection, {
        conversationId: ids.next(),
        projectId,
        nowMs: 20,
      });
      expect(second.title).toBe("");

      appendMessage(connection, {
        messageId: ids.next(),
        conversationId: first.conversationId,
        role: "user",
        parts: say("hi"),
        nowMs: 30,
      });
      expect(listConversations(connection, projectId).map((item) => item.conversationId)).toEqual([
        first.conversationId,
        second.conversationId,
      ]);
      expect(readConversation(connection, first.conversationId)?.updatedAtMs).toBe(30);

      expect(
        failure(() =>
          createConversation(connection, {
            conversationId: ids.next(),
            projectId: ids.next(),
            nowMs: 40,
          }),
        ),
      ).toMatchObject({ code: "PROJECT_NOT_FOUND" });
      archiveProject(connection, projectId, 50);
      expect(
        failure(() =>
          createConversation(connection, { conversationId: ids.next(), projectId, nowMs: 60 }),
        ),
      ).toMatchObject({ code: "PROJECT_ARCHIVED" });
      expect(
        failure(() =>
          appendMessage(connection, {
            messageId: ids.next(),
            conversationId: second.conversationId,
            role: "user",
            parts: say("still here?"),
            nowMs: 60,
          }),
        ),
      ).toMatchObject({ code: "PROJECT_ARCHIVED" });
    });
  });

  it("renames, archives and restores a conversation, refusing messages while archived", () => {
    withDatabase(({ connection, ids, projectId }) => {
      const { conversationId } = createConversation(connection, {
        conversationId: ids.next(),
        projectId,
        nowMs: 10,
      });

      expect(renameConversation(connection, conversationId, "Renamed", 20)).toMatchObject({
        title: "Renamed",
        updatedAtMs: 20,
      });
      expect(archiveConversation(connection, conversationId, 30)).toMatchObject({
        status: "archived",
        archivedAtMs: 30,
      });
      expect(listConversations(connection, projectId)).toEqual([]);
      expect(listConversations(connection, projectId, { status: "archived" })).toHaveLength(1);
      expect(
        failure(() =>
          appendMessage(connection, {
            messageId: ids.next(),
            conversationId,
            role: "user",
            parts: say("hello?"),
            nowMs: 31,
          }),
        ),
      ).toMatchObject({ code: "CONVERSATION_ARCHIVED" });
      expect(
        failure(() => renameConversation(connection, conversationId, "Nope", 35)),
      ).toMatchObject({ code: "CONVERSATION_ARCHIVED" });
      expect(restoreConversation(connection, conversationId, 40)).toMatchObject({
        status: "active",
        archivedAtMs: null,
      });

      const missing = ids.next();
      expect(renameConversation(connection, missing, "x", 50)).toBeUndefined();
      expect(archiveConversation(connection, missing, 50)).toBeUndefined();
      expect(
        failure(() =>
          appendMessage(connection, {
            messageId: ids.next(),
            conversationId: missing,
            role: "user",
            parts: say("x"),
            nowMs: 50,
          }),
        ),
      ).toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    });
  });

  it("continues from the latest message by default and branches on edit and retry", () => {
    withDatabase(({ connection, ids, projectId }) => {
      const { conversationId } = createConversation(connection, {
        conversationId: ids.next(),
        projectId,
        nowMs: 10,
      });
      const append = (
        role: DurableMessageRole,
        parts: readonly DurableMessagePart[],
        parentMessageId?: string | null,
      ) =>
        appendMessage(connection, {
          messageId: ids.next(),
          conversationId,
          role,
          parts,
          ...(parentMessageId === undefined ? {} : { parentMessageId }),
          nowMs: 10,
        });

      const question = append("user", say("What is 2+2?"));
      const answer = append("assistant", [
        { kind: "reasoning", text: "Add them." },
        { kind: "text", text: "4" },
      ]);
      const retry = append("assistant", say("Four."), question.messageId);
      const editedQuestion = append("user", say("What is 3+3?"), null);
      const followUp = append("user", say("And 4+4?"));

      expect(question.parentMessageId).toBeNull();
      expect(answer.parentMessageId).toBe(question.messageId);
      expect(retry.parentMessageId).toBe(question.messageId);
      expect(editedQuestion.parentMessageId).toBeNull();
      expect(followUp.parentMessageId).toBe(editedQuestion.messageId);

      expect(readConversationMessages(connection, conversationId)).toEqual([
        question,
        answer,
        retry,
        editedQuestion,
        followUp,
      ]);
      expect(readMessagePath(connection, retry.messageId).map((item) => item.messageId)).toEqual([
        question.messageId,
        retry.messageId,
      ]);
      expect(readMessagePath(connection, answer.messageId)[1]?.parts).toEqual([
        { kind: "reasoning", text: "Add them." },
        { kind: "text", text: "4" },
      ]);
      expect(readMessagePath(connection, ids.next())).toEqual([]);
    });
  });

  it("keeps model, usage and tool calls, and refuses parts that do not fit the message", () => {
    withDatabase(({ connection, ids, projectId }) => {
      const { conversationId } = createConversation(connection, {
        conversationId: ids.next(),
        projectId,
        nowMs: 10,
      });
      const call = appendMessage(connection, {
        messageId: ids.next(),
        conversationId,
        role: "assistant",
        parts: [
          {
            kind: "tool-call",
            callId: "call-1",
            name: "fs.read",
            arguments: { path: "README.md" },
          },
        ],
        model: "scripted-1",
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          cachedInputTokens: 2,
          reasoningTokens: 1,
          cost: { amountDecimal: "0.000125", currency: "USD" },
        },
        nowMs: 10,
      });
      const result = appendMessage(connection, {
        messageId: ids.next(),
        conversationId,
        role: "tool",
        parts: [{ kind: "tool-result", callId: "call-1", value: { text: "hello" } }],
        nowMs: 11,
      });

      expect(readConversationMessages(connection, conversationId)).toEqual([call, result]);
      expect(call).toMatchObject({
        model: "scripted-1",
        runId: null,
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          cachedInputTokens: 2,
          reasoningTokens: 1,
          cost: { amountDecimal: "0.000125", currency: "USD" },
        },
      });
      expect(result.usage).toEqual({});

      const refuse = (role: DurableMessageRole, parts: unknown, field: string): void => {
        expect(
          failure(() =>
            appendMessage(connection, {
              messageId: ids.next(),
              conversationId,
              role,
              parts: parts as DurableMessagePart[],
              nowMs: 20,
            }),
          ),
        ).toMatchObject({ code: "CONVERSATION_INVALID", field });
      };
      refuse("user", [], "parts");
      refuse("user", [{ kind: "video", url: "x" }], "parts[0].kind");
      refuse("user", [{ kind: "text", text: "hi", extra: true }], "parts[0]");
      refuse("user", [{ kind: "tool-call", callId: "c", name: "n", arguments: {} }], "parts[0]");
      refuse("assistant", [{ kind: "tool-result", callId: "c", value: 1 }], "parts[0]");
      refuse("tool", [{ kind: "text", text: "not a result" }], "parts[0]");
      refuse(
        "system",
        [{ kind: "image", artifactRef: "blob:1", mediaType: "image/png" }],
        "parts[0]",
      );
      refuse(
        "user",
        [{ kind: "image", artifactRef: "blob:1", mediaType: "text/html" }],
        "parts[0].mediaType",
      );
      refuse(
        "assistant",
        [{ kind: "tool-call", callId: "c", name: "n", arguments: [] }],
        "parts[0].arguments",
      );
      refuse("user", [{ kind: "reasoning", text: "hmm" }], "parts[0]");
      refuse("narrator" as DurableMessageRole, say("x"), "role");

      const other = createConversation(connection, {
        conversationId: ids.next(),
        projectId,
        nowMs: 20,
      });
      expect(
        failure(() =>
          appendMessage(connection, {
            messageId: ids.next(),
            conversationId: other.conversationId,
            role: "user",
            parts: say("x"),
            parentMessageId: call.messageId,
            nowMs: 21,
          }),
        ),
      ).toMatchObject({ field: "parentMessageId" });
      expect(
        failure(() =>
          appendMessage(connection, {
            messageId: ids.next(),
            conversationId,
            role: "assistant",
            parts: say("x"),
            usage: { inputTokens: -1 },
            nowMs: 22,
          }),
        ),
      ).toMatchObject({ field: "usage.inputTokens" });
      expect(
        failure(() =>
          appendMessage(connection, {
            messageId: ids.next(),
            conversationId,
            role: "assistant",
            parts: say("x"),
            usage: { cost: { amountDecimal: "1.5", currency: "usd" } },
            nowMs: 22,
          }),
        ),
      ).toMatchObject({ field: "usage.cost.currency" });
    });
  });

  it("keeps messages append-only and conversations undeletable", () => {
    withDatabase(({ connection, ids, projectId }) => {
      const { conversationId } = createConversation(connection, {
        conversationId: ids.next(),
        projectId,
        nowMs: 10,
      });
      const message = appendMessage(connection, {
        messageId: ids.next(),
        conversationId,
        role: "user",
        parts: say("keep me"),
        nowMs: 10,
      });

      expect(() =>
        connection
          .prepare(`UPDATE ${MESSAGES_TABLE} SET content_json = '[]' WHERE message_id = ?`)
          .run(message.messageId),
      ).toThrow(/append-only/u);
      expect(() =>
        connection
          .prepare(`DELETE FROM ${MESSAGES_TABLE} WHERE message_id = ?`)
          .run(message.messageId),
      ).toThrow(/append-only/u);
      expect(() =>
        connection
          .prepare(`DELETE FROM ${CONVERSATIONS_TABLE} WHERE conversation_id = ?`)
          .run(conversationId),
      ).toThrow(/archived, never deleted/u);
      expect(() =>
        appendMessage(connection, {
          messageId: ids.next(),
          conversationId,
          role: "assistant",
          parts: say("from nowhere"),
          runId: "no-such-run",
          nowMs: 11,
        }),
      ).toThrow(/FOREIGN KEY/u);
    });
  });
});
