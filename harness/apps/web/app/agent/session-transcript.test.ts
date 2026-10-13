import { describe, expect, it } from "vitest";
import { sessionTranscript } from "./session-transcript";

describe("session transcript isolation", () => {
  const previous = { sessionId: "previous", value: { messages: ["Previous user message"] } };

  it("clears the visible transcript immediately when a new chat is selected", () => {
    expect(sessionTranscript(previous, "previous")).toBe(previous.value);
    expect(sessionTranscript(previous, "new")).toBeNull();
    expect(sessionTranscript(previous, "")).toBeNull();
  });

  it("ignores a late read for another chat and accepts the selected chat snapshot", () => {
    expect(sessionTranscript(previous, "new")).toBeNull();
    const current = { sessionId: "new", value: { messages: [] } };
    expect(sessionTranscript(current, "new")).toBe(current.value);
    expect(sessionTranscript(null, "new")).toBeNull();
  });
});
