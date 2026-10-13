"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Icon as WorkspaceIcon } from "./ui/workspace-icon";
import { ResizeHandle, usePanelWidth } from "./ui/resize-handle";
import { workspaceRequest } from "../lib/workspace-client";
import { ProjectEditDialog } from "./projects/project-edit-dialog";
import { SettingsPopup } from "./settings/settings-popup";
import type { SettingsId } from "./settings/settings-view";
import {
  groupSidebarProjects,
  ProjectActionConfirmation,
  ProjectActionIcon,
  ProjectMenu,
  saveSidebarProjectAction,
  type ProjectMenuAction,
  type SidebarProject,
} from "./projects/project-sidebar-actions";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const string = (value: unknown) => (typeof value === "string" ? value : "");
const sections = [
  ["/overview", "Overview"],
  ["/agent", "Chat"],
  ["/assistant", "My Assistant"],
  ["/projects", "Projects"],
  ["/editor", "Graph editor"],
  ["/plugin-maker", "Plugin maker"],
  ["/plugins", "Installed plugins"],
  ["/runs", "Runs & activity"],
  ["/models", "Models"],
  ["/desktop", "Desktop sessions"],
  ["/setup", "Workspace setup"],
  ["/settings", "Settings"],
] as const;
const SidebarContext = createContext<{
  closeNavigation: () => void;
  refreshSessions: () => void;
  openSettings: (section?: SettingsId) => void;
  sessions: RecordValue[];
}>({ closeNavigation: () => {}, refreshSessions: () => {}, openSettings: () => {}, sessions: [] });
export function useAppNavigation() {
  return useContext(SidebarContext);
}

function Icon({
  kind,
}: {
  kind:
    | "panel"
    | "new"
    | "assistant"
    | "chat"
    | "folder"
    | "chevron"
    | "plus"
    | "settings"
    | "search"
    | "close";
}) {
  const paths = {
    panel: "M4 4h16v16H4z M9 4v16",
    new: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.375 2.625a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z",
    assistant: "M5 5h14v11H9l-4 4z M8 9h8 M8 12h5",
    chat: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z",
    folder: "M3 6h7l2 2h9v12H3z",
    chevron: "M9 6l6 6-6 6",
    plus: "M12 5v14 M5 12h14",
    search: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M15 15l6 6",
    close: "M6 6l12 12 M18 6 6 18",
    settings:
      "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M15 12a3 3 0 1 1-6 0 3 3 0 1 1 6 0",
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[kind]} />
    </svg>
  );
}

/** Resolve a real newly-created chat, or setup when no default folder exists. */
export async function createSidebarChat(
  projectId: string | undefined,
  defaultFolder: string,
): Promise<string> {
  if (!projectId && !defaultFolder) return "/setup";
  const result = await workspaceRequest<{ result: unknown }>("agent", {
    action: "session/start",
    params: projectId ? { projectId } : {},
  });
  if (!result.ok) throw new Error(result.reason);
  const id = string(record(record(result.data.result).session).id);
  if (!id) throw new Error("The runtime did not return a chat ID.");
  return `/agent?session=${encodeURIComponent(id)}`;
}
export function ProjectChatList({
  projectId,
  sessions,
  onSelect,
  onPin,
  onArchive,
  pinBusy,
}: {
  projectId: string;
  sessions: RecordValue[];
  onSelect: (id: string) => void;
  onPin?: (id: string, pinned: boolean) => void;
  onArchive?: (id: string) => void;
  pinBusy?: boolean;
}) {
  const chats = sessions.filter((session) => string(session.projectId) === projectId);
  return (
    <div className="appProjectChats">
      {chats.length ? (
        chats.map((session) => (
          <SavedChatRow
            key={string(session.id)}
            session={session}
            onSelect={onSelect}
            onPin={onPin}
            onArchive={onArchive}
            pinBusy={pinBusy}
          />
        ))
      ) : (
        <p className="appSidebarHint">No chats</p>
      )}
    </div>
  );
}

