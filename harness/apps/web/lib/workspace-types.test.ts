import { describe, expect, it } from "vitest";

import { latestBranch, reasonOf, type MessageView } from "./workspace-types";

const message = (messageId: string, parentMessageId: string | null): MessageView => ({
  messageId,
  conversationId: "c",
  parentMessageId,
  role: "user",
  parts: [{ kind: "text", text: messageId }],
  model: null,
  runId: null,
  createdAtMs: 1,
});

describe("workspace view helpers", () => {
  it("follows the newest message back to its root", () => {
    const messages = [
      message("question", null),
      message("answer", "question"),
      message("retry", "question"),
      message("follow-up", "retry"),
    ];
    expect(latestBranch(messages).map((item) => item.messageId)).toEqual([
      "question",
      "retry",
      "follow-up",
    ]);
    expect(latestBranch([])).toEqual([]);
  });

  it("reads the runtime's error reason or falls back", () => {
    expect(reasonOf({ error: { code: "X", reason: "Not allowed." } }, "fallback")).toBe(
      "Not allowed.",
    );
    expect(reasonOf({ error: "x" }, "fallback")).toBe("fallback");
    expect(reasonOf(null, "fallback")).toBe("fallback");
  });
});
