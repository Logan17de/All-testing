import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessages } from "./chat-messages";

function render(parts: unknown[], role = "assistant") {
  return renderToStaticMarkup(
    createElement(ChatMessages, {
      transcript: { messages: [{ messageId: "message", parentMessageId: null, role, parts }] },
    }),
  );
}

describe("chat message content", () => {
  it("honestly describes an assistant message with no visible content", () => {
    for (const parts of [[], [{ kind: "text", text: "" }], [{ kind: "text", text: " \n " }]]) {
      expect(render(parts)).toContain("No response text was returned.");
    }
    expect(render([{ kind: "text", text: "" }], "user")).not.toContain(
      "No response text was returned.",
    );
  });

  it("preserves normal text, tool calls/results, reasoning and image references", () => {
    const html = render([
      { kind: "text", text: "A real reply" },
      { kind: "reasoning", text: "Reasoning content" },
      { kind: "tool-call", name: "inspect", callId: "call", arguments: {} },
      { kind: "tool-result", callId: "call", result: "done" },
      { kind: "image", artifactRef: "artifact", mediaType: "image/png" },
    ]);
    for (const content of [
      "A real reply",
      "Reasoning content",
      "Tool: inspect",
      "Tool result",
      "Image reference",
    ])
      expect(html).toContain(content);
    expect(html).not.toContain("No response text was returned.");
  });

  it("does not call tool-only or image-only assistant messages empty", () => {
    for (const parts of [
      [{ kind: "tool-call", name: "inspect", callId: "call", arguments: {} }],
      [{ kind: "image", artifactRef: "artifact", mediaType: "image/png" }],
    ])
      expect(render(parts)).not.toContain("No response text was returned.");
  });
});
