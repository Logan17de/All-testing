import { describe, expect, it } from "vitest";
import { childToolRights } from "./child-tool-rights-view";
describe("authoritative child tool rights", () => {
  const state = {
    epoch: 1,
    audit: [],
    catalog: ["native.fs.read"],
    actors: [
      {
        chatId: "parent",
        parentChatId: null,
        scopes: { model: null, tools: null },
        delegationCeiling: null,
      },
    ],
    requests: [
      {
        id: "request",
        childChatId: "child",
        parentChatId: "parent",
        epoch: 1,
        scopes: { model: [], tools: [] },
        status: "pending",
        requiresUser: true,
      },
    ],
  };
  it("preserves empty scopes and required user review without inferring authority", () => {
    expect(childToolRights(state)?.requests[0]?.requiresUser).toBe(true);
    expect(childToolRights(state)?.requests[0]?.scopes.tools).toEqual([]);
  });
  it("fails closed for malformed rights and unknown statuses", () => {
    expect(
      childToolRights({ ...state, catalog: ["native.fs.read", "native.fs.read"] }),
    ).toBeUndefined();
    expect(
      childToolRights({ ...state, requests: [{ ...state.requests[0], status: "auto-approved" }] }),
    ).toBeUndefined();
    expect(
      childToolRights({ ...state, actors: [{ ...state.actors[0], scopes: { model: null } }] }),
    ).toBeUndefined();
  });
});
