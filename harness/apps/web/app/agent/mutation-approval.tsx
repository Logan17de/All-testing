"use client";

import { useState } from "react";
import type { MutationApproval } from "./agent-view";

export function MutationApprovalCard({
  request,
  respond,
}: {
  request: MutationApproval;
  respond: (decision: "approved" | "rejected") => Promise<void>;
}) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answered, setAnswered] = useState(false);
  async function decide(decision: "approved" | "rejected") {
    if (busy || answered || (decision === "approved" && !consent)) return;
    setBusy(true);
    setError("");
    try {
      await respond(decision);
      setAnswered(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The decision could not be recorded.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-label="Workspace mutation approval">
      <h3>Approve a workspace action</h3>
      <p>
        Session <code>{request.sessionId}</code>, run <code>{request.runId}</code>.
      </p>
      <p>
        Tool: <code>{request.tool}</code>. Request expires at{" "}
        {new Date(request.expiresAtMs).toLocaleString()}.
      </p>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {JSON.stringify(request.args, null, 2)}
      </pre>
      <label>
        <input
          type="checkbox"
          checked={consent}
          disabled={busy || answered}
          onChange={(event) => setConsent(event.target.checked)}
        />{" "}
        I approve exactly this tool and these arguments once.
      </label>{" "}
      <button
        disabled={busy || answered || !consent}
        onClick={() => {
          void decide("approved");
        }}
      >
        Approve once
      </button>{" "}
      <button
        disabled={busy || answered}
        onClick={() => {
          void decide("rejected");
        }}
      >
        Deny action
      </button>
      {answered ? <p role="status">Decision recorded.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
