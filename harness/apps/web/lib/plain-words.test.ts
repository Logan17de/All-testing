import { describe, expect, it } from "vitest";

import {
  behaviourLabel,
  capabilityLabel,
  eventLabel,
  fieldLabel,
  isInternalEvent,
  modelLabel,
  pluginLabel,
  toolLabel,
} from "./plain-words";

describe("plain words in place of internal names", () => {
  it("names settings the way a person would", () => {
    expect(fieldLabel("systemPrompt")).toBe("Instructions");
    expect(fieldLabel("conversationId")).toBe("Conversation");
    expect(fieldLabel("finishReason")).toBe("Finish reason");
    expect(fieldLabel("again")).toBe("Again");
    expect(fieldLabel("sourceRunId")).toBe("Source run ID");
  });

  it("names plugins without their ids", () => {
    expect(pluginLabel("harness.agent-plugin")).toBe("Agent");
    expect(pluginLabel("harness.control-flow-plugin")).toBe("Control flow");
    expect(pluginLabel("com.example.hello-plugin")).toBe("Hello");
    expect(pluginLabel("com.example.reverse-text")).toBe("Reverse text");
  });

  it("says what a recorded event means, and hides scheduling bookkeeping", () => {
    expect(eventLabel("harness.attempt.started")).toBe("started");
    expect(eventLabel("harness.run.completed")).toBe("run finished");
    expect(eventLabel("harness.something.new-thing")).toBe("something new thing");
    expect(isInternalEvent("harness.frontier.op")).toBe(true);
    expect(isInternalEvent("harness.frontier.router-selection")).toBe(false);
    expect(isInternalEvent("harness.attempt.completed")).toBe(false);
  });

  it("names tools, models, permissions and behaviour plainly", () => {
    expect(toolLabel("harness_goals_create")).toBe("Create a goal");
    expect(toolLabel("github_issues_list")).toBe("List GitHub issues");
    expect(toolLabel("harness_calendar_read")).toBe("Calendar read");
    expect(modelLabel("local-llama@1")).toBe("local-llama");
    expect(capabilityLabel("network:https")).toBe("Internet (https)");
    expect(capabilityLabel("custom:thing")).toBe("custom:thing");
    expect(behaviourLabel("external-write", "rerun")).toBe(
      "Changes things outside the graph; safe to run again.",
    );
  });
});
