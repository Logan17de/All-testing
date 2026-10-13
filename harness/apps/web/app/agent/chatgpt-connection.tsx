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
  const [reconnecting, setReconnecting] = useState(false);
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
    if (!consent || busy || !status || status.state === "pending") return;
    if (status.state === "connected" && !reconnecting) return;
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
      setConsent(false);
      setReconnecting(false);
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
        {status?.state === "connected"
          ? "ChatGPT connected. Choose an account model in Coding."
          : status?.state === "pending"
            ? "Waiting for you to complete sign-in."
            : status?.state === "error"
              ? "ChatGPT connection needs attention. Check the status or sign in again."
              : status?.state === "disconnected"
                ? "ChatGPT is not connected. Sign in to use your account models."
                : "Checking ChatGPT connection."}
      </p>
      <p className="muted">
        The connection lasts for this runtime session. Restarting the runtime requires sign-in
        again.
      </p>
      <div className="buttonRow">
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            const expected = ++requestVersion.current;
            setBusy(true);
            setError("");
            void workspaceRequest<ConnectionStatus>("auth/chatgpt")
              .then((result) => {
                if (expected !== requestVersion.current) return;
                if (result.ok) {
                  setStatus(result.data);
                  if (result.data.state !== "pending") setLogin(null);
                } else setError(result.reason);
              })
              .finally(() => setBusy(false));
          }}
        >
          Check connection status
        </button>
        {status?.state === "connected" && !reconnecting ? (
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setConsent(false);
              setReconnecting(true);
            }}
          >
            Reconnect account
          </button>
        ) : null}
      </div>
      {status && status.state !== "pending" && (status.state !== "connected" || reconnecting) ? (
        <>
          <p className="muted">
            Complete sign-in in a browser on the runtime host. Remote browsers need a supported
            local companion or explicit loopback forwarding.
          </p>
          <label>
            <input
              type="checkbox"
              checked={consent}
              disabled={busy}
              onChange={(event) => setConsent(event.target.checked)}
            />{" "}
            I authorize starting the official provider sign-in for this runtime session.
          </label>{" "}
          <button
            className="btn"
            disabled={busy || !consent}
            onClick={() => {
              void start();
            }}
          >
            {reconnecting ? "Start account reconnection" : "Start account sign-in"}
          </button>
          {reconnecting ? (
            <button
              className="btn"
              disabled={busy}
              onClick={() => {
                setReconnecting(false);
                setConsent(false);
              }}
            >
              Keep current connection
            </button>
          ) : null}
        </>
      ) : null}
      {login ? (
        <p>
          <a href={login.authorizationUrl} target="_blank" rel="noopener noreferrer">
            Complete official sign-in and consent
          </a>{" "}
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              requestVersion.current++;
              setBusy(true);
              void workspaceRequest<ConnectionStatus>("auth/chatgpt/cancel", {})
                .then((result) => {
                  requestVersion.current++;
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
