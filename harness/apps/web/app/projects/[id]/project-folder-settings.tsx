"use client";
import { useState } from "react";
import { FolderPicker } from "../../setup/folder-picker";
import { workspaceRequest } from "../../../lib/workspace-client";
export function ProjectFolderSettings({
  projectId,
  workspacePath,
  archived,
}: {
  projectId: string;
  workspacePath: string | null;
  archived: boolean;
}) {
  const [path, setPath] = useState(workspacePath);
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function trust() {
    if (!selected) return;
    setBusy(true);
    setError("");
    const result = await workspaceRequest<{ project: { workspacePath: string | null } }>(
      `projects/${projectId}`,
      { workspacePath: selected, trusted: true },
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setPath(result.data.project.workspacePath);
    setSelected(null);
    setChoosing(false);
    setSaved(true);
  }
  return (
    <section id="project-folder" className="panel" aria-label="Project folder settings">
      <h2 className="panelTitle">Project folder</h2>
      <p>{path ? <code>{path}</code> : "No folder selected."}</p>
      <p className="muted small">
        Chats created with this project’s sidebar pencil use its trusted folder. The project name is
        a display name; this does not rename the PC folder.
      </p>
      {!archived ? (
        selected ? (
          <section aria-label="Trust project folder">
            <h3>Trust this folder?</h3>
            <p>
              <code>{selected}</code>
            </p>
            <p className="muted">
              Trust only files and instructions you recognize. Existing action approvals still
              apply.
            </p>
            <div className="btnRow">
              <button
                className="btn btn--primary"
                type="button"
                disabled={busy}
                onClick={() => {
                  void trust();
                }}
              >
                {busy ? "Saving…" : "Trust and use for this project"}
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => setSelected(null)}
              >
                Cancel
              </button>
            </div>
          </section>
        ) : choosing ? (
          <FolderPicker
            initialPath={path ?? ""}
            busy={busy}
            onChoose={setSelected}
            onCancel={() => setChoosing(false)}
          />
        ) : (
          <div className="btnRow">
            {path ? (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setSaved(false);
                  setSelected(path);
                }}
              >
                Review folder trust
              </button>
            ) : null}
            <button
              className="btn"
              type="button"
              onClick={() => {
                setSaved(false);
                setChoosing(true);
              }}
            >
              Choose folder
            </button>
          </div>
        )
      ) : (
        <p className="muted small">Archived projects keep their folder but cannot change it.</p>
      )}
      {saved ? <p role="status">Project folder trusted and saved.</p> : null}
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
