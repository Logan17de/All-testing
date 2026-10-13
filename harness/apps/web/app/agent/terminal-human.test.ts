import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TerminalGrantReview } from "./terminal-dock";
import { terminalDelta } from "./terminal-renderer";
import type { TerminalSession } from "./terminal-transport";

const review = {
  nonce: "exact-proposal",
  identity: "LOGAN\\codexsandboxoffline",
  shell: "C:\\Windows\\System32\\cmd.exe",
  cwd: "D:\\owned-fixture",
  conversationId: "fixture-chat",
  expiresAt: Date.now() + 60000,
};
describe("human PTY review and rendering (synthetic fixtures)", () => {
  it("shows exact scope and keeps grant disabled without consent or after expiry", () => {
    const onGrant = vi.fn();
    const render = (confirmed: boolean, expiresAt = review.expiresAt) =>
      renderToStaticMarkup(
        createElement(TerminalGrantReview, {
          review: { ...review, expiresAt },
          confirmed,
          now: Date.now(),
          busy: false,
          onConfirm: vi.fn(),
          onGrant,
        }),
      );
    const html = render(false);
    for (const value of [
      review.identity,
      review.shell,
      review.cwd,
      review.conversationId,
      "not filesystem isolation",
      "does not give agents terminal access",
    ])
      expect(html).toContain(value);
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(render(true)).not.toMatch(/<button[^>]*disabled/);
    expect(render(true, 1)).toMatch(/<button[^>]*disabled/);
    expect(onGrant).not.toHaveBeenCalled();
  });
  it("writes only new ordered combined PTY chunks, retaining control bytes as terminal data", () => {
    const session: TerminalSession = {
      id: "t",
      conversationId: "fixture-chat",
      cwd: "D:\\owned-fixture",
      status: "running",
      exitCode: null,
      cols: 80,
      rows: 24,
      cursor: 2,
      truncated: false,
      chunks: [
        { sequence: 1, stream: "terminal", text: "\u001b[31mred" },
        { sequence: 2, stream: "terminal", text: "\r\nnext" },
      ],
    };
    expect(terminalDelta(session, 1)).toEqual([session.chunks[1]]);
    expect(terminalDelta(session, 2)).toEqual([]);
    expect(terminalDelta(session, 0)[0]?.text).toBe("\u001b[31mred");
  });
});
