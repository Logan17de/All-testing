"use client";

import { useEffect, useState } from "react";

import {
  MODEL_MAKERS,
  filterModels,
  isConnectionView,
  isOpenRouterModel,
  signInReturnUrl,
  type ConnectionView,
  type ModelMaker,
  type OpenRouterModel,
} from "../../lib/sign-in";
import { workspaceRequest } from "../../lib/workspace-client";

const SHOWN_MODELS = 50;

/**
 * Signing in to OpenRouter, and picking one of its models.
 *
 * The sign-in happens on OpenRouter's own site; this panel only starts it and
 * shows where it stands. The key OpenRouter issues stays in the runtime.
 */
export function SignInPanel({
  connection,
  onConnection,
  picked,
  onPick,
}: {
  readonly connection: ConnectionView | null;
  readonly onConnection: (connection: ConnectionView) => void;
  readonly picked: string;
  readonly onPick: (model: OpenRouterModel) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [models, setModels] = useState<readonly OpenRouterModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [maker, setMaker] = useState<ModelMaker>("");

  const connected = connection?.connected === true;

  useEffect(() => {
    if (!connected) return;
    let live = true;
    void workspaceRequest<{ readonly models?: unknown }>("connections/openrouter/models").then(
      (result) => {
        if (!live) return;
        if (!result.ok) {
          setModelsError(result.reason);
          return;
        }
        const listed = result.data.models;
        setModelsError(null);
        setModels(Array.isArray(listed) ? listed.filter(isOpenRouterModel) : []);
      },
    );
    return () => {
      live = false;
    };
  }, [connected]);

  const signIn = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await workspaceRequest<{ readonly authorizeUrl?: unknown }>(
      "connections/openrouter/start",
      { callbackUrl: signInReturnUrl(window.location.origin) },
    );
    const target = result.ok ? result.data.authorizeUrl : undefined;
    if (typeof target !== "string" || !/^https?:\/\//u.test(target)) {
      setBusy(false);
      setError(result.ok ? "The runtime did not say where to sign in." : result.reason);
      return;
    }
    window.location.assign(target);
  };

  const signOut = async (): Promise<void> => {
    setBusy(true);
    const result = await workspaceRequest<{ readonly connection?: unknown }>(
      "connections/openrouter/sign-out",
      {},
    );
    setBusy(false);
    setConfirmSignOut(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setModels(null);
    if (isConnectionView(result.data.connection)) onConnection(result.data.connection);
  };

  const matching =
    models === null ? [] : filterModels(models, query, maker, Number.MAX_SAFE_INTEGER);
  const shown = matching.slice(0, SHOWN_MODELS);

  return (
    <div className="signIn">
      <p className="muted small">
        OpenAI (Codex), Anthropic (Claude Code), Google (Gemini CLI) and xAI (Grok) keep their
        sign-ins for their own apps, so here they connect with an API key. OpenRouter lets you sign
        in instead: one sign-in reaches GPT, Claude, Gemini, Grok and many more, billed to your
        OpenRouter account.
      </p>

      {error === null ? null : (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}

      {connection === null ? (
        <p className="warn">The runtime did not say whether you are signed in. Is it running?</p>
      ) : !connected ? (
        <>
          <div className="btnRow">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => {
                void signIn();
              }}
            >
              {busy ? "Opening OpenRouter…" : "Sign in with OpenRouter"}
            </button>
          </div>
          <p className="field__hint">
            You approve this app on openrouter.ai and come straight back here. The key OpenRouter
            issues is kept in this harness&apos;s database on this machine and never shown.
          </p>
        </>
      ) : (
        <>
          <div className="signIn__status">
            <span className="badge badge--on">Signed in to OpenRouter</span>
            {connection.connectedAtMs === null ? null : (
              <span className="muted small">
                since {new Date(connection.connectedAtMs).toISOString().slice(0, 10)}
              </span>
            )}
            {confirmSignOut ? null : (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setConfirmSignOut(true);
                }}
              >
                Sign out…
              </button>
            )}
          </div>

          {confirmSignOut ? (
            <div className="btnRow" role="group" aria-label="Sign out of OpenRouter">
              <span className="muted small">
                {connection.models === 0
                  ? "No model uses this sign-in yet."
                  : `${String(connection.models)} ${connection.models === 1 ? "model uses" : "models use"} this sign-in and will stop answering until you sign in again.`}{" "}
                The key stays on your OpenRouter account until you delete it there.
              </span>
              <button
                type="button"
                className="btn btn--danger"
                disabled={busy}
                onClick={() => {
                  void signOut();
                }}
              >
                Sign out
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setConfirmSignOut(false);
                }}
              >
                Stay signed in
              </button>
            </div>
          ) : null}

          <div className="folderPicker" role="group" aria-label="OpenRouter models">
            <input
              className="field__input"
              type="search"
              value={query}
              maxLength={100}
              aria-label="Search OpenRouter models"
              placeholder="Search models, such as sonnet, gemini or grok"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
            <div className="btnRow" role="group" aria-label="Model maker">
              {MODEL_MAKERS.map((entry) => (
                <button
                  key={entry.label}
                  type="button"
                  className={`btn${maker === entry.prefix ? " btn--primary" : ""}`}
                  aria-pressed={maker === entry.prefix}
                  onClick={() => {
                    setMaker(entry.prefix);
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            {modelsError !== null ? (
              <p className="warn">{modelsError}</p>
            ) : models === null ? (
              <p className="muted small">Loading OpenRouter&apos;s models…</p>
            ) : shown.length === 0 ? (
              <p className="muted small">No model that can call tools matches.</p>
            ) : (
              <ul className="folderPicker__list">
                {shown.map((model) => (
                  <li key={model.id}>
                    <button
                      type="button"
                      className={`folderPicker__item${picked === model.id ? " folderPicker__item--picked" : ""}`}
                      aria-pressed={picked === model.id}
                      onClick={() => {
                        onPick(model);
                      }}
                    >
                      {model.name} <code className="muted small">{model.id}</code>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <span className="field__hint">
              Only models that can call tools are listed, because agent steps use tools.
              {matching.length > shown.length
                ? ` Showing ${String(shown.length)} of ${String(matching.length)}; search to narrow it.`
                : ""}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
