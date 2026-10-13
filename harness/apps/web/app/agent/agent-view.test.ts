import { describe, expect, it } from "vitest";
import { agentEvents, agentEventLabel, agentRuns, mutationApprovals } from "./agent-view";

describe("standalone agent views", () => {
  it("accepts native run snapshots without inventing Codex protocol statuses", () => {
    expect(agentRuns({ session: { id: "run", status: "waiting" }, invalid: { id: 3 } })).toEqual({
      session: { id: "run", status: "waiting" },
    });
    expect(agentRuns(null)).toEqual({});
  });
  it("filters the selected run and deduplicates event sequence", () => {
    const event = {
      sequence: 2,
      type: "runtime",
      params: { runId: "selected", eventType: "harness.node.started" },
    };
    expect(
      agentEvents(
        [event, event, { sequence: 3, type: "runtime", params: { runId: "other" } }],
        "selected",
      ),
    ).toEqual([event]);
    expect(agentEventLabel(event)).toBe("node started");
  });
});

describe("native mutation request scope", () => {
  it("does not show another session/run or malformed approval", () => {
    const request = {
      id: "request",
      runId: "run",
      sessionId: "session",
      tool: "write_file",
      args: { path: "demo.txt", text: "fixture" },
      requestGeneration: 3,
      expiresAtMs: 12345,
    };
    expect(
      mutationApprovals(
        [
          request,
          { ...request, runId: "other" },
          { ...request, sessionId: "other" },
          { ...request, requestGeneration: "3" },
        ],
        "session",
        "run",
      ),
    ).toEqual([request]);
    expect(mutationApprovals([request], "session")).toEqual([]);
  });
});
