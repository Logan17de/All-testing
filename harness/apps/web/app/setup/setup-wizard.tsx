"use client";
import Link from "next/link";
import { useState } from "react";
import type { SetupStatus } from "../../lib/runtime-client";
import { workspaceRequest } from "../../lib/workspace-client";
import { FolderPicker } from "./folder-picker";
export function SetupWizard({ initial }: { readonly initial: SetupStatus }) {
  const [status, setStatus] = useState(initial);
  const [changing, setChanging] = useState(
    initial.workspace === null || !initial.workspace.exists || initial.workspace.trusted !== true,
  );
  const [selected, setSelected] = useState<string | null>(
    initial.workspace?.exists && initial.workspace.trusted !== true ? initial.workspace.path : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspace = status.workspace;
  async function choose(path: string) {
    setBusy(true);
    setError(null);
    const saved = await workspaceRequest<{ workspace: SetupStatus["workspace"] }>(
      "setup/workspace",
      { path, trusted: true },
    );
    if (!saved.ok) {
      setBusy(false);
      setError(saved.reason);
      return;
    }
    const refreshed = await workspaceRequest<{ setup: SetupStatus }>("setup");
    setBusy(false);
    if (refreshed.ok) setStatus(refreshed.data.setup);
    else setStatus({ ...status, workspace: saved.data.workspace });
    setSelected(null);
    setChanging(false);
  }
  return (
    <>
      <section className="panel setupStep" aria-label="Default folder">
        <p className="eyebrow">Step 1</p>
        <h2 className="panelTitle">Default folder</h2>
        <p className="muted">
          New chat uses this folder by default. Projects can choose their own folder. Selecting it
          does not rename or move anything.
        </p>
        {!changing && workspace ? (
          <>
            <p className="setupChosen">
              <code>{workspace.path}</code>
            </p>
            <button className="btn" type="button" onClick={() => setChanging(true)}>
              Change default folder
            </button>
          </>
        ) : selected ? (
          <section aria-label="Trust default folder">
            <h3>Trust this folder?</h3>
            <p>
              <code>{selected}</code>
            </p>
            <p className="muted">
              Trust only a folder whose files and instructions you recognize. File changes and other
              protected actions still require their existing approvals.
            </p>
            <div className="btnRow">
              <button
                className="btn btn--primary"
                type="button"
                disabled={busy}
                onClick={() => {
                  void choose(selected);
                }}
              >
                {busy ? "Saving…" : "Trust and use as default"}
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => setSelected(null)}
              >
                Choose another folder
              </button>
            </div>
          </section>
        ) : (
          <FolderPicker
            initialPath={workspace?.path ?? ""}
            busy={busy}
            onChoose={setSelected}
            onCancel={workspace?.exists ? () => setChanging(false) : undefined}
          />
        )}
        {error ? (
          <p role="alert" className="field__error">
            {error}
          </p>
        ) : null}
      </section>
      <section
        className={`panel setupStep${workspace === null ? " setupStep--waiting" : ""}`}
        aria-label="Model"
      >
        <p className="eyebrow">Step 2</p>
        <h2 className="panelTitle">Connect a model</h2>
        {status.modelsConfigured > 0 ? (
          <p className="setupChosen">
            <span className="statusDot statusDot--on" aria-hidden="true" />
            {status.modelsConfigured === 1
              ? "1 model is connected."
              : `${String(status.modelsConfigured)} models are connected.`}
          </p>
        ) : (
          <p className="muted">
            Agents need a model to answer: a local server such as Ollama, or a hosted API with its
            key.
          </p>
        )}
        <div className="btnRow">
          <Link
            className={`btn${status.modelsConfigured > 0 ? "" : " btn--primary"}`}
            href="/models"
          >
            {status.modelsConfigured > 0 ? "Manage models" : "Connect a model"}
          </Link>
        </div>
      </section>

      <section
        className={`panel setupStep${status.complete ? "" : " setupStep--waiting"}`}
        aria-label="Start"
      >
        <p className="eyebrow">Step 3</p>
        <h2 className="panelTitle">Start</h2>
        <p className="muted">
          Create a project, open a conversation in it, and choose who answers — a plain chat, or a
          chat that can read GitHub.
        </p>
        <div className="btnRow">
          {status.complete ? (
            <Link className="btn btn--primary" href="/projects">
              Go to projects
            </Link>
          ) : (
            <span className="muted small">Choose a workspace first.</span>
          )}
        </div>
      </section>
    </>
  );
}
