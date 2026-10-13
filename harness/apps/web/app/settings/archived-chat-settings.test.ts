import { describe, expect, it } from "vitest";
import {
  archivedChats,
  confirmedChatDeletion,
  retentionDays,
  savedRetentionDays,
} from "./archived-chat-settings";

describe("archived chat settings", () => {
  it("only acknowledges a confirmed deletion of the requested chat", () => {
    expect(confirmedChatDeletion({ deleted: true, sessionId: "selected" }, "selected")).toBe(true);
    for (const value of [
      null,
      {},
      { deleted: false, sessionId: "selected" },
      { deleted: true, sessionId: "other" },
    ])
      expect(confirmedChatDeletion(value, "selected")).toBe(false);
  });
  it("accepts never or positive whole days and rejects accidental immediate deletion", () => {
    expect(retentionDays("-1")).toBe(-1);
    expect(retentionDays(" 30 ")).toBe(30);
    expect(retentionDays("1")).toBe(1);
    for (const value of [
      "",
      " ",
      "0",
      "-0",
      "-2",
      "1.5",
      "1e2",
      "Infinity",
      "NaN",
      "9007199254740992",
    ])
      expect(retentionDays(value)).toBeNull();
  });
  it("requires a valid server policy rather than enabling a fabricated default", () => {
    expect(savedRetentionDays({ retention: { days: -1 } })).toBe(-1);
    expect(savedRetentionDays({ retention: { days: 7 }, deletedCount: 2 })).toBe(7);
    for (const value of [
      null,
      {},
      { retention: null },
      { retention: { days: "7" } },
      { retention: { days: 0 } },
      { retention: { days: NaN } },
    ])
      expect(savedRetentionDays(value)).toBeNull();
  });
  it("reads exact archived chat identities and rejects malformed or duplicate lists", () => {
    const id = "01a110b8-292d-73a8-a47d-16da3b861b38";
    const chat = { id, preview: "A chat", archivedAt: 1234 };
    expect(archivedChats({ data: [chat] })).toEqual([{ id, title: "A chat", archivedAt: 1234 }]);
    expect(archivedChats({ data: [{ id, preview: "", archivedAt: null }] })).toEqual([
      { id, title: "" },
    ]);
    expect(archivedChats({ data: [] })).toEqual([]);
    expect(archivedChats({ data: [chat, chat] })).toBeNull();
    expect(archivedChats({ data: [{ ...chat, id: "../other" }] })).toBeNull();
    expect(archivedChats({ data: [{ id }] })).toBeNull();
    expect(archivedChats(null)).toBeNull();
  });
});
