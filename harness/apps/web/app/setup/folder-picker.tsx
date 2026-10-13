"use client";
import { useEffect, useState } from "react";
import { workspaceRequest } from "../../lib/workspace-client";
interface FolderListing {
  path: string;
  parent: string | null;
  home: string;
  roots: string[];
  folders: { name: string; path: string }[];
  truncated: boolean;
}
export function FolderPicker({
  initialPath = "",
  busy = false,
  onChoose,
  onCancel,
}: {
  initialPath?: string;
  busy?: boolean;
  onChoose: (path: string) => void;
  onCancel?: (() => void) | undefined;
}) {
  const [path, setPath] = useState(initialPath);
  const [typed, setTyped] = useState(initialPath);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const navigate = (next: string) => {
    if (next === path) return;
    setLoading(true);
    setError("");
    setPath(next);
  };
  useEffect(() => {
    let cancelled = false;
    void workspaceRequest<{ folders: FolderListing }>(
      `setup/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok) {
        setListing(result.data.folders);
        setTyped(result.data.folders.path);
      } else {
        setListing(null);
        setError(result.reason);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return (
    <section aria-label="Choose a PC folder">
      <p className="muted small">
        Browse folders on the PC running the harness. Files are not listed.
      </p>
      {loading ? <p role="status">Reading folders…</p> : null}
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
      {listing ? (
        <div className="folderPicker">
          <p className="folderPicker__path">
            <code>{listing.path}</code>
          </p>
          <div className="btnRow">
            <button
              className="btn"
              type="button"
              disabled={busy || loading || !listing.parent}
              onClick={() => {
                if (listing.parent) navigate(listing.parent);
              }}
            >
              Up one folder
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy || loading}
              onClick={() => navigate(listing.home)}
            >
              Home
            </button>
            {listing.roots.length > 1
              ? listing.roots.map((root) => (
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || loading}
                    key={root}
                    onClick={() => navigate(root)}
                  >
                    {root}
                  </button>
                ))
              : null}
          </div>
          <ul className="folderPicker__list">
            {listing.folders.map((folder) => (
              <li key={folder.path}>
                <button
                  className="btn folderPicker__item"
                  type="button"
                  disabled={busy || loading}
                  onClick={() => navigate(folder.path)}
                >
                  {folder.name}
                </button>
              </li>
            ))}
          </ul>
          {!listing.folders.length ? <p className="muted small">No subfolders here.</p> : null}
          {listing.truncated ? (
            <p className="muted small">
              Only the first 500 folders are shown. Enter a path to open another folder.
            </p>
          ) : null}
          <button
            className="btn btn--primary"
            type="button"
            disabled={busy || loading}
            onClick={() => onChoose(listing.path)}
          >
            Use this folder
          </button>
        </div>
      ) : null}
      <label className="field">
        <span className="field__label">Or type a folder path</span>
        <input
          className="field__input"
          value={typed}
          disabled={busy || loading}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (typed.trim()) navigate(typed.trim());
            }
          }}
        />
      </label>
      <div className="btnRow">
        <button
          className="btn"
          type="button"
          disabled={busy || loading || !typed.trim()}
          onClick={() => navigate(typed.trim())}
        >
          Go to folder
        </button>
        {onCancel ? (
          <button className="btn" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </section>
  );
}
