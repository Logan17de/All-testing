import type { DurableApprovalRecord } from "@zet-harness/db/durable-approval-records";

import { REDACTED, type RuntimeRedactionRegistry, type SafeJson } from "./runtime-redaction.js";

/**
 * Redact each bounded payload before forming a potentially larger list response.
 * Parse stored JSON first so field rules and escaped secret values remain visible.
 * The public view is not written back to durable state and never exposes token hashes.
 */
export function approvalHttpView(
  record: DurableApprovalRecord,
  redaction: RuntimeRedactionRegistry,
): SafeJson {
  const metadata = redaction.redact({
    approvalId: record.approvalId,
    runId: record.runId,
    compiledPlanId: record.compiledPlanId,
    opIndex: record.opIndex,
    iteration: record.iteration,
    logicalEffectId: record.logicalEffectId,
    checkpointId: record.checkpointId,
    status: record.status,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
    resolvedAtMs: record.resolvedAtMs,
  });
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return REDACTED;
  }
  const redactJson = (json: string | null): string | null => {
    if (json === null) return null;
    try {
      return JSON.stringify(redaction.redact(JSON.parse(json) as unknown));
    } catch {
      return JSON.stringify(REDACTED);
    }
  };
  return {
    ...metadata,
    requestJson: redactJson(record.requestJson),
    responseJson: redactJson(record.responseJson),
  };
}
