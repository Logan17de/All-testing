import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readableChatExport } from "./chat-export";
import { ChatExportLink } from "./chat-export-link";
const id = "01a110b8-292d-73a8-a47d-16da3b861b38";
describe("direct local readable transcript export", () => {
  it("accepts readable empty/current-branch content and rejects paths or raw export shapes", () => {
    const file = {
      filename: "chat-fixture.md",
      content: "# Chat\n\nNo messages.\n",
      mediaType: "text/markdown; charset=utf-8",
    };
    expect(readableChatExport({ export: file })).toEqual(file);
    for (const change of [
      { filename: "../chat.md" },
      { filename: "D:\\chat.md" },
      { filename: "chat.html" },
      { mediaType: "text/html" },
      { content: {} },
    ])
      expect(() => readableChatExport({ export: { ...file, ...change } })).toThrow(
        "invalid chat export",
      );
    expect(() => readableChatExport({})).toThrow("did not return");
  });
  it("offers a native same-origin attachment link for the exact saved chat only when supported", () => {
    const html = renderToStaticMarkup(
      createElement(ChatExportLink, { sessionId: id, available: true }),
    );
    expect(html).toContain(`href="/api/editor/chat-export/${id}" download=""`);
    expect(html).not.toContain("blob:");
    const blocked = renderToStaticMarkup(
      createElement(ChatExportLink, { sessionId: id, available: false }),
    );
    expect(blocked).not.toContain("href=");
    expect(blocked).toContain("runtime update required");
    expect(
      renderToStaticMarkup(createElement(ChatExportLink, { sessionId: "../bad", available: true })),
    ).not.toContain("href=");
  });
});
