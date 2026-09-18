import { describe, expect, it } from "vitest";

import {
  ASK_MODEL_TYPE,
  OUTPUT_BOX_TYPE,
  TEXT_BOX_TYPE,
  orderPalette,
  recordedText,
  textBoxValue,
} from "./boxes";

const entry = (type: string) => ({ manifest: { type } });

describe("the boxes", () => {
  it("lead the palette in the order a graph reads, leaving the rest as they came", () => {
    const ordered = orderPalette([
      entry("harness.github-component"),
      entry(OUTPUT_BOX_TYPE),
      entry("harness.agent-model"),
      entry(ASK_MODEL_TYPE),
      entry(TEXT_BOX_TYPE),
    ]);
    expect(ordered.map((item) => item.manifest.type)).toEqual([
      TEXT_BOX_TYPE,
      ASK_MODEL_TYPE,
      OUTPUT_BOX_TYPE,
      "harness.github-component",
      "harness.agent-model",
    ]);
  });

  it("read the text a run recorded, and nothing that is not text", () => {
    expect(recordedText({ text: { kind: "inline", value: "hello" } })).toBe("hello");
    expect(recordedText({ text: { kind: "inline", value: "" } })).toBe("");
    expect(recordedText({ text: { kind: "inline", value: 42 } })).toBeUndefined();
    expect(recordedText({ text: { kind: "ref", ref: "blob-1" } })).toBeUndefined();
    expect(recordedText({ other: { kind: "inline", value: "x" } })).toBeUndefined();
    expect(recordedText(null)).toBeUndefined();
  });

  it("read a Text box's own text, or nothing yet", () => {
    expect(textBoxValue({ text: "hello" })).toBe("hello");
    expect(textBoxValue({})).toBe("");
    expect(textBoxValue({ text: 3 })).toBe("");
  });
});
