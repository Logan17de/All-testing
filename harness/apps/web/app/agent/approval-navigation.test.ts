import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { mutationApprovals } from "./agent-view";
import { MutationApprovalCard } from "./mutation-approval";

const pending = {
  id: "approval-one",
  runId: "run-one",
  sessionId: "chat-one",
  tool: "harness.fs.apply_patch",
  args: { path: "one.txt", expectedContent: "before", content: "after" },
  requestGeneration: 4,
  expiresAtMs: 2000000000000,
};
function renderSelected(sessionId: string, runId?: string) {
  const respond = vi.fn(async () => {});
  const html = renderToStaticMarkup(
    createElement(
      "div",
      null,
      ...mutationApprovals([pending], sessionId, runId).map((request) =>
        createElement(MutationApprovalCard, {
          key: `${request.requestGeneration}:${request.id}`,
          request,
          respond,
        }),
      ),
    ),
  );
  return { html, respond };
}

describe("pending approval during chat navigation", () => {
  it("cannot display or approve chat one's request while another chat is selected", () => {
    const original = renderSelected("chat-one", "run-one");
    expect(original.html).toContain("Workspace mutation approval");
    expect(original.html).toContain("one.txt");
    for (const [sessionId, runId] of [
      ["chat-two", "run-two"],
      ["chat-two", "run-one"],
      ["chat-one", "run-two"],
      ["", undefined],
    ]) {
      const selected = renderSelected(sessionId!, runId);
      expect(selected.html).not.toContain("Approve once");
      expect(selected.html).not.toContain("one.txt");
      expect(selected.respond).not.toHaveBeenCalled();
    }
  });

  it("returning to the original chat requires fresh exact-action consent", () => {
    renderSelected("chat-one", "run-one");
    renderSelected("chat-two", "run-two");
    const returned = renderSelected("chat-one", "run-one");
    expect(returned.html).toContain("I approve exactly this tool and these arguments once.");
    expect(returned.html).toMatch(/<button disabled="">Approve once<\/button>/);
    expect(returned.html).not.toMatch(/<input[^>]*checked/);
    expect(returned.respond).not.toHaveBeenCalled();
  });
});
