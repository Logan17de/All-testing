import { describe, expect, it } from "vitest";
import { canRequestRun, currentValidation, type Validation } from "./editor-state";

describe("current graph compiler state", () => {
  it("invalidates a successful result immediately after semantic edits or import", () => {
    const status = currentValidation(false, "edited document", "old document", "valid");
    expect(status).toBe("checking");
    expect(canRequestRun(status, true, false)).toBe(false);
  });
  it("does not surface diagnostics belonging to an earlier document", () => {
    expect(currentValidation(false, "new document", "old document", "invalid")).toBe("checking");
  });
  it("keeps an unchanged validated document runnable", () => {
    expect(currentValidation(false, "same document", "same document", "valid")).toBe("valid");
    expect(canRequestRun("valid", true, false)).toBe(true);
  });
  it("keeps the run action available to explain current compiler diagnostics", () => {
    expect(currentValidation(false, "same document", "same document", "invalid")).toBe("invalid");
    expect(canRequestRun("invalid", true, false)).toBe(true);
  });
  it("resets an emptied graph to idle even after validation success", () => {
    expect(currentValidation(true, null, "old document", "valid")).toBe("idle");
    expect(canRequestRun("idle", true, false)).toBe(false);
  });
  it.each<Validation>(["idle", "checking", "unreachable"])("blocks runs while %s", (status) => {
    expect(canRequestRun(status, true, false)).toBe(false);
  });
  it("blocks duplicate submissions and unavailable palettes", () => {
    expect(canRequestRun("valid", true, true)).toBe(false);
    expect(canRequestRun("valid", false, false)).toBe(false);
  });
  it("requires an executable body before accepting compiler success", () => {
    expect(currentValidation(false, null, null, "valid")).toBe("checking");
  });
});
