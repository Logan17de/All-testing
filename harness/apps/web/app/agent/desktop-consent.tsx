"use client";
import { useState } from "react";
import type { DesktopConsent } from "./desktop-view";

export function DesktopConsentCard({
  request,
  respond,
}: {
  request: DesktopConsent;
  respond: (decision: "approved" | "rejected") => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState("");
  async function decide(decision: "approved" | "rejected") {
    if (busy || answered || (decision === "approved" && !confirmed)) return;
    setBusy(true);
    setError("");
    try {
      await respond(decision);
      setAnswered(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Desktop consent was refused.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-label="Exact desktop consent">
      <h3>
        {request.purpose === "input"
          ? "Confirm one desktop input"
          : "Confirm one screenshot transmission authorization"}
      </h3>
      <p>
        Task: <code>{request.task}</code>. Session generation: {request.generation}.
      </p>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {JSON.stringify(
          request.purpose === "input"
            ? request.action
            : {
                artifactId: request.artifactId,
                transmission: "consent only; no automatic provider transfer",
              },
          null,
          2,
        )}
      </pre>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy || answered}
          onChange={(event) => setConfirmed(event.target.checked)}
        />{" "}
        I approve exactly this displayed request once.
      </label>{" "}
      <button
        disabled={busy || answered || !confirmed}
        onClick={() => {
          void decide("approved");
        }}
      >
        Approve desktop request once
      </button>{" "}
      <button
        disabled={busy || answered}
        onClick={() => {
          void decide("rejected");
        }}
      >
        Deny desktop request
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
