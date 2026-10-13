import { describe, expect, it } from "vitest";
import { RuntimeCodingPreflightError } from "./runtime-coding-preflight.js";

describe("native agent public preflight diagnostics", () => {
  it("uses fixed reasons instead of internal error details", () => {
    const error = new RuntimeCodingPreflightError(
      "PROJECT_FOLDER_UNAVAILABLE",
      "private-path-or-provider-detail",
    );
    expect(error.publicDiagnostic()).toEqual({
      code: "PROJECT_FOLDER_UNAVAILABLE",
      reason: "The trusted project folder changed or is unavailable; select and trust it again.",
    });
    expect(JSON.stringify(error.publicDiagnostic())).not.toContain(
      "private-path-or-provider-detail",
    );
    expect({ code: error.code, message: error.message }).not.toBeInstanceOf(
      RuntimeCodingPreflightError,
    );
  });
});
