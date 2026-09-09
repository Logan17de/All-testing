import type { IncomingMessage, ServerResponse } from "node:http";

import { RuntimeApiSecurity, RuntimeApiSecurityError } from "./runtime-api-security.js";
import { RuntimeApprovalError } from "./runtime-approval-error.js";
import type { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";

export function writeRuntimeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

export function writeRuntimeApiError(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  if (error instanceof RuntimeApprovalError || error instanceof RuntimeApiSecurityError) {
    if (error.statusCode === 413) response.setHeader("connection", "close");
    writeRuntimeJson(response, error.statusCode, {
      error: { code: error.code, reason: error.message, remediation: error.remediation },
    });
  } else {
    writeRuntimeJson(response, 500, {
      error: {
        code: "RUNTIME_REQUEST_FAILED",
        reason: "The runtime could not process this request.",
        remediation: "inspect-runtime-health",
      },
    });
  }
}

async function readObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    size += buffer.length;
    if (size > 65_536) {
      request.resume();
      throw new RuntimeApiSecurityError("LOCAL_API_BODY_TOO_LARGE", "Request exceeds 64 KiB.", 413);
    }
    parts.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } catch {
    throw new RuntimeApprovalError("APPROVAL_INVALID_REQUEST");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeApprovalError("APPROVAL_INVALID_REQUEST");
  }
  return value as Record<string, unknown>;
}

/** Called only after the shared host/origin guard succeeds. Tokens never enter URLs or events. */
export async function handleApprovalHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  security: RuntimeApiSecurity,
  approvals: RuntimeHumanApprovals | undefined,
  redaction: RuntimeRedactionRegistry,
): Promise<void> {
  if (url.pathname === "/api/session") {
    if (request.method !== "GET") {
      writeRuntimeJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    writeRuntimeJson(response, 200, { csrfToken: security.sessionToken() });
    return;
  }
  if (approvals === undefined) {
    writeRuntimeJson(response, 503, { error: { code: "APPROVAL_SERVICE_UNAVAILABLE" } });
    return;
  }
  if (url.pathname === "/api/approvals" && request.method === "GET") {
    const runId = url.searchParams.get("runId") ?? undefined;
    writeRuntimeJson(
      response,
      200,
      redaction.redact({ approvals: approvals.listPending(runId), limit: 100 }),
    );
    return;
  }
  const match = /^\/api\/approvals\/([^/]+)(?:\/(token|resume))?$/.exec(url.pathname);
  if (match === null) {
    writeRuntimeJson(response, 404, { error: "not_found" });
    return;
  }
  let approvalId: string;
  try {
    approvalId = decodeURIComponent(match[1]!);
  } catch {
    throw new RuntimeApprovalError("APPROVAL_INVALID_REQUEST");
  }
  const action = match[2];
  if (action === undefined && request.method === "GET") {
    writeRuntimeJson(response, 200, redaction.redact({ approval: approvals.get(approvalId) }));
    return;
  }
  if (request.method !== "POST" || action === undefined) {
    writeRuntimeJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  security.checkMutation(request);
  const body = await readObject(request);
  if (action === "token") {
    if (Object.keys(body).length !== 0) throw new RuntimeApprovalError("APPROVAL_INVALID_REQUEST");
    // Intentional secret-delivery response, guarded by both origin and CSRF checks.
    writeRuntimeJson(response, 200, await approvals.issueResumeToken(approvalId));
    return;
  }
  if (
    Object.keys(body).some((key) => !["resumeToken", "decision", "payload"].includes(key)) ||
    typeof body.resumeToken !== "string" ||
    (body.decision !== "approved" && body.decision !== "rejected")
  ) {
    throw new RuntimeApprovalError("APPROVAL_INVALID_REQUEST");
  }
  const result = await approvals.resume({
    approvalId,
    resumeToken: body.resumeToken,
    decision: body.decision,
    payload: body.payload ?? null,
  });
  writeRuntimeJson(response, 200, redaction.redact(result));
}
