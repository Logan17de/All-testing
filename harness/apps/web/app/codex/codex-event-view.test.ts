import { describe, expect, it } from "vitest";
import { eventView, turnProgress } from "./codex-event-view";

describe("native Codex event views", () => {
  it("displays streamed text without exposing protocol details in the label", () => {
    expect(
      eventView({ sequence: 1, method: "item/agentMessage/delta", params: { delta: "Hello" } }),
    ).toEqual({ title: "Assistant response", text: "Hello" });
  });
  it("does not let another session or older turn mark a running task complete", () => {
    const events = [
      {
        sequence: 1,
        method: "turn/completed",
        params: { threadId: "other", turn: { id: "turn", status: "completed" } },
      },
      {
        sequence: 2,
        method: "turn/completed",
        params: { threadId: "thread", turn: { id: "older", status: "completed" } },
      },
    ];
    expect(turnProgress(events, "thread", "turn").active).toBe(true);
    expect(
      turnProgress(
        [
          ...events,
          {
            sequence: 3,
            method: "turn/completed",
            params: { threadId: "thread", turn: { id: "turn", status: "interrupted" } },
          },
        ],
        "thread",
        "turn",
      ),
    ).toEqual({ active: false, label: "Task interrupted." });
  });
});
