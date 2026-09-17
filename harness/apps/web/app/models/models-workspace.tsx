"use client";

import { useState, type FormEvent } from "react";

import {
  MODEL_PRESETS,
  MODEL_PROFILES,
  checkModelDraft,
  describeCheck,
  draftFor,
  draftForSignIn,
  draftFromModel,
  isModelView,
  suggestModelId,
  type ModelCredential,
  type ModelDraft,
  type ModelProfile,
  type ModelView,
} from "../../lib/model-form";
import {
  isConnectionView,
  modelIdFromOpenRouter,
  type ConnectionView,
  type OpenRouterModel,
} from "../../lib/sign-in";
import { reasonOf } from "../../lib/workspace-types";
import { SignInPanel } from "./sign-in-panel";

interface CheckState {
  readonly busy: boolean;
  readonly ok?: boolean;
  readonly text?: string;
}

async function send(
  url: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<{ readonly ok: boolean; readonly body: unknown; readonly reason: string }> {
  try {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      ...(method === "GET"
        ? {}
        : {
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    return {
      ok: response.ok,
      body: payload,
      reason: reasonOf(payload, `The request failed (${String(response.status)}).`),
    };
  } catch {
    return { ok: false, body: null, reason: "The runtime daemon is not reachable." };
  }
}

/** Which key a model uses, and whether it has one right now. */
function credentialBadge(
  model: ModelView,
  signedIn: boolean,
): { readonly text: string; readonly on: boolean } {
  switch (model.credential) {
    case "stored":
      return { text: "Key stored in this harness", on: true };
    case "environment":
      return { text: `Key read from $${model.credentialEnv ?? "?"}`, on: true };
    case "connection":
      return signedIn
        ? { text: "Uses your OpenRouter sign-in", on: true }
        : { text: "Needs the OpenRouter sign-in", on: false };
    case "none":
      return { text: "No key", on: false };
  }
}

type ConnectMode = "key" | "signin";

/**
 * The models this harness can call, and a person's hand on them.
 *
 * A key is typed once and never shown again: the runtime keeps it and answers with
 * which kind of credential a model uses, not its value. Every change is followed by
 * a check, because a wrong key or model name is far cheaper to find here than in
 * the middle of a run.
 */
export function ModelsWorkspace({
  initialModels,
  initialConnection,
  startWith,
}: {
  readonly initialModels: readonly ModelView[];
  readonly initialConnection: ConnectionView | null;
  /** Open the form on this way of connecting, as after returning from a sign-in. */
  readonly startWith: ConnectMode | null;
}) {
  const [models, setModels] = useState<readonly ModelView[]>(initialModels);
  const [connection, setConnection] = useState<ConnectionView | null>(initialConnection);
  const signInDraft = (): ModelDraft =>
    draftForSignIn(connection?.apiBaseUrl ?? MODEL_PRESETS.openrouter.baseUrl);
  const [draft, setDraft] = useState<ModelDraft | null>(() => {
    if (startWith === "signin") {
      return draftForSignIn(initialConnection?.apiBaseUrl ?? MODEL_PRESETS.openrouter.baseUrl);
    }
    return initialModels.length === 0 || startWith === "key" ? draftFor("ollama") : null;
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [idTouched, setIdTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Readonly<Record<string, CheckState>>>({});
  const [removing, setRemoving] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    const result = await send("/api/editor/models", "GET");
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    const listed =
      typeof result.body === "object" && result.body !== null && "models" in result.body
        ? (result.body as { readonly models: unknown }).models
        : [];
    setModels(Array.isArray(listed) ? listed.filter(isModelView) : []);
  };

  const refreshConnection = async (): Promise<void> => {
    const result = await send("/api/editor/workspace/connections", "GET");
    const listed =
      result.ok && typeof result.body === "object" && result.body !== null
        ? (result.body as { readonly connections?: unknown }).connections
        : undefined;
    const found = Array.isArray(listed)
      ? (listed as readonly unknown[]).find(isConnectionView)
      : undefined;
    if (found !== undefined) setConnection(found);
  };

  const check = async (modelId: string): Promise<void> => {
    setChecks((current) => ({ ...current, [modelId]: { busy: true } }));
    const result = await send(`/api/editor/models/${encodeURIComponent(modelId)}/check`, "POST");
    const answer = result.ok
      ? describeCheck((result.body as { readonly check?: unknown } | null)?.check)
      : { ok: false, text: result.reason };
    setChecks((current) => ({ ...current, [modelId]: { busy: false, ...answer } }));
  };

  const mode: ConnectMode = draft?.credential === "connection" ? "signin" : "key";

  const switchMode = (next: ConnectMode): void => {
    if (draft === null || next === mode) return;
    setError(null);
    // Model names differ between the two, so nothing typed carries over.
    setIdTouched(editing !== null);
    const fresh = next === "signin" ? signInDraft() : draftFor("openai");
    setDraft(editing === null ? fresh : { ...fresh, modelId: draft.modelId });
  };

  const pick = (model: OpenRouterModel): void => {
    field({
      model: model.id,
      title: model.name,
      contextWindowTokens: String(model.contextLength),
      tools: true,
      ...(idTouched ? {} : { modelId: modelIdFromOpenRouter(model.id) }),
    });
  };

  const choose = (profile: ModelProfile): void => {
    if (draft === null) return;
    const fresh = draftFor(profile);
    // Keep what was typed about the model itself; take the rest from the preset.
    setDraft({ ...fresh, model: draft.model, modelId: draft.modelId, title: draft.title });
  };

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (draft === null) return;
    const checked = checkModelDraft(draft, editing !== null);
    if (!checked.ok) {
      setError(checked.reason);
      return;
    }
    setError(null);
    setBusy(true);
    const result =
      editing === null
        ? await send("/api/editor/models", "POST", checked.request)
        : await send(`/api/editor/models/${encodeURIComponent(editing)}`, "PATCH", checked.request);
    setBusy(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    const savedId = String(checked.request["modelId"]);
    if (checked.request["credential"] === "connection" && connection !== null) {
      // The sign-in now has one more model depending on it.
      await refreshConnection();
    }
    setDraft(null);
    setEditing(null);
    setIdTouched(false);
    await reload();
    await check(savedId);
  };

  const remove = async (modelId: string): Promise<void> => {
    setBusy(true);
    const result = await send(`/api/editor/models/${encodeURIComponent(modelId)}`, "DELETE");
    setBusy(false);
    setRemoving(null);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    await reload();
    if (connection !== null) await refreshConnection();
  };

  const field = (patch: Partial<ModelDraft>): void => {
    if (draft !== null) setDraft({ ...draft, ...patch });
  };

  return (
    <>
      {error === null ? null : (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}

      {models.length === 0 ? null : (
        <div className="cards">
          {models.map((model) => {
            const state = checks[model.modelId];
            const badge = credentialBadge(model, connection?.connected === true);
            return (
              <article className="card" key={model.modelId} aria-label={`Model ${model.title}`}>
                <header className="cardHead">
                  <div>
                    <h2 className="cardTitle">{model.title}</h2>
                    <p className="cardMeta">
                      <code>{model.modelId}</code> · {MODEL_PRESETS[model.profile].label} ·{" "}
                      {model.model}
                    </p>
                  </div>
                  <div className="badges">
                    <span className={`badge badge--${badge.on ? "on" : "off"}`}>{badge.text}</span>
                    {model.tools ? <span className="badge badge--on">Calls tools</span> : null}
                  </div>
                </header>
                <p className="cardNodes muted">
                  <code>{model.baseUrl}</code>
                </p>

                {state === undefined || state.busy ? null : (
                  <p
                    className={state.ok === true ? "modelCheck modelCheck--ok" : "warn"}
                    role="status"
                  >
                    {state.text}
                  </p>
                )}

                {removing === model.modelId ? (
                  <div className="btnRow" role="group" aria-label={`Remove ${model.title}`}>
                    <span className="muted small">
                      Graphs that name this model will stop finding it
                      {model.credential === "stored" ? ", and its stored key is deleted" : ""}.
                    </span>
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={busy}
                      onClick={() => {
                        void remove(model.modelId);
                      }}
                    >
                      Remove it
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setRemoving(null);
                      }}
                    >
                      Keep it
                    </button>
                  </div>
                ) : (
                  <div className="btnRow">
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={state?.busy === true}
                      onClick={() => {
                        void check(model.modelId);
                      }}
                    >
                      {state?.busy === true ? "Checking…" : "Check"}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setError(null);
                        setEditing(model.modelId);
                        setIdTouched(true);
                        setDraft(draftFromModel(model));
                      }}
                    >
                      Edit…
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger"
                      onClick={() => {
                        setRemoving(model.modelId);
                      }}
                    >
                      Remove…
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {draft === null ? (
        <div className="btnRow modelAdd">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setError(null);
              setEditing(null);
              setIdTouched(false);
              setDraft(draftFor("ollama"));
            }}
          >
            Add a model
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setError(null);
              setEditing(null);
              setIdTouched(false);
              setDraft(signInDraft());
            }}
          >
            {connection?.connected === true ? "Add an OpenRouter model" : "Sign in with OpenRouter"}
          </button>
        </div>
      ) : (
        <section
          className="panel modelForm"
          aria-label={editing === null ? "Add a model" : "Edit model"}
        >
          <h2 className="panelTitle">{editing === null ? "Add a model" : `Edit ${editing}`}</h2>

          <form
            onSubmit={(event) => {
              void save(event);
            }}
          >
            <div className="btnRow modelMode" role="group" aria-label="How to connect">
              {(
                [
                  ["key", "API key"],
                  ["signin", "Sign in (OAuth)"],
                ] as const satisfies readonly (readonly [ConnectMode, string])[]
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`btn${mode === value ? " btn--primary" : ""}`}
                  aria-pressed={mode === value}
                  onClick={() => {
                    switchMode(value);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === "signin" ? (
              <SignInPanel
                connection={connection}
                onConnection={setConnection}
                picked={draft.model}
                onPick={pick}
              />
            ) : (
              <>
                <div className="btnRow" role="group" aria-label="Kind of endpoint">
                  {MODEL_PROFILES.map((profile) => (
                    <button
                      key={profile}
                      type="button"
                      className={`btn${draft.profile === profile ? " btn--primary" : ""}`}
                      aria-pressed={draft.profile === profile}
                      onClick={() => {
                        choose(profile);
                      }}
                    >
                      {MODEL_PRESETS[profile].label}
                    </button>
                  ))}
                </div>
                <p className="muted small">{MODEL_PRESETS[draft.profile].hint}</p>
              </>
            )}

            {mode === "signin" && connection?.connected !== true ? null : (
              <>
                <label className="field">
                  <span className="field__label">Model name</span>
                  <input
                    className="field__input"
                    value={draft.model}
                    maxLength={200}
                    placeholder={MODEL_PRESETS[draft.profile].modelPlaceholder}
                    onChange={(event) => {
                      const model = event.target.value;
                      field({ model, ...(idTouched ? {} : { modelId: suggestModelId(model) }) });
                    }}
                  />
                  <span className="field__hint">Exactly as the endpoint names it.</span>
                </label>

                <label className="field">
                  <span className="field__label">Id in this harness</span>
                  <input
                    className="field__input"
                    value={draft.modelId}
                    maxLength={64}
                    disabled={editing !== null}
                    onChange={(event) => {
                      setIdTouched(true);
                      field({ modelId: event.target.value });
                    }}
                  />
                  <span className="field__hint">
                    An agent step can name it in its Model id setting; otherwise it picks any model
                    that can do the job.
                  </span>
                </label>

                <label className="field">
                  <span className="field__label">Display name</span>
                  <input
                    className="field__input"
                    value={draft.title}
                    maxLength={120}
                    placeholder="Optional"
                    onChange={(event) => {
                      field({ title: event.target.value });
                    }}
                  />
                </label>

                {mode === "signin" ? (
                  <p className="muted small">
                    Calls <code>{draft.baseUrl}</code> with your OpenRouter sign-in.
                  </p>
                ) : (
                  <label className="field">
                    <span className="field__label">Endpoint</span>
                    <input
                      className="field__input"
                      value={draft.baseUrl}
                      maxLength={2048}
                      onChange={(event) => {
                        field({ baseUrl: event.target.value });
                      }}
                    />
                    <span className="field__hint">
                      Where the API starts, usually ending in /v1.
                    </span>
                  </label>
                )}

                {mode === "signin" ? null : (
                  <fieldset className="field modelKey">
                    <legend className="field__label">Key</legend>
                    {(
                      [
                        ["stored", "Store a key in this harness"],
                        ["environment", "Read it from an environment variable"],
                        ["none", "No key"],
                      ] as const satisfies readonly (readonly [ModelCredential, string])[]
                    ).map(([credential, label]) => (
                      <label className="field__check" key={credential}>
                        <input
                          type="radio"
                          name="credential"
                          checked={draft.credential === credential}
                          onChange={() => {
                            field({ credential });
                          }}
                        />
                        {label}
                      </label>
                    ))}
                    {draft.credential === "stored" ? (
                      <>
                        <input
                          className="field__input"
                          type="password"
                          autoComplete="off"
                          value={draft.apiKey}
                          maxLength={4096}
                          aria-label="API key"
                          placeholder={
                            editing === null
                              ? "Paste the API key"
                              : "Leave empty to keep the stored key"
                          }
                          onChange={(event) => {
                            field({ apiKey: event.target.value });
                          }}
                        />
                        <span className="field__hint">
                          Kept in this harness&apos;s database on this machine and never shown
                          again. It is sent only to this endpoint, and is removed from anything the
                          harness records.
                        </span>
                      </>
                    ) : null}
                    {draft.credential === "environment" ? (
                      <>
                        <input
                          className="field__input"
                          value={draft.credentialEnv}
                          maxLength={128}
                          aria-label="Environment variable"
                          placeholder="OPENAI_API_KEY"
                          onChange={(event) => {
                            field({ credentialEnv: event.target.value });
                          }}
                        />
                        <span className="field__hint">
                          Read when a request is made, so the key never enters the database. Set it
                          before starting the runtime.
                        </span>
                      </>
                    ) : null}
                  </fieldset>
                )}

                <label className="field">
                  <span className="field__label">Context window (tokens)</span>
                  <input
                    className="field__input"
                    inputMode="numeric"
                    value={draft.contextWindowTokens}
                    maxLength={9}
                    onChange={(event) => {
                      field({ contextWindowTokens: event.target.value });
                    }}
                  />
                </label>

                <label className="field__check">
                  <input
                    type="checkbox"
                    checked={draft.tools}
                    onChange={(event) => {
                      field({ tools: event.target.checked });
                    }}
                  />
                  This model can call tools
                </label>
                <p className="muted small">
                  Agent steps offer goal, todo and memory actions, so they only pick a model that
                  can.
                </p>
              </>
            )}

            <div className="btnRow">
              {mode === "signin" && connection?.connected !== true ? null : (
                <button className="btn btn--primary" type="submit" disabled={busy}>
                  {busy ? "Saving…" : editing === null ? "Save and check" : "Save changes"}
                </button>
              )}
              {models.length === 0 && editing === null ? null : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setDraft(null);
                    setEditing(null);
                    setError(null);
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </section>
      )}
    </>
  );
}
