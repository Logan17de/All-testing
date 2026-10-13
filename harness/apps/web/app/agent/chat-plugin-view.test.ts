import { describe, expect, it } from "vitest";
import { chatPluginInventory } from "./chat-plugin-view";
const available = [
  { id: "example.read", title: "Read", pluginId: "example", status: "enabled-granted" },
];
describe("chat plugin graph scope", () => {
  it("distinguishes default all, explicit none and canonical node allowlists", () => {
    for (const model of [null, [], ["example.read"]])
      expect(
        chatPluginInventory({ available, restrictions: { model, tools: null } })?.restrictions,
      ).toEqual({ model, tools: null });
  });
  it("rejects malformed scopes instead of broadening access", () => {
    for (const model of [undefined, "all", [1], ["example.read", "example.read"]])
      expect(
        chatPluginInventory({ available, restrictions: { model, tools: null } }),
      ).toBeUndefined();
    expect(
      chatPluginInventory({
        available: [...available, ...available],
        restrictions: { model: null, tools: null },
      }),
    ).toBeUndefined();
  });
});
