import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./terminal-dock", () => ({
  TerminalDock: ({ conversationId }: { conversationId: string }) =>
    createElement("section", { "data-terminal-conversation": conversationId }, "Terminal fixture"),
}));
import { AgentWorkspace } from "./agent-workspace";

describe("chat terminal integration", () => {
  it("binds the side-panel terminal to the actual selected conversation without replacing chat or graph", () => {
    const html = renderToStaticMarkup(
      createElement(AgentWorkspace, { initialSessionId: "chat-a" }),
    );
    expect(html).toContain('data-terminal-conversation="chat-a"');
    expect(html).toContain('id="coding-prompt"');
    expect(html).toContain('id="coding-graph"');
    expect(html.indexOf("Terminal fixture")).toBeGreaterThan(html.indexOf('id="coding-terminal"'));
    const inspector = html.slice(html.indexOf('<aside id="coding-inspector"'));
    expect(inspector).toContain("Terminal fixture");
    expect(html).toContain('aria-controls="coding-terminal"');
    const next = renderToStaticMarkup(
      createElement(AgentWorkspace, { initialSessionId: "chat-b" }),
    );
    expect(next).toContain('data-terminal-conversation="chat-b"');
    expect(next).not.toContain('data-terminal-conversation="chat-a"');
  });
  it("passes no invented session when chat has not been created", () => {
    const html = renderToStaticMarkup(createElement(AgentWorkspace));
    expect(html).toContain('data-terminal-conversation=""');
  });
});
