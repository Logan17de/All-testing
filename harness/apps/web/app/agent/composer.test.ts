import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentWorkspace,
  canSubmitTask,
  availableModelId,
  modelContextHint,
} from "./agent-workspace";

describe("compact task composer", () => {
  it("renders one prompt and compact real controls without invented access or usage", () => {
    const html = renderToStaticMarkup(createElement(AgentWorkspace));
    expect(html).toContain('placeholder="Do anything"');
    expect(html).toContain("Ask for approval");
    expect(html).toContain('aria-label="Send task"');
    expect(html).not.toContain('id="coding-instructions"');
    expect(html).toContain('id="coding-prompt"');
    const composer = html.slice(
      html.indexOf('<form class="codingComposer"'),
      html.indexOf("</form>"),
    );
    expect(composer).not.toContain("coding-instructions");
    expect(composer).not.toContain('type="checkbox"');
    expect(composer).not.toContain('aria-label="Task options"');
    expect(html).not.toContain('aria-label="Chat settings"');
    expect(html).not.toContain('class="codingSettingsDialog"');
    expect(composer).not.toContain('type="radio"');
    expect(composer).not.toContain("Approve for me");
    expect(composer).not.toContain("Full access");
    expect(composer).toContain("Ask for approval");
    expect(composer.match(/<button/g)).toHaveLength(1);
    expect(html.indexOf('aria-label="Chat actions"')).toBeLessThan(
      html.indexOf('id="coding-prompt"'),
    );
    expect(html).toContain('aria-label="Resize side panel"');
    expect(html).toContain('aria-controls="coding-inspector"');
    expect(html).toContain('aria-label="Chat details"');
    expect(html).toContain('id="coding-terminal"');
    expect(html).toContain("Shift + Enter for a new line.");
    expect(html).not.toContain("Tools &amp; permissions");
    expect(html).not.toContain("% remaining");
    expect(html).toContain("Actions still require approval.");
    expect(html).not.toContain("Archived chats");
    expect(html).not.toContain("Select archived chat");
    expect(html).not.toContain("Restore chat");
  });

  it("enforces the same send gates for the form and button", () => {
    const ready = {
      busy: false,
      archived: false,
      active: false,
      sessionId: "chat",
      modelId: "model",
      prompt: "Hello",
    };
    expect(canSubmitTask(ready)).toBe(true);
    for (const override of [
      { busy: true },
      { archived: true },
      { active: true },
      { sessionId: "" },
      { modelId: "" },
      { prompt: " \n " },
    ])
      expect(canSubmitTask({ ...ready, ...override })).toBe(false);
  });

  it("shows context capacity only when actual model metadata provides it", () => {
    expect(modelContextHint({ contextWindowTokens: 32000 })).toBe(
      "Context window: 32,000 tokens. Usage is unavailable.",
    );
    for (const model of [
      undefined,
      {},
      { contextWindowTokens: "32000" },
      { contextWindowTokens: -1 },
      { contextWindowTokens: Infinity },
    ])
      expect(modelContextHint(model)).toBe("Context window usage is unavailable.");
  });

  it("retains an available model across refresh and gates sending when it is removed", () => {
    const selected = "provider-one";
    expect(
      availableModelId(
        [{ id: "provider-two" }, { id: selected, displayName: "Updated name" }],
        selected,
      ),
    ).toBe(selected);
    for (const models of [[], [{ id: "provider-two" }]]) {
      const modelId = availableModelId(models, selected);
      expect(modelId).toBe("");
      expect(
        canSubmitTask({
          busy: false,
          archived: false,
          active: false,
          sessionId: "chat",
          modelId,
          prompt: "Preserved draft",
        }),
      ).toBe(false);
    }
  });
});
