"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

import type { SetupStatus } from "../../lib/runtime-client";
import { workspaceRequest } from "../../lib/workspace-client";

interface FolderListing {
  readonly path: string;
  readonly parent: string | null;
  readonly home: string;
  readonly roots: readonly string[];
  readonly folders: readonly { readonly name: string; readonly path: string }[];
  readonly truncated: boolean;
}

/**
 * First-run setup: pick the workspace, then connect a model.
 *
 * The browser cannot hand a web page a folder's real path, so the runtime — which
 * runs on this machine — lists folders and the page walks through them. Only
 * folders are listed, never files.
 */
export function SetupWizard({ initial }: { readonly initial: SetupStatus }) {
  const [status, setStatus] = useState<SetupStatus>(initial);
  const [changing, setChanging] = useState(initial.workspace === null || !initial.workspace.exists);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [browseTo, setBrowseTo] = useState<string>(initial.workspace?.path ?? "");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!changing) return;
    let cancelled = false;
    const query = browseTo.length === 0 ? "" : `?path=${encodeURIComponent(browseTo)}`;
    void workspaceRequest<{ readonly folders: FolderListing }>(`setup/folders${query}`).then(
      (result) => {
        if (cancelled) return;
        if (result.ok) {
          setListing(result.data.folders);
          setTyped(result.data.folders.path);
        } else {
          setError(result.reason);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [changing, browseTo]);

  const open = (path: string): void => {
    setError(null);
    setBrowseTo(path);
  };

  const choose = async (path: string): Promise<void> => {
    setBusy(true);
    setError(null);
    const saved = await workspaceRequest<{ readonly workspace: SetupStatus["workspace"] }>(
      "setup/workspace",
      { path },
    );
    if (!saved.ok) {
      setBusy(false);
      setError(saved.reason);
      return;
    }
    const refreshed = await workspaceRequest<{ readonly setup: SetupStatus }>("setup");
    setBusy(false);
    if (refreshed.ok) setStatus(refreshed.data.setup);
    setChanging(false);
  };

  const workspace = status.workspace;

  return (
    <>
      <section className="panel setupStep" aria-label="Workspace">
        <p className="eyebrow">Step 1</p>
        <h2 className="panelTitle">Where should the harness work?</h2>
        <p className="muted">
          Pick the folder your projects live in. New projects start there, and anything an agent
          does with files stays inside it.
        </p>

        {workspace !== null && !changing ? (
          <>
            <p className="setupChosen">
              <span className="statusDot statusDot--on" aria-hidden="true" />
              <code>{workspace.path}</code>
            </p>
            <div className="btnRow">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setBrowseTo(workspace.path);
                  setChanging(true);
                }}
              >
                Change folder
              </button>
            </div>
          </>
        ) : (
          <>
            {workspace !== null && !workspace.exists ? (
              <p className="warn">
                The folder chosen before, <code>{workspace.path}</code>, is gone. Pick another.
              </p>
            ) : null}
            {listing === null ? (
              <p className="muted" role="status">
                Reading folders…
              </p>
            ) : (
              <div className="folderPicker">
                <div className="folderPicker__bar">
                  <code className="folderPicker__path">{listing.path}</code>
                  <div className="btnRow">
                    <button
                      type="button"
                      className="btn"
                      disabled={listing.parent === null}
                      onClick={() => {
                        if (listing.parent !== null) open(listing.parent);
                      }}
                    >
                      ↑ Up
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        open(listing.home);
                      }}
                    >
                      Home
                    </button>
                    {listing.roots.length > 1
                      ? listing.roots.map((root) => (
                          <button
                            key={root}
                            type="button"
                            className="btn"
                            onClick={() => {
                              open(root);
                            }}
                          >
                            {root}
                          </button>
                        ))
                      : null}
                  </div>
                </div>
                {listing.folders.length === 0 ? (
                  <p className="muted small">No folders inside this one.</p>
                ) : (
                  <ul className="folderPicker__list">
                    {listing.folders.map((folder) => (
                      <li key={folder.path}>
                        <button
                          type="button"
                          className="folderPicker__item"
                          onClick={() => {
                            open(folder.path);
                          }}
                        >
                          <span aria-hidden="true">📁</span> {folder.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {listing.truncated ? (
                  <p className="muted small">Only the first 500 folders are shown.</p>
                ) : null}
                <div className="btnRow">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={() => {
                      void choose(listing.path);
                    }}
                  >
                    {busy ? "Saving…" : "Use this folder"}
                  </button>
                  {workspace !== null && workspace.exists ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setChanging(false);
                        setError(null);
                      }}
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              </div>
            )}

            <form
              className="setupTyped"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                open(typed.trim());
              }}
            >
              <label className="field">
                <span className="field__label">Or type a folder path</span>
                <input
                  className="field__input"
                  value={typed}
                  placeholder="D:\Projects\my-app"
                  onChange={(event) => {
                    setTyped(event.target.value);
                  }}
                />
              </label>
              <div className="btnRow">
                <button className="btn" type="submit" disabled={typed.trim().length === 0}>
                  Go to folder
                </button>
              </div>
            </form>
          </>
        )}
        {error === null ? null : (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
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
