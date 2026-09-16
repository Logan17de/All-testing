import { describe, expect, it } from "vitest";

import { runtimeModelPath } from "./model-routes";

describe("model proxy paths", () => {
  it("maps a model id to its runtime endpoints", () => {
    expect(runtimeModelPath("llama3.1-8b")).toBe("/api/models/llama3.1-8b");
    expect(runtimeModelPath("gpt", "check")).toBe("/api/models/gpt/check");
  });

  it("refuses anything that is not a model id", () => {
    for (const id of ["", "..", ".hidden", "Upper", "a/b", "a b", "x".repeat(65)]) {
      expect(runtimeModelPath(id)).toBeUndefined();
    }
  });
});