export function pinnedSavedChats(sessions: RecordValue[]) {
  return sessions.filter(
    (session) =>
      session.pinned === true && session.archived !== true && session.status !== "archived",
  );
}
export function splitSidebarPins(projects: SidebarProject[], sessions: RecordValue[]) {
  return {
    pinnedProjects: projects.filter((project) => project.pinned === true),
    projects: projects.filter((project) => project.pinned !== true),
    pinnedChats: pinnedSavedChats(sessions),
    recents: sessions.filter(
      (session) =>
        session.pinned !== true && session.archived !== true && session.status !== "archived",
    ),
  };
}
export async function setSavedChatPinned(sessionId: string, pinned: boolean) {
  const response = await workspaceRequest("agent", {
    action: "session/pin",
    params: { sessionId, pinned },
  });
  if (!response.ok) throw new Error(response.reason);
}
export async function archiveSavedChat(sessionId: string) {
  const response = await workspaceRequest("agent", {
    action: "session/archive",
    params: { sessionId },
  });
  if (!response.ok) throw new Error(response.reason);
}
export function SavedChatRow({
  session,
  onSelect,
  onPin,
  onArchive,
  pinBusy,
  showIcon,
}: {
  session: RecordValue;
  onSelect: (id: string) => void;
  onPin?: ((id: string, pinned: boolean) => void) | undefined;
  onArchive?: ((id: string) => void) | undefined;
  pinBusy?: boolean | undefined;
  showIcon?: boolean | undefined;
}) {
  const title = string(session.preview) || "Untitled chat";
  const supported = typeof session.pinned === "boolean";
  return (
    <div className={`appChatRow${onArchive ? " appChatRow--archive" : ""}`}>
      <Link
        className="appSavedItem appChatItem"
        href={`/agent?session=${encodeURIComponent(string(session.id))}`}
        onClick={() => onSelect(string(session.id))}
        title={title}
      >
        {showIcon && <Icon kind="chat" />}
        <span>{title}</span>
      </Link>
      {onPin && (
        <button
          type="button"
          className="appChatPin"
          disabled={pinBusy || !supported}
          aria-pressed={session.pinned === true}
          aria-label={`${session.pinned === true ? "Unpin" : "Pin"} ${title}`}
          title={
            supported
              ? session.pinned === true
                ? "Unpin chat"
                : "Pin chat"
              : "Pinning unavailable: runtime update required."
          }
          onClick={() => onPin(string(session.id), session.pinned !== true)}
        >
          <svg
            aria-hidden="true"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4z M12 15v6" />
          </svg>
        </button>
      )}
      {onArchive && (
        <button
          type="button"
          className="appChatArchive"
          disabled={pinBusy}
          aria-label={`Archive ${title}`}
          title="Archive chat"
          onClick={() => onArchive(string(session.id))}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 3h16a1 1 0 0 1 1 1v4H3V4a1 1 0 0 1 1-1Z M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8 M10 12h4" />
          </svg>
        </button>
      )}
    </div>
  );
}

export function searchSavedChats(sessions: RecordValue[], query: string): RecordValue[] {
  const titleQuery = query.trim().toLocaleLowerCase();
  return titleQuery
    ? sessions.filter((session) =>
        (string(session.preview) || "Untitled chat").toLocaleLowerCase().includes(titleQuery),
      )
    : sessions;
}

