import { describe, expect, it } from "vitest";
import { clampPanelWidth } from "./panel-width";

describe("persisted panel widths", () => {
  it("recovers from missing, corrupted and nonfinite preferences", () => {
    for (const value of [null, undefined, "", " ", "bad", Infinity, NaN, {}]) {
      expect(clampPanelWidth(value, 248, 200, 360)).toBe(248);
    }
  });
  it("bounds stored and dragged widths and rounds fractional pixels", () => {
    expect(clampPanelWidth("-5", 248, 200, 360)).toBe(200);
    expect(clampPanelWidth("999999", 248, 200, 360)).toBe(360);
    expect(clampPanelWidth(271.6, 248, 200, 360)).toBe(272);
  });
});
