"use client";

import { useEffect, useRef, useState } from "react";
import { workspaceRequest } from "../../lib/workspace-client";

interface ConnectionStatus {
  state: "disconnected" | "pending" | "connected" | "error";
  errorCode?: string;
  account?: { expiresAt?: number | string; scopes?: string[] };
}
interface LoginResponse {
  authorizationUrl: string;
  expiresAt: number | string;
  memoryOnly: boolean;
  callbackLocation: string;
}

export function ChatGPTConnection() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [consent, setConsent] = useState(false);
  const [login, setLogin] = useState<LoginResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const expected = requestVersion.current;
      const result = await workspaceRequest<ConnectionStatus>("auth/chatgpt");
      if (disposed) return;
      if (result.ok && expected === requestVersion.current) {
        setStatus(result.data);
        if (result.data.state !== "pending") setLogin(null);
      }
      timer = setTimeout(() => {
        void poll();
      }, 3000);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);

  async function start() {
    if (!consent) return;
    requestVersion.current++;
    setBusy(true);
    setError("");
    try {
      const result = await workspaceRequest<LoginResponse>("auth/chatgpt/login", {});
      requestVersion.current++;
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      if (!result.data.memoryOnly || result.data.callbackLocation !== "local-runtime-loopback") {
        setError("The provider returned an unsupported sign-in configuration.");
        return;
      }
      const target = new URL(result.data.authorizationUrl);
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        target.hostname !== "auth.openai.com"
      ) {
        setError("The provider returned an invalid authorization link.");
        return;
      }
      setLogin(result.data);
      setStatus({ state: "pending" });
    } catch {
      setError("The sign-in request could not be started.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="ChatGPT connection setup">
      <h2 className="panelTitle">ChatGPT account connection</h2>
      <p role="status">
        {status ? `Connection ${status.state}.` : "Checking account connection support…"}
      </p>
      <p className="muted">
        This is a separate account connection. Coding tasks continue through the harness. The
        requested provider permissions determine what this connection can access.
      </p>
      <p className="muted">
        Sign-in credentials are held only in runtime memory. The callback uses{" "}
        <code>127.0.0.1</code> on the runtime host. A browser on another machine needs a supported
        local companion or explicit loopback forwarding; this page does not replace the callback
        with a public URL.
      </p>
      <label>
        <input
          type="checkbox"
          checked={consent}
          disabled={busy || status?.state === "pending"}
          onChange={(event) => setConsent(event.target.checked)}
        />{" "}
        I authorize starting the official provider sign-in for this runtime session.
      </label>{" "}
      <button
        disabled={busy || !consent || status?.state === "pending" || status?.state === "connected"}
        onClick={() => {
          void start();
        }}
      >
        Start account sign-in
      </button>
      {login ? (
        <p>
          <a href={login.authorizationUrl} target="_blank" rel="noopener noreferrer">
            Complete official sign-in and consent
          </a>{" "}
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void workspaceRequest<ConnectionStatus>("auth/chatgpt/cancel", {})
                .then((result) => {
                  if (result.ok) {
                    setStatus(result.data);
                    setLogin(null);
                    setConsent(false);
                  } else setError(result.reason);
                })
                .finally(() => setBusy(false));
            }}
          >
            Cancel pending sign-in
          </button>
        </p>
      ) : null}
      {status?.errorCode ? <p role="alert">Provider connection error: {status.errorCode}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
