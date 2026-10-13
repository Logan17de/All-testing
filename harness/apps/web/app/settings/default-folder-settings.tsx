"use client";
import { useState } from "react";
import type { SetupStatus } from "../../lib/runtime-client";
import { workspaceRequest } from "../../lib/workspace-client";
import { FolderPicker } from "../setup/folder-picker";

export function DefaultFolderSettings({
  initial,
  presentation = "panel",
}: {
  readonly initial: SetupStatus;
  readonly presentation?: "panel" | "row";
}) {
  const [status, setStatus] = useState(initial);
  const [changing, setChanging] = useState(
    presentation === "panel" &&
      (initial.workspace === null ||
        !initial.workspace.exists ||
        initial.workspace.trusted !== true),
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
  function openPicker() {
    setSelected(workspace?.exists && workspace.trusted !== true ? workspace.path : null);
    setError(null);
    setChanging(true);
  }
  const picker = selected ? (
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
        <button className="btn" type="button" disabled={busy} onClick={() => setSelected(null)}>
          Choose another folder
        </button>
        {presentation === "row" ? (
          <button className="btn" type="button" disabled={busy} onClick={() => setChanging(false)}>
            Cancel
          </button>
        ) : null}
      </div>
    </section>
  ) : (
    <FolderPicker
      initialPath={workspace?.path ?? ""}
      busy={busy}
      onChoose={setSelected}
      onCancel={presentation === "row" || workspace?.exists ? () => setChanging(false) : undefined}
    />
  );
  const errorMessage = error ? (
    <p role="alert" className="field__error">
      {error}
    </p>
  ) : null;
  if (presentation === "row")
    return (
      <div className="generalFolder">
        <div className="generalRow">
          <div className="generalRowText">
            <strong>Default task folder</strong>
            <p>Where new chats work by default. Projects can use their own folder.</p>
            {workspace && (!workspace.exists || workspace.trusted !== true) ? (
              <p className="generalFolderAttention">
                {workspace.exists
                  ? "This folder needs your trust before use."
                  : "This folder is no longer available."}
              </p>
            ) : null}
          </div>
          <div className="generalRowControl generalFolderControl">
            <span className="generalFolderPath" title={workspace?.path}>
              {workspace?.path || "Not set"}
            </span>
            <button
              className="generalButton"
              type="button"
              disabled={busy}
              aria-expanded={changing}
              aria-controls="general-folder-picker"
              aria-label={
                !workspace?.exists
                  ? "Choose default folder"
                  : workspace.trusted
                    ? "Change default folder"
                    : "Review default folder"
              }
              onClick={openPicker}
            >
              {!workspace?.exists ? "Choose" : workspace.trusted ? "Change" : "Review"}
            </button>
          </div>
        </div>
        {changing ? (
          <div id="general-folder-picker" className="generalFolderDetails">
            {picker}
          </div>
        ) : null}
        {errorMessage}
      </div>
    );
  return (
    <div>
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
            <button className="btn" type="button" onClick={openPicker}>
              Change default folder
            </button>
          </>
        ) : (
          picker
        )}
        {errorMessage}
      </section>
    </div>
  );
}
