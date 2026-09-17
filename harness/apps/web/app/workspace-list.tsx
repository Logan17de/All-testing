"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { workspaceRequest } from "../lib/workspace-client";
import { isWorkspaceEntry, type WorkspaceEntry } from "../lib/workspaces";

/**
 * The folders this harness works in, and moving between them.
 *
 * Opening one points the harness at it and goes to its projects; the harness
 * keeps every folder it has opened, so coming back is one click, and forgetting
 * one only removes it from this list.
 */
export function WorkspaceList({ initial }: { readonly initial: readonly WorkspaceEntry[] }) {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceEntry[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);

  const open = async (path: string): Promise<void> => {
    setBusy(path);
    setError(null);
    const result = await workspaceRequest<unknown>("setup/workspace", { path });
    setBusy(null);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    router.push("/projects");
  };

  const forget = async (path: string): Promise<void> => {
    setBusy(path);
    const result = await workspaceRequest<{ readonly workspaces?: unknown }>(
      "setup/workspaces/forget",
      { path },
    );
    setBusy(null);
    setForgetting(null);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    const listed = result.data.workspaces;
    if (Array.isArray(listed)) setWorkspaces(listed.filter(isWorkspaceEntry));
  };

  return (
    <section className="workspaces" aria-label="Workspaces">
      <h2 className="panelTitle">Workspaces</h2>
      {error === null ? null : (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}

      {workspaces.length === 0 ? (
        <p className="muted">
          No folder chosen yet. <Link href="/setup">Choose one</Link>.
        </p>
      ) : (
        <ul className="workspaceList">
          {workspaces.map((workspace) => (
            <li className="workspaceRow" key={workspace.path}>
              <button
                type="button"
                className="workspaceOpen"
                disabled={busy !== null}
                aria-current={workspace.current ? "true" : undefined}
                onClick={() => {
                  void open(workspace.path);
                }}
              >
                <code className="workspacePath">{workspace.path}</code>
                {workspace.current ? <span className="badge badge--on">Open</span> : null}
                {workspace.exists ? null : <span className="badge badge--off">Not found</span>}
                {busy === workspace.path ? <span className="muted small">Opening…</span> : null}
              </button>
              {forgetting === workspace.path ? (
                <span className="btnRow">
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={busy !== null}
                    onClick={() => {
                      void forget(workspace.path);
                    }}
                  >
                    Forget it
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setForgetting(null);
                    }}
                  >
                    Keep it
                  </button>
                </span>
              ) : workspace.current ? null : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setForgetting(workspace.path);
                  }}
                >
                  Forget…
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="muted small">
        Opening a folder shows its projects. Forgetting one removes it from this list and leaves
        everything on disk. <Link href="/setup">Add another folder</Link>.
      </p>
    </section>
  );
}
