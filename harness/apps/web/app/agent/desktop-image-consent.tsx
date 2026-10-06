"use client";
import Image from "next/image";
import { useState } from "react";
import type { DesktopImageConsent } from "./desktop-image-consent-view";
export function DesktopImageConsentCard({
  request,
  scope,
  taskExpiresAt,
  respond,
}: {
  request: DesktopImageConsent;
  scope: string;
  taskExpiresAt?: number;
  respond: (decision: "approved" | "rejected") => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState("");
  async function decide(decision: "approved" | "rejected") {
    if (
      busy ||
      answered ||
      (decision === "approved" && (!confirmed || !request.destination || request.blockedReason))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await respond(decision);
      setAnswered(true);
    } catch {
      setError("The screenshot decision was refused. The request may have expired.");
    } finally {
      setBusy(false);
    }
  }
  const destination = request.destination;
  return (
    <section
      className="card"
      aria-label="Exact screenshot transmission consent"
      style={{ overflowWrap: "anywhere", minWidth: 0 }}
    >
      <h3>Share this screenshot with one current turn</h3>
      <p>
        Desktop task: <code>{request.task}</code>. Generation: {request.generation}.
      </p>
      <p>{scope}</p>
      <p>
        Exact screenshot: <code>{request.artifactId}</code>.
      </p>
      <Image
        src={`/api/editor/desktop/artifacts/${encodeURIComponent(request.artifactId)}?generation=${request.generation}`}
        alt="Exact local screenshot awaiting sharing approval"
        width={1024}
        height={768}
        unoptimized
        style={{ width: "100%", height: "auto" }}
      />
      <p className="muted">
        Local preview of this exact requested screenshot. Loading this preview does not transmit it
        to a model.
      </p>
      {destination ? (
        <>
          <dl>
            <dt>Destination model</dt>
            <dd>
              <code>{destination.modelId}</code>
            </dd>
            <dt>Chat session</dt>
            <dd>
              <code>{destination.sessionId}</code>
            </dd>
            <dt>Current turn</dt>
            <dd>
              <code>{destination.runId}</code>
            </dd>
            <dt>Account binding</dt>
            <dd>
              {destination.accountId ? (
                <code>{destination.accountId}</code>
              ) : (
                "No account identity supplied; bound to the configured model."
              )}
            </dd>
            <dt>Maximum model uses in this turn</dt>
            <dd>{destination.maxUses}</dd>
            <dt>Expires by</dt>
            <dd>
              {destination.expiresAtMs || taskExpiresAt
                ? new Date(destination.expiresAtMs ?? taskExpiresAt!).toLocaleString()
                : "Desktop task expiry"}
              ; earlier when this turn ends, desktop stops, or workspace changes.
            </dd>
          </dl>
          <p>
            Approval permits sending these pixels to this destination for the bounded current turn.
            Images stay in ephemeral runtime memory and are not automatically attached to later chat
            history or future turns.
          </p>
        </>
      ) : null}
      {request.blockedReason ? <p role="alert">{request.blockedReason}</p> : null}
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy || answered || Boolean(request.blockedReason) || !destination}
          onChange={(event) => setConfirmed(event.target.checked)}
        />{" "}
        I approve this screenshot, displayed destination, and current-turn reuse limit.
      </label>{" "}
      <button
        disabled={busy || answered || !confirmed || !destination || Boolean(request.blockedReason)}
        onClick={() => {
          void decide("approved");
        }}
      >
        Approve screenshot sharing once
      </button>{" "}
      <button
        disabled={busy || answered}
        onClick={() => {
          void decide("rejected");
        }}
      >
        Reject screenshot sharing
      </button>
      {answered ? <p role="status">Decision recorded.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
