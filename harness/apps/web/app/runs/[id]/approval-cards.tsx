"use client";

import { useEffect, useState } from "react";

interface ApprovalView {
  readonly approvalId: string;
  readonly opIndex: number;
  readonly status: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number | null;
  readonly requestJson: string | null;
}

const POLL_MS = 1500;

function isApproval(value: unknown): value is ApprovalView {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["approvalId"] === "string" &&
    typeof record["opIndex"] === "number" &&
    typeof record["status"] === "string"
  );
}

function reasonOf(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { readonly error: unknown }).error;
    if (typeof error === "object" && error !== null && "reason" in error) {
      const reason = (error as { readonly reason: unknown }).reason;
      if (typeof reason === "string") return reason;
    }
  }
  return fallback;
}

/** The human-readable request: the node's prompt when it has one, otherwise the request itself. */
function requestText(requestJson: string | null): string | null {
  if (requestJson === null) return null;
  try {
    const request = JSON.parse(requestJson) as unknown;
    if (typeof request === "object" && request !== null) {
      const prompt = (request as { readonly prompt?: unknown }).prompt;
      if (typeof prompt === "string") return prompt;
    }
    return JSON.stringify(request, null, 2);
  } catch {
    return requestJson;
  }
}

/**
 * Pending human decisions for one run.
 *
 * Approving here resumes the run through the runtime's durable approval record.
 * The single-use resume token that authorizes a decision is issued and spent on
 * the server, so this component never holds it.
 */
export function ApprovalCards({
  runId,
  active,
  describeOp,
}: {
  readonly runId: string;
  readonly active: boolean;
  readonly describeOp: (opIndex: number) => string;
}) {
  const [approvals, setApprovals] = useState<readonly ApprovalView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = (): void => {
      fetch(`/api/editor/approvals?runId=${encodeURIComponent(runId)}`, { cache: "no-store" })
        .then(async (response) => {
          const body = (await response.json()) as unknown;
          if (cancelled) return;
          if (response.ok) {
            const list =
              typeof body === "object" && body !== null && "approvals" in body
                ? (body as { readonly approvals: unknown }).approvals
                : [];
            setApprovals(
              Array.isArray(list) ? (list as readonly unknown[]).filter(isApproval) : [],
            );
          }
          timer = window.setTimeout(poll, POLL_MS);
        })
        .catch(() => {
          if (!cancelled) timer = window.setTimeout(poll, POLL_MS * 2);
        });
    };
    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runId, active]);

  const decide = async (approvalId: string, decision: "approved" | "rejected"): Promise<void> => {
    setBusy(approvalId);
    setMessage(null);
    try {
      const response = await fetch(`/api/editor/approvals/${encodeURIComponent(approvalId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        setMessage(reasonOf(body, "The decision could not be recorded."));
        return;
      }
      setApprovals((current) => current.filter((approval) => approval.approvalId !== approvalId));
      setMessage(decision === "approved" ? "Approved. The run continues." : "Rejected.");
    } catch {
      setMessage("The runtime daemon is not reachable.");
    } finally {
      setBusy(null);
    }
  };

  const pending = active ? approvals.filter((approval) => approval.status === "pending") : [];
  if (pending.length === 0 && message === null) return null;

  return (
    <section aria-label="Pending approvals">
      {pending.map((approval) => {
        const text = requestText(approval.requestJson);
        const where = describeOp(approval.opIndex);
        return (
          <div
            key={approval.approvalId}
            className="approvalCard"
            role="group"
            aria-label={`Approval at ${where}`}
          >
            <h2 className="approvalCard__title">Waiting for your decision</h2>
            <p className="small muted">
              At <code>{where}</code>
              {approval.expiresAtMs === null
                ? ""
                : ` · expires ${new Date(approval.expiresAtMs).toLocaleString()}`}
            </p>
            {text === null ? null : <pre className="codeBlock">{text}</pre>}
            <div className="btnRow">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy !== null}
                onClick={() => {
                  void decide(approval.approvalId, "approved");
                }}
              >
                {busy === approval.approvalId ? "Recording…" : "Approve"}
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={busy !== null}
                onClick={() => {
                  void decide(approval.approvalId, "rejected");
                }}
              >
                Reject
              </button>
            </div>
          </div>
        );
      })}
      {message === null ? null : (
        <p className="small" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
