"use client";
import { useEffect, useId, useRef, useState } from "react";
import { workspaceRequest } from "../../lib/workspace-client";
import { FolderPicker } from "../setup/folder-picker";
import styles from "./project-edit-dialog.module.css";

export interface EditableProject {
  projectId: string;
  name: string;
  workspacePath: string | null;
  sourceFolders?: readonly string[];
  projectFeatures?: { sourceFolders?: boolean; remove?: boolean; edit?: boolean };
}
export function initialProjectFolders(project: EditableProject): string[] {
  return project.sourceFolders
    ? [...project.sourceFolders]
    : project.workspacePath
      ? [project.workspacePath]
      : [];
}
export function foldersNeedingTrust(project: EditableProject, folders: readonly string[]) {
  const original = initialProjectFolders(project);
  return [
    ...new Set(
      folders.filter(
        (folder, index) => !original.includes(folder) || (index === 0 && folder !== original[0]),
      ),
    ),
  ];
}
export function projectEditPayload(
  project: EditableProject,
  name: string,
  folders: string[],
  trustedAdditions: readonly string[],
) {
  const title = name.trim();
  if (!title || title.length > 200)
    throw new Error("Enter a project name between 1 and 200 characters.");
  if (!folders.length || folders.length > 20 || folders.some((folder) => !folder.trim()))
    throw new Error("Keep between 1 and 20 source folders.");
  if (new Set(folders).size !== folders.length)
    throw new Error("Each source folder must be unique.");
  const additions = foldersNeedingTrust(project, folders);
  if (additions.some((folder) => !trustedAdditions.includes(folder)))
    throw new Error("Trust each added folder before saving.");
  return { name: title, sourceFolders: folders, ...(additions.length ? { trusted: true } : {}) };
}
export async function saveProjectEdit(
  project: EditableProject,
  name: string,
  folders: string[],
  trustedAdditions: readonly string[],
) {
  if (project.projectFeatures?.sourceFolders !== true)
    throw new Error("Project editing unavailable: runtime update required.");
  const result = await workspaceRequest(
    `projects/${encodeURIComponent(project.projectId)}`,
    projectEditPayload(project, name, folders, trustedAdditions),
  );
  if (!result.ok) throw new Error(result.reason);
}
function FolderIcon() {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 6h7l2 2h9v12H3z" />
    </svg>
  );
}
export function ProjectEditDialog({
  project,
  onClose,
  onSaved,
  onRemoveRequested,
}: {
  project: EditableProject;
  onClose: () => void;
  onSaved: () => void;
  onRemoveRequested?: ((project: EditableProject) => void) | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [name, setName] = useState(project.name);
  const [folders, setFolders] = useState(() => initialProjectFolders(project));
  const [trustedAdditions, setTrustedAdditions] = useState<string[]>([]);
  const [choosing, setChoosing] = useState(false);
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const supported = project.projectFeatures?.sourceFolders === true;
  const primaryNeedsTrust =
    folders[0] &&
    foldersNeedingTrust(project, folders).includes(folders[0]) &&
    !trustedAdditions.includes(folders[0])
      ? folders[0]
      : null;
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    nameInput.current?.focus();
    return () => {
      if (element?.open) element.close();
    };
  }, []);
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !supported) return;
          setBusy(true);
          setError("");
          void saveProjectEdit(project, name, folders, trustedAdditions)
            .then(onSaved)
            .catch((cause) =>
              setError(cause instanceof Error ? cause.message : "Project could not be saved."),
            )
            .finally(() => setBusy(false));
        }}
      >
        <header className={styles.header}>
          <h2 id={titleId}>Edit project</h2>
          <button
            type="button"
            className={styles.icon}
            aria-label="Close edit project"
            disabled={busy}
            onClick={close}
          >
            ×
          </button>
        </header>
        <label className={styles.name}>
          <FolderIcon />
          <span className={styles.srOnly}>Project name</span>
          <input
            ref={nameInput}
            autoFocus
            value={name}
            maxLength={200}
            required
            disabled={busy || !supported}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <h3>Source folders</h3>
        <div className={styles.folders}>
          {folders.map((folder, index) => (
            <div className={styles.folder} key={folder}>
              <FolderIcon />
              <span title={folder} aria-label={index === 0 ? "Primary folder" : undefined}>
                {folder
                  .replace(/[\\/]+$/, "")
                  .split(/[\\/]/)
                  .pop() || folder}
              </span>
              <button
                type="button"
                className={styles.icon}
                disabled={busy || !supported}
                aria-label={`Remove source folder ${folder}`}
                title="Remove folder from project; files stay on disk"
                onClick={() => setFolders((current) => current.filter((path) => path !== folder))}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className={styles.add}
            disabled={busy || !supported}
            onClick={() => {
              setChoosing(true);
              setPendingFolder(null);
            }}
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h7l2 2h9v5 M3 6v14h9 M18 15v8 M14 19h8" />
            </svg>
            <span>Add folder</span>
          </button>
        </div>
        {choosing && (
          <div className={styles.picker}>
            <FolderPicker
              initialPath={folders[0] || ""}
              busy={busy}
              onChoose={(folder) => {
                if (folders.includes(folder)) {
                  setError("This folder is already in the project.");
                  return;
                }
                setPendingFolder(folder);
                setChoosing(false);
              }}
              onCancel={() => setChoosing(false)}
            />
          </div>
        )}
        {pendingFolder && (
          <section className={styles.trust} aria-label="Trust added source folder">
            <h3>Trust this folder?</h3>
            <p>{pendingFolder}</p>
            <p>
              Only trust folders whose contents and instructions you recognize. Existing action
              approvals still apply.
            </p>
            <button
              type="button"
              onClick={() => {
                setFolders((current) => [...current, pendingFolder]);
                setTrustedAdditions((current) => [...current, pendingFolder]);
                setPendingFolder(null);
                setError("");
              }}
            >
              Trust this folder
            </button>
            <button type="button" onClick={() => setPendingFolder(null)}>
              Cancel
            </button>
          </section>
        )}
        {primaryNeedsTrust && (
          <section className={styles.trust} aria-label="Trust changed primary folder">
            <h3>Trust this primary folder?</h3>
            <p>{primaryNeedsTrust}</p>
            <p>
              Existing project chats will use this folder on their next turn. Additional source
              folders are metadata and do not expand tool access.
            </p>
            <button
              type="button"
              onClick={() => setTrustedAdditions((current) => [...current, primaryNeedsTrust])}
            >
              Trust this folder
            </button>
          </section>
        )}
        {!supported && (
          <p className={styles.error} role="status">
            Project editing unavailable: runtime update required.
          </p>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.remove}
            disabled={busy || project.projectFeatures?.remove !== true || !onRemoveRequested}
            onClick={() => onRemoveRequested?.(project)}
            title="Remove the local project from the harness; folders and files remain on disk"
          >
            Remove local project
          </button>
          <div>
            <button type="button" className={styles.cancel} disabled={busy} onClick={close}>
              Cancel
            </button>
            <button
              type="submit"
              className={styles.save}
              disabled={
                busy ||
                !supported ||
                !name.trim() ||
                !folders.length ||
                Boolean(primaryNeedsTrust) ||
                Boolean(pendingFolder) ||
                choosing
              }
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
