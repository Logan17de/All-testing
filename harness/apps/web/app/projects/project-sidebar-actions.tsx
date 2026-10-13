"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { workspaceRequest } from "../../lib/workspace-client";
import type { EditableProject } from "./project-edit-dialog";
import styles from "./project-sidebar-actions.module.css";

export interface SidebarProject extends EditableProject {
  pinned?: boolean;
  section?: string | null;
  workspaceTrusted?: boolean;
  projectFeatures?: EditableProject["projectFeatures"] & {
    pin?: boolean;
    section?: boolean;
    archiveChats?: boolean;
  };
}
export type ProjectMenuAction = "pin" | "edit" | "explorer" | "archiveChats" | "remove";

export function groupSidebarProjects(projects: SidebarProject[]) {
  const sections = [...new Set(projects.map((project) => project.section || ""))];
  sections.sort((a, b) => (!a ? -1 : !b ? 1 : a.localeCompare(b)));
  return sections.map((section) => ({
    section,
    projects: projects
      .filter((project) => (project.section || "") === section)
      .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true)),
  }));
}

export async function saveSidebarProjectAction(
  project: SidebarProject,
  action: "pin" | "section" | "archiveChats" | "remove",
  section?: string | null,
) {
  if (project.projectFeatures?.[action] !== true)
    throw new Error("Project action unavailable: runtime update required.");
  const id = encodeURIComponent(project.projectId);
  const path =
    action === "archiveChats"
      ? `projects/${id}/archive-chats`
      : action === "remove"
        ? `projects/${id}/remove`
        : `projects/${id}`;
  const body =
    action === "pin"
      ? { pinned: project.pinned !== true }
      : action === "section"
        ? { section: section || null }
        : {};
  const result = await workspaceRequest(path, body);
  if (!result.ok) throw new Error(result.reason);
}

export function ProjectActionIcon({ kind }: { kind: ProjectMenuAction | "more" }) {
  const paths = {
    pin: "M9 3h6l-1 6 4 4v2H6v-2l4-4z M12 15v6",
    edit: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18 3l3 3-9 9-4 1 1-4z",
    explorer: "M3 7h7l2 2h8l-3 11H2z M3 7V4h7l2 3",
    archiveChats: "M3 3h18v5H3z M5 8v13h14V8 M9 12h6",
    remove: "M6 6l12 12 M18 6 6 18",
    more: "M5 12h.01 M12 12h.01 M19 12h.01",
  };
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={kind === "more" ? "3" : "1.5"}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[kind]} />
    </svg>
  );
}

export function ProjectMenu({
  project,
  anchor,
  trigger,
  explorerAvailable,
  onAction,
  onClose,
}: {
  project: SidebarProject;
  anchor: DOMRect;
  trigger: HTMLButtonElement;
  explorerAvailable: boolean;
  onAction: (action: ProjectMenuAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && !trigger.contains(event.target as Node))
        onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        trigger.focus();
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if ((event.target as HTMLElement)?.tagName === "INPUT") return;
        event.preventDefault();
        const buttons = [
          ...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []),
        ];
        const current = buttons.findIndex((button) => button === document.activeElement);
        buttons[
          (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
        ]?.focus();
      }
      if (event.key === "Tab") onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [onClose, trigger]);
  if (typeof document === "undefined") return null;
  const supported = (action: ProjectMenuAction) =>
    action === "explorer"
      ? explorerAvailable && project.workspaceTrusted === true
      : project.projectFeatures?.[action] === true;
  const item = (action: ProjectMenuAction, label: string) => (
    <button
      key={action}
      type="button"
      role="menuitem"
      disabled={!supported(action)}
      className={styles.item}
      title={!supported(action) ? "Unavailable in this runtime." : undefined}
      onClick={() => onAction(action)}
    >
      <ProjectActionIcon kind={action} />
      <span>{label}</span>
    </button>
  );
  return createPortal(
    <div
      ref={ref}
      className={styles.menu}
      role="menu"
      aria-label={`Settings for ${project.name}`}
      style={{
        left: Math.max(8, Math.min(anchor.right - 190, window.innerWidth - 198)),
        top: Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - 205)),
      }}
    >
      {item("pin", project.pinned ? "Unpin" : "Pin")}
      {item("edit", "Edit")}
      <div className={styles.divider} />
      {item("explorer", "Open in Explorer")}
      <div className={styles.divider} />
      {item("archiveChats", "Archive chats")}
      <div className={styles.divider} />
      {item("remove", "Remove project")}
    </div>,
    document.body,
  );
}

export function ProjectActionConfirmation({
  project,
  action,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  project: SidebarProject;
  action: "archiveChats" | "remove";
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <dialog
      ref={ref}
      className={styles.confirm}
      aria-labelledby="project-action-heading"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="project-action-heading">
        {action === "remove" ? "Remove project?" : "Archive project chats?"}
      </h2>
      <p>
        {action === "remove"
          ? `${project.name} will be removed from Projects. Its folders, files and saved chats will be kept.`
          : `Active chats in ${project.name} will be archived. Other projects and files will stay as they are.`}
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <footer>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className={styles.confirmAction} type="button" disabled={busy} onClick={onConfirm}>
          {busy ? "Saving…" : action === "remove" ? "Remove project" : "Archive chats"}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
