import { expect, it } from "vitest";
import { withoutPrivateModelState } from "./runtime-public-model-state.js";

it("keeps ordered public chat while hiding nested encrypted provider history without mutating it", () => {
  const state = {
    kind: "provider-state",
    provider: "openai-responses",
    encryptedContent: "PRIVATE",
  };
  const history = {
    messages: [
      { parts: [{ kind: "text", text: "hello" }, state, { kind: "tool-call", callId: "call" }] },
    ],
    replay: { state },
    encryptedContent: "PRIVATE",
  };
  const publicHistory = withoutPrivateModelState(history);
  expect(publicHistory).toEqual({
    messages: [
      {
        parts: [
          { kind: "text", text: "hello" },
          { kind: "tool-call", callId: "call" },
        ],
      },
    ],
    replay: {},
  });
  expect(JSON.stringify(publicHistory)).not.toContain("PRIVATE");
  expect(history.messages[0]!.parts[1]).toBe(state);
  expect(state.encryptedContent).toBe("PRIVATE");
});
