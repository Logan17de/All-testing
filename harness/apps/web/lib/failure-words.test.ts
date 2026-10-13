import { describe, expect, it } from "vitest";

import { describeFailure, failureReason } from "./failure-words";

describe("why something failed", () => {
  it("explains validated provider stages without displaying arbitrary provider text", () => {
    const failure = (stage: string) =>
      describeFailure({
        code: "RUNTIME_EXECUTION_FAILED",
        cause: { code: "MODEL_RESPONSE_INVALID", stage },
      });
    expect(failure("responses.incomplete-output-limit")).toContain("output limit");
    expect(failure("responses.subscription-usage-limit")).toContain("shared usage limit");
    expect(failure("responses.subscription-usage-unavailable")).toContain("currently unavailable");
    expect(failure("responses.incomplete-content-filter")).toContain("content policy");
    expect(failure("private-provider-text")).not.toContain("private-provider-text");
  });
  it("says what the step reported, in front of the runtime's own code", () => {
    expect(
      describeFailure({
        code: "RUNTIME_EXECUTION_FAILED",
        cause: { code: "MODEL_HTTP_ERROR", status: 401 },
      }),
    ).toBe(
      "The provider rejected authentication (HTTP 401). Check the account connection or API credentials on Models.",
    );
    expect(
      describeFailure({ code: "RUNTIME_EXECUTION_FAILED", cause: { code: "AGENT_NO_MODEL" } }),
    ).toContain("No connected model");
    expect(
      describeFailure({
        code: "RUNTIME_EXECUTION_FAILED",
        cause: { code: "MODEL_HTTP_ERROR", status: 402 },
      }),
    ).toContain("cannot pay");
  });

  it("says nothing when a failure says nothing it has words for", () => {
    expect(describeFailure({ code: "RUNTIME_EXECUTION_FAILED" })).toBeNull();
    expect(
      describeFailure({ code: "RUNTIME_EXECUTION_FAILED", cause: { code: "WAT" } }),
    ).toBeNull();
    expect(describeFailure(null)).toBeNull();
    expect(describeFailure("failed")).toBeNull();
  });

  it("uses the runtime's own code when there is no cause, and it has words for it", () => {
    expect(describeFailure({ code: "PERMISSION_DENIED" })).toContain("not allowed");
    expect(describeFailure({ code: "RUNTIME_BUDGET_EXCEEDED" })).toContain("limit");
  });

  it("reads one code the same way wherever it turns up", () => {
    expect(failureReason("MODEL_NETWORK_ERROR")).toContain("could not be reached");
    expect(failureReason("MODEL_HTTP_ERROR", 500)).toContain("server error");
    expect(failureReason("MODEL_HTTP_ERROR")).toBeUndefined();
    expect(failureReason("NOT_A_CODE")).toBeUndefined();
  });
});