export function SavedChatResults({
  sessions,
  query,
  onSelect,
  onPin,
  onArchive,
  pinBusy,
}: {
  sessions: RecordValue[];
  query: string;
  onSelect: (id: string) => void;
  onPin?: (id: string, pinned: boolean) => void;
  onArchive?: (id: string) => void;
  pinBusy?: boolean;
}) {
  const matches = searchSavedChats(sessions, query);
  return matches.length ? (
    matches.map((session) => (
      <SavedChatRow
        key={string(session.id)}
        session={session}
        onSelect={onSelect}
        onPin={onPin}
        onArchive={onArchive}
        pinBusy={pinBusy}
      />
    ))
  ) : (
    <p className="appSidebarHint" role="status">
      {query.trim() ? "No chats match this title." : "No saved chats."}
    </p>
  );
}
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [narrowNavigation, setNarrowNavigation] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    let active = true;
    const update = () => setNarrowNavigation(media.matches);
    void Promise.resolve().then(() => {
      if (active) update();
    });
    media.addEventListener("change", update);
    return () => {
      active = false;
      media.removeEventListener("change", update);
    };
  }, []);
  const [sidebarWidth, setSidebarWidth] = usePanelWidth("zet.sidebar.width", 288, 200, 360);
  const [settingsSection, setSettingsSection] = useState<SettingsId | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const chatSearchButton = useRef<HTMLButtonElement>(null);
  const [chatTitleQuery, setChatTitleQuery] = useState("");
  const [preferencesReady, setPreferencesReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => {
      if (disposed) return;
      try {
        const saved = record(JSON.parse(localStorage.getItem("zet.sidebar.preferences") || "{}"));
        setCollapsed(saved.collapsed === true);
        setProjectsOpen(saved.projectsOpen === true);
        setRecentsOpen(saved.recentsOpen === true);
      } catch {
        /* Unavailable storage must not block navigation. */
      }
      setPreferencesReady(true);
    });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (!preferencesReady) return;
    try {
      localStorage.setItem(
        "zet.sidebar.preferences",
        JSON.stringify({ collapsed, projectsOpen, recentsOpen }),
      );
    } catch {
      /* Navigation works without persistent preferences. */
    }
  }, [collapsed, projectsOpen, recentsOpen, preferencesReady]);
  const [projects, setProjects] = useState<RecordValue[]>([]);
  const [projectFeatures, setProjectFeatures] = useState<RecordValue>({});
  const [projectMenu, setProjectMenu] = useState<{
    project: SidebarProject;
    anchor: DOMRect;
    trigger: HTMLButtonElement;
  } | null>(null);
  const [editingProject, setEditingProject] = useState<SidebarProject | null>(null);
  const [projectConfirmation, setProjectConfirmation] = useState<{
    project: SidebarProject;
    action: "archiveChats" | "remove";
  } | null>(null);
  const [projectActionError, setProjectActionError] = useState("");
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  const [explorerAvailable, setExplorerAvailable] = useState(false);
  const [sessions, setSessions] = useState<RecordValue[]>([]);
  const [inventoryError, setInventoryError] = useState("");
  const [projectToReview, setProjectToReview] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [defaultFolder, setDefaultFolder] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const closeNavigation = useCallback(() => setNavigationOpen(false), []);
  useEffect(() => {
    if (!navigationOpen) return;
    const panel = document.getElementById("app-navigation");
    const narrow = window.matchMedia("(max-width: 760px)");
    const focusable = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          "a[href], button:not(:disabled), summary, input:not(:disabled)",
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeNavigation();
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const onWidth = () => {
      if (!narrow.matches) closeNavigation();
    };
    document.addEventListener("keydown", onKey);
    narrow.addEventListener("change", onWidth);
    return () => {
      document.removeEventListener("keydown", onKey);
      narrow.removeEventListener("change", onWidth);
      queueMicrotask(() => navigationTrigger.current?.focus());
    };
  }, [navigationOpen, closeNavigation]);
  const openSettings = useCallback(
    (section: SettingsId = "general") => {
      setSettingsSection(section);
      closeNavigation();
    },
    [closeNavigation],
  );
  const refreshSessions = useCallback(() => setRefreshVersion((value) => value + 1), []);
  const closeProjectMenu = useCallback(() => setProjectMenu(null), []);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/editor/project-explorer", { cache: "no-store" })
      .then((response) => response.json())
      .then((result: unknown) => {
        if (!cancelled) setExplorerAvailable(record(result).available === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  async function projectAction(project: SidebarProject, action: ProjectMenuAction) {
    closeProjectMenu();
    setProjectActionError("");
    if (action === "edit") {
      setEditingProject(project);
      return;
    }
    if (action === "archiveChats" || action === "remove") {
      setProjectConfirmation({ project, action });
      return;
    }
    setProjectActionBusy(true);
    try {
      if (action === "explorer") {
        const response = await fetch("/api/editor/project-explorer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: project.projectId }),
        });
        const result = record(await response.json());
        if (!response.ok)
          throw new Error(string(record(result.error).reason) || "Explorer could not be opened.");
      } else await saveSidebarProjectAction(project, action);
      refreshSessions();
    } catch (cause) {
      setInventoryError(cause instanceof Error ? cause.message : "Project action failed.");
    } finally {
      setProjectActionBusy(false);
    }
  }
  async function confirmProjectAction() {
    if (!projectConfirmation || projectActionBusy) return;
    setProjectActionBusy(true);
    setProjectActionError("");
    try {
      await saveSidebarProjectAction(projectConfirmation.project, projectConfirmation.action);
      setProjectConfirmation(null);
      refreshSessions();
    } catch (cause) {
      setProjectActionError(cause instanceof Error ? cause.message : "Project action failed.");
    } finally {
      setProjectActionBusy(false);
    }
  }
  async function pinChat(id: string, pinned: boolean) {
    if (
      pinBusy ||
      !sessions.some((session) => string(session.id) === id && typeof session.pinned === "boolean")
    )
      return;
    setPinBusy(true);
    try {
      await setSavedChatPinned(id, pinned);
      refreshSessions();
    } catch (cause) {
      setInventoryError(cause instanceof Error ? cause.message : "Chat pin could not be saved.");
    } finally {
      setPinBusy(false);
    }
  }
  async function archiveChat(id: string) {
    if (pinBusy || !sessions.some((session) => string(session.id) === id)) return;
    setPinBusy(true);
    setInventoryError("");
    try {
      await archiveSavedChat(id);
      setSessions((current) => current.filter((session) => string(session.id) !== id));
      window.dispatchEvent(new CustomEvent("zet:session-archived", { detail: id }));
      if (new URL(window.location.href).searchParams.get("session") === id)
        router.replace("/agent");
      refreshSessions();
    } catch (cause) {
      setInventoryError(cause instanceof Error ? cause.message : "Chat could not be archived.");
    } finally {
      setPinBusy(false);
    }
  }
  const coding = pathname === "/agent" || pathname === "/settings";
  const standalone = pathname === "/" || pathname === "/codex";
  useEffect(() => {
    if (standalone) return;
    let stale = false;
    async function load() {
      const [projectResult, setupResult, sessionResult] = await Promise.all([
        workspaceRequest<RecordValue>("projects?status=active"),
        workspaceRequest<RecordValue>("setup"),
        workspaceRequest<{ result: unknown }>("agent", {
          action: "session/list",
          params: { archived: false },
        }),
      ]);
      if (stale) return;
      if (setupResult.ok) {
        const workspace = record(record(setupResult.data.setup).workspace);
        setDefaultFolder(workspace.trusted === true ? string(workspace.path) : "");
      }
      setProjects(
        projectResult.ok && Array.isArray(projectResult.data.projects)
          ? projectResult.data.projects
              .map(record)
              .filter((project) => project.status !== "archived")
          : [],
      );
      setProjectFeatures(projectResult.ok ? record(projectResult.data.projectFeatures) : {});
      const data = sessionResult.ok ? record(sessionResult.data.result).data : null;
      setSessions(Array.isArray(data) ? data.map(record) : []);
      setInventoryError(
        !projectResult.ok
          ? "Projects could not be loaded."
          : !sessionResult.ok
            ? "Chats could not be loaded."
            : "",
      );
      setLoading(false);
    }
    void load();
    const onFocus = () => {
      void load();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      stale = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [pathname, standalone, refreshVersion]);

  async function newChat(projectId?: string) {
    setCreating(true);
    setInventoryError("");
    setProjectToReview("");
    try {
      let selectedDefault = defaultFolder;
      if (!projectId) {
        const setup = await workspaceRequest<RecordValue>("setup");
        if (!setup.ok) throw new Error(setup.reason);
        const workspace = record(record(setup.data.setup).workspace);
        selectedDefault = workspace.trusted === true ? string(workspace.path) : "";
      }
      const destination = await createSidebarChat(projectId, selectedDefault);
      refreshSessions();
      closeNavigation();
      if (destination.startsWith("/agent?session="))
        window.dispatchEvent(
          new CustomEvent("zet:session-selected", {
            detail: new URL(destination, window.location.origin).searchParams.get("session"),
          }),
        );
      router.push(destination);
    } catch (cause) {
      setInventoryError(cause instanceof Error ? cause.message : "Chat could not be created.");
      if (projectId) setProjectToReview(projectId);
    } finally {
      setCreating(false);
    }
  }
  if (standalone) return children;
  const sidebarProjects: SidebarProject[] = projects.map((project) => ({
    projectId: string(project.projectId),
    name: string(project.name) || "Untitled project",
    workspacePath: string(project.workspacePath) || null,
    ...(Array.isArray(project.sourceFolders)
      ? {
          sourceFolders: project.sourceFolders.filter(
            (path): path is string => typeof path === "string",
          ),
        }
      : {}),
    pinned: project.pinned === true,
    section: string(project.section) || null,
    workspaceTrusted: project.workspaceTrusted === true,
    projectFeatures: {
      pin: projectFeatures.pin === true,
      edit: projectFeatures.edit === true,
      section: projectFeatures.section === true,
      sourceFolders: projectFeatures.sourceFolders === true,
      archiveChats: projectFeatures.archiveChats === true,
      remove: projectFeatures.remove === true,
    },
  }));
  const pins = splitSidebarPins(sidebarProjects, sessions);
  const renderProjectFolder = (project: SidebarProject) => (
    <details className="appProjectFolder" key={project.projectId}>
      <summary>
        <Icon kind="folder" />
        <span>{project.name}</span>
        <button
          type="button"
          className="appProjectMenuToggle"
          disabled={projectActionBusy}
          aria-label={`Settings for ${project.name}`}
          aria-haspopup="menu"
          aria-expanded={projectMenu?.project.projectId === project.projectId}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setProjectMenu(
              projectMenu?.project.projectId === project.projectId
                ? null
                : {
                    project,
                    anchor: event.currentTarget.getBoundingClientRect(),
                    trigger: event.currentTarget,
                  },
            );
          }}
        >
          <ProjectActionIcon kind="more" />
        </button>
        <button
          type="button"
          disabled={creating}
          className="appProjectCompose"
          aria-label={`New chat in ${string(project.name) || "project"}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void newChat(string(project.projectId));
          }}
        >
          <Icon kind="new" />
        </button>
      </summary>
      <ProjectChatList
        projectId={string(project.projectId)}
        sessions={sessions}
        pinBusy={pinBusy}
        onArchive={(id) => {
          void archiveChat(id);
        }}
        onPin={(id, pinned) => {
          void pinChat(id, pinned);
        }}
        onSelect={(id) => {
          window.dispatchEvent(new CustomEvent("zet:session-selected", { detail: id }));
          closeNavigation();
        }}
      />
    </details>
  );
  const current = sections.find(([href]) => pathname === href || pathname.startsWith(`${href}/`));
  return (
    <SidebarContext.Provider value={{ closeNavigation, refreshSessions, openSettings, sessions }}>
      <div
        className={`appShell${coding ? " appShell--coding" : ""}${collapsed ? " appShell--collapsed" : ""}${pathname.split("/").filter(Boolean).length === 1 ? " appShell--section" : ""}`}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <aside
          id="app-navigation"
          className={`appSidebar${navigationOpen ? " appSidebar--open" : ""}`}
          aria-label="Application navigation"
          role={navigationOpen ? "dialog" : undefined}
          aria-modal={navigationOpen || undefined}
        >
          <div className="appSidebarBrandRow">
            <span className="appBrand">Zet Harness</span>
            <button
              className="appSidebarClose"
              type="button"
              aria-label="Collapse sidebar"
              onClick={() => {
                setCollapsed(true);
                closeNavigation();
              }}
            >
              <Icon kind="panel" />
            </button>
          </div>
          <nav className="appPrimaryNav" aria-label="Workspace shortcuts">
            <button
              type="button"
              disabled={loading || creating}
              onClick={() => {
                void newChat();
              }}
            >
              <Icon kind="new" />
              <span>{creating ? "Creating chat…" : "New chat"}</span>
            </button>
            <Link href="/assistant" onClick={closeNavigation}>
              <Icon kind="assistant" />
              <span>My Assistant</span>
            </Link>
            <Link
              href="/editor"
              aria-current={pathname.startsWith("/editor") ? "page" : undefined}
              onClick={closeNavigation}
            >
              <WorkspaceIcon name="graph" />
              <span>Graph editor</span>
            </Link>
          </nav>
          <div className="appSidebarCollections">
            {(pins.pinnedChats.length > 0 || pins.pinnedProjects.length > 0) && (
              <section className="appPinnedItems" aria-label="Pinned items">
                <div className="appSidebarHeading">
                  <span>Pinned</span>
                </div>
                {pins.pinnedChats.map((session) => (
                  <SavedChatRow
                    key={string(session.id)}
                    session={session}
                    showIcon
                    pinBusy={pinBusy}
                    onPin={(id, pinned) => {
                      void pinChat(id, pinned);
                    }}
                    onArchive={(id) => {
                      void archiveChat(id);
                    }}
                    onSelect={(id) => {
                      window.dispatchEvent(new CustomEvent("zet:session-selected", { detail: id }));
                      closeNavigation();
                    }}
                  />
                ))}
                {pins.pinnedProjects.map(renderProjectFolder)}
              </section>
            )}
            <details
              className="appSidebarProjects"
              open={projectsOpen}
              onToggle={(event) => setProjectsOpen(event.currentTarget.open)}
              aria-label="Saved projects"
            >
              <summary className="appSidebarHeading">
                <span>Projects</span>
                <Icon kind="chevron" />
                <Link
                  className="appProjectAdd"
                  href="/projects#new-project"
                  aria-label="New project"
                  onClick={closeNavigation}
                >
                  <Icon kind="plus" />
                </Link>
              </summary>
              {loading ? (
                <p className="appSidebarHint">Loading projects.</p>
              ) : pins.projects.length ? (
                groupSidebarProjects(pins.projects).map((group) => (
                  <div key={group.section} className="appProjectSection">
                    {group.section && <div className="appProjectSectionLabel">{group.section}</div>}
                    {group.projects.map(renderProjectFolder)}
                  </div>
                ))
              ) : (
                <p className="appSidebarHint">
                  {projects.length ? "No unpinned projects." : "No projects yet."}
                </p>
              )}
            </details>
            <details
              className="appSidebarRecents"
              open={recentsOpen}
              onToggle={(event) => setRecentsOpen(event.currentTarget.open)}
              aria-label="Recent chats"
            >
              <summary className="appSidebarHeading">
                <span>Recents</span>
                <Icon kind="chevron" />
                <button
                  ref={chatSearchButton}
                  type="button"
                  className="appChatSearchToggle"
                  aria-label="Search chats"
                  aria-expanded={chatSearchOpen}
                  aria-controls="sidebar-chat-search"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setRecentsOpen(true);
                    setChatSearchOpen(!chatSearchOpen);
                    setChatTitleQuery("");
                  }}
                >
                  <Icon kind="search" />
                </button>
              </summary>
              {chatSearchOpen && (
                <div className="appChatSearch" id="sidebar-chat-search">
                  <input
                    type="search"
                    autoFocus
                    aria-label="Search saved chat titles"
                    placeholder="Search chats"
                    value={chatTitleQuery}
                    onChange={(event) => setChatTitleQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setChatTitleQuery("");
                        setChatSearchOpen(false);
                        chatSearchButton.current?.focus();
                      }
                    }}
                  />
                  {chatTitleQuery && (
                    <button
                      type="button"
                      aria-label="Clear chat title search"
                      onClick={() => setChatTitleQuery("")}
                    >
                      <Icon kind="close" />
                    </button>
                  )}
                </div>
              )}
              {loading ? (
                <p className="appSidebarHint">Loading chats.</p>
              ) : (
                <SavedChatResults
                  sessions={pins.recents}
                  query={chatTitleQuery}
                  pinBusy={pinBusy}
                  onArchive={(id) => {
                    void archiveChat(id);
                  }}
                  onPin={(id, pinned) => {
                    void pinChat(id, pinned);
                  }}
                  onSelect={(id) => {
                    window.dispatchEvent(new CustomEvent("zet:session-selected", { detail: id }));
                    closeNavigation();
                  }}
                />
              )}
            </details>
            {inventoryError ? (
              <p className="appSidebarHint" role="alert">
                {inventoryError}
                {projectToReview ? (
                  <Link
                    href={`/projects/${encodeURIComponent(projectToReview)}#project-folder`}
                    onClick={closeNavigation}
                  >
                    Review project folder
                  </Link>
                ) : null}
              </p>
            ) : null}
          </div>
          <footer className="appSidebarFooter">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-controls="settings-popup"
              aria-expanded={settingsSection !== null}
              onClick={() => openSettings()}
            >
              <Icon kind="settings" />
              <span>Settings</span>
            </button>
          </footer>
        </aside>
        {!collapsed && (
          <ResizeHandle
            className="appSidebarResize"
            label="Resize navigation"
            controls="app-navigation"
            value={sidebarWidth}
            min={200}
            max={360}
            defaultValue={288}
            onChange={setSidebarWidth}
            side="left"
          />
        )}
        {settingsSection && (
          <SettingsPopup
            initialSection={settingsSection}
            onClose={() => setSettingsSection(null)}
          />
        )}
        {projectMenu && (
          <ProjectMenu
            {...projectMenu}
            explorerAvailable={explorerAvailable}
            onClose={closeProjectMenu}
            onAction={(action) => {
              void projectAction(projectMenu.project, action);
            }}
          />
        )}
        {editingProject && (
          <ProjectEditDialog
            key={editingProject.projectId}
            project={editingProject}
            onClose={() => setEditingProject(null)}
            onSaved={() => {
              setEditingProject(null);
              refreshSessions();
            }}
            onRemoveRequested={() => {
              setEditingProject(null);
              setProjectActionError("");
              setProjectConfirmation({ project: editingProject, action: "remove" });
            }}
          />
        )}
        {projectConfirmation && (
          <ProjectActionConfirmation
            {...projectConfirmation}
            busy={projectActionBusy}
            error={projectActionError}
            onCancel={() => setProjectConfirmation(null)}
            onConfirm={() => {
              void confirmProjectAction();
            }}
          />
        )}
        {navigationOpen ? (
          <button
            className="appNavigationBackdrop"
            type="button"
            aria-label="Close navigation"
            onClick={closeNavigation}
          />
        ) : null}
        <div className="appStage" inert={navigationOpen}>
          <button
            className="appSidebarRestore"
            type="button"
            aria-label="Open sidebar"
            aria-controls="app-navigation"
            aria-expanded={narrowNavigation ? navigationOpen : !collapsed}
            onClick={(event) => {
              navigationTrigger.current = event.currentTarget;
              setCollapsed(false);
              setNavigationOpen(window.matchMedia("(max-width: 760px)").matches);
            }}
          >
            <Icon kind="panel" />
          </button>
          <header className="appTopbar">
            <div>
              <button
                className="appMenu"
                type="button"
                aria-label="Open navigation"
                aria-controls="app-navigation"
                aria-expanded={navigationOpen}
                onClick={(event) => {
                  navigationTrigger.current = event.currentTarget;
                  setNavigationOpen(!navigationOpen);
                }}
              >
                <Icon kind="panel" />
              </button>
              <strong>{current?.[1] ?? "Workspace"}</strong>
            </div>
            <Link href={coding ? "/models" : "/agent"}>{coding ? "Models" : "Back to chat"}</Link>
          </header>
          <div className="appPageContent">{children}</div>
        </div>
      </div>
    </SidebarContext.Provider>
  );
}
