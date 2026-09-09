import { describe, expect, it } from "vitest";

import type { DurableApprovalRecord } from "@zet-harness/db/durable-approval-records";
import { approvalHttpView } from "./runtime-approval-view.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";

function record(requestJson: string, responseJson: string | null = null): DurableApprovalRecord {
  return {
    approvalId: "approval-test",
    runId: "run-test",
    compiledPlanId: 1,
    opIndex: 0,
    iteration: 0,
    logicalEffectId: "effect-test",
    checkpointId: 1,
    status: "pending",
    requestJson,
    responseJson,
    createdAtMs: 1,
    expiresAtMs: null,
    resolvedAtMs: null,
  };
}

describe("approval HTTP views", () => {
  it("retains bounded large approvals when their aggregate exceeds the per-payload limit", () => {
    const redaction = new RuntimeRedactionRegistry();
    const requestJson = JSON.stringify({ prompt: "x".repeat(40_000) });
    const views = [record(requestJson), record(requestJson)].map((value) =>
      approvalHttpView(value, redaction),
    );
    const body = JSON.stringify({ approvals: views, limit: 100 });
    expect(Buffer.byteLength(body)).toBeGreaterThan(65_536);
    expect(views).toEqual([
      expect.objectContaining({ approvalId: "approval-test", requestJson }),
      expect.objectContaining({ approvalId: "approval-test", requestJson }),
    ]);
  });

  it("redacts parsed JSON fields and escaped secret text without changing stored payloads", () => {
    const redaction = new RuntimeRedactionRegistry();
    const material = 'private\n"value"';
    redaction.registerSecret(material);
    const original = record(
      JSON.stringify({ prompt: material }),
      JSON.stringify({ apiKey: "private-key", comment: "safe" }),
    );
    const view = approvalHttpView(original, redaction);
    expect(view).toMatchObject({
      requestJson: JSON.stringify({ prompt: "[REDACTED]" }),
      responseJson: JSON.stringify({ apiKey: "[REDACTED]", comment: "safe" }),
    });
    expect(JSON.parse(original.requestJson)).toEqual({ prompt: material });
    expect(JSON.stringify(view)).not.toContain("private-key");
  });

  it("omits unexpected stored fields and fails closed on invalid stored payload text", () => {
    const redaction = new RuntimeRedactionRegistry();
    const stored = { ...record("not-json"), resumeTokenHash: "must-not-be-public" };
    const view = approvalHttpView(stored, redaction);
    expect(view).toMatchObject({ requestJson: '"[REDACTED]"', responseJson: null });
    expect(JSON.stringify(view)).not.toContain("must-not-be-public");
  });
});
