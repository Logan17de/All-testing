import { describe, expect, it } from "vitest";
import { eventView, turnProgress, mergeNativeEvents, updateTurnStates } from "./codex-event-view";

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

describe("native polling continuity", () => {
  it("deduplicates and sorts overlapping responses, and drops pre-restart history", () => {
    const event = (sequence: number) => ({ sequence, method: "test", params: {} });
    expect(
      mergeNativeEvents([event(2), event(1)], [event(2), event(3)]).map((item) => item.sequence),
    ).toEqual([1, 2, 3]);
    expect(mergeNativeEvents([event(100)], [event(1)], true).map((item) => item.sequence)).toEqual([
      1,
    ]);
  });
  it("retains terminal turn status when rolling event history expires", () => {
    const terminal = {
      sequence: 1,
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status: "interrupted" } },
    };
    const states = updateTurnStates({}, [terminal]);
    expect(
      updateTurnStates(states, [
        { sequence: 205, method: "item/agentMessage/delta", params: { delta: "another session" } },
      ]).thread,
    ).toEqual({ id: "turn", status: "interrupted" });
  });
});
