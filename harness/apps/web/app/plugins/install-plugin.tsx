"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  EMPTY_INSTALL_DRAFT,
  checkInstallDraft,
  installedFrom,
  type PluginInstallDraft,
  type InstalledPluginSummary,
} from "../../lib/plugin-install-form";
import { reasonOf } from "../../lib/workspace-types";

/**
 * Adding a plugin from the app.
 *
 * Installing is not enabling. The package is fetched with no shell and no install
 * hooks, checked by the same discovery the loader uses at startup, and left disabled
 * with nothing granted — so this form can be used without deciding anything about
 * trust yet. That decision is `plugins.json`, and it is deliberately not an HTTP call.
 */
export function InstallPlugin({
  npm,
  git,
  directory,
}: {
  readonly npm: boolean;
  readonly git: boolean;
  readonly directory: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<PluginInstallDraft>({
    ...EMPTY_INSTALL_DRAFT,
    kind: npm ? "npm" : "git",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<InstalledPluginSummary | null>(null);

  const install = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setInstalled(null);
    const checked = checkInstallDraft(draft);
    if (!checked.ok) {
      setError(checked.reason);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/editor/plugins/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checked.request),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        setError(reasonOf(body, "The plugin was not installed."));
        return;
      }
      setInstalled(installedFrom(body));
      setDraft({ ...EMPTY_INSTALL_DRAFT, kind: draft.kind });
      // What is installed is re-read by the runtime straight away.
      router.refresh();
    } catch {
      setError("The runtime daemon is not reachable.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-label="Add a plugin">
      <h2 className="panelTitle">Add a plugin</h2>
      <p className="muted small">
        The package is fetched with no shell and no install hooks, read by the same checks the
        loader uses at startup, and written into <code>{directory}</code>. It arrives{" "}
        <strong>disabled</strong>, with nothing granted: enabling it and granting what it asks for
        stay decisions you make in <code>plugins.json</code>.
      </p>

      <form
        onSubmit={(event) => {
          void install(event);
        }}
      >
        {npm && git ? (
          <div className="btnRow" role="group" aria-label="Where to install from">
            <button
              type="button"
              className={`btn${draft.kind === "npm" ? " btn--primary" : ""}`}
              onClick={() => {
                setDraft({ ...draft, kind: "npm" });
              }}
            >
              From npm
            </button>
            <button
              type="button"
              className={`btn${draft.kind === "git" ? " btn--primary" : ""}`}
              onClick={() => {
                setDraft({ ...draft, kind: "git" });
              }}
            >
              From a Git repository
            </button>
          </div>
        ) : null}

        {draft.kind === "npm" ? (
          <label className="field">
            <span className="field__label">npm package</span>
            <input
              className="field__input"
              value={draft.spec}
              maxLength={214}
              placeholder="zet-plugin-hello or @acme/nodes@1.2.3"
              onChange={(event) => {
                setDraft({ ...draft, spec: event.target.value });
              }}
            />
          </label>
        ) : (
          <>
            <label className="field">
              <span className="field__label">Repository URL</span>
              <input
                className="field__input"
                value={draft.url}
                maxLength={500}
                placeholder="https://example.com/acme/zet-nodes.git"
                onChange={(event) => {
                  setDraft({ ...draft, url: event.target.value });
                }}
              />
              <span className="field__hint">
                Only https, and without credentials: no ssh key or agent is involved.
              </span>
            </label>
            <label className="field">
              <span className="field__label">Branch, tag or commit</span>
              <input
                className="field__input"
                value={draft.ref}
                maxLength={200}
                placeholder="Optional; the repository's default otherwise"
                onChange={(event) => {
                  setDraft({ ...draft, ref: event.target.value });
                }}
              />
            </label>
          </>
        )}

        <div className="btnRow">
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? "Installing…" : "Install"}
          </button>
        </div>
      </form>

      {error === null ? null : (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      {installed === null ? null : (
        <p role="status">
          Installed <strong>{installed.name}</strong>
          {installed.version.length > 0 ? ` v${installed.version}` : ""} as{" "}
          <code>{installed.id}</code>. It is disabled until you enable it, and it runs from the next
          start of the runtime.
        </p>
      )}
    </section>
  );
}
