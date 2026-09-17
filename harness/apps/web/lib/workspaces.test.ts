import { describe, expect, it } from "vitest";

import { inWorkspace, isWorkspaceEntry } from "./workspaces";

describe("which folder a project belongs to", () => {
  it("counts the folder itself and anything inside it", () => {
    expect(inWorkspace("D:\\work\\alpha", "D:\\work")).toBe(true);
    expect(inWorkspace("D:\\work", "D:\\work\\")).toBe(true);
    expect(inWorkspace("D:/work/alpha/deeper", "D:\\work")).toBe(true);
    expect(inWorkspace("D:\\workshop", "D:\\work")).toBe(false);
    expect(inWorkspace("D:\\elsewhere", "D:\\work")).toBe(false);
  });

  it("puts a project with no folder of its own outside every workspace", () => {
    expect(inWorkspace(null, "D:\\work")).toBe(false);
    // With no workspace open, nothing is filtered out.
    expect(inWorkspace(null, null)).toBe(true);
    expect(inWorkspace("D:\\work", null)).toBe(true);
  });

  it("accepts only an entry it understands", () => {
    expect(
      isWorkspaceEntry({ path: "D:\\work", exists: true, current: false, openedAtMs: 1 }),
    ).toBe(true);
    expect(isWorkspaceEntry({ path: "D:\\work" })).toBe(false);
    expect(isWorkspaceEntry(null)).toBe(false);
  });
});
