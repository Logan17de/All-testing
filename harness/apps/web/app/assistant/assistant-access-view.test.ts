import { describe, expect, it } from "vitest";
import { assistantAccess, assistantPermissions } from "./assistant-access-view";
describe("assistant authorization graph view", () => {
  it("uses only real grants and never infers access from chat metadata", () => {
    expect(
      assistantAccess(
        {
          binding: { assistantId: "parent", actorChatId: "own", epoch: 1 },
          grants: [],
          notice: "",
        },
        "parent",
      )?.grants,
    ).toEqual([]);
    expect(
      assistantAccess(
        {
          binding: { assistantId: "parent", actorChatId: "own", epoch: 2 },
          grants: [{ chatId: "connected", permissions: ["read"] }],
        },
        "parent",
      )?.grants,
    ).toEqual([{ chatId: "connected", permissions: ["read"] }]);
  });
  it("rejects other assistants, duplicate edges and unsupported grants", () => {
    const base = {
      binding: { assistantId: "parent", actorChatId: "own", epoch: 1 },
      grants: [{ chatId: "child", permissions: ["control"] }],
    };
    expect(assistantAccess(base, "other")).toBeUndefined();
    expect(
      assistantAccess({ ...base, grants: [...base.grants, ...base.grants] }, "parent"),
    ).toBeUndefined();
    for (const value of [[], ["admin"], ["read", "read"], null])
      expect(assistantPermissions(value)).toBeUndefined();
  });
});
