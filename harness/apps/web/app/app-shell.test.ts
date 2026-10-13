import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ path: "/agent" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.path,
  useRouter: () => ({ push: vi.fn() }),
}));
import {
  AppShell,
  createSidebarChat,
  ProjectChatList,
  searchSavedChats,
  SavedChatResults,
  SavedChatRow,
  pinnedSavedChats,
  setSavedChatPinned,
  archiveSavedChat,
  splitSidebarPins,
} from "./app-shell";
import { workspaceRequest } from "../lib/workspace-client";
vi.mock("../lib/workspace-client", () => ({ workspaceRequest: vi.fn() }));
import { AgentWorkspace } from "./agent/agent-workspace";

function renderCoding() {
  navigation.path = "/agent";
  return renderToStaticMarkup(createElement(AppShell, null, createElement(AgentWorkspace)));
}
describe("charcoal coding workspace composition", () => {
  it("renders one shared navigation sidebar and no secondary chat drawer", () => {
    const html = renderCoding();
    expect(html.match(/aria-label="Application navigation"/g)).toHaveLength(1);
    expect(html).not.toContain('id="coding-sidebar"');
    expect(html).toContain('aria-label="Saved projects"');
    expect(html).toContain('aria-haspopup="dialog" aria-controls="settings-popup"');
  });
  it("renders the real graph panel open by default on the desktop server layout", () => {
    const html = renderCoding();
    expect(html).toContain('id="coding-graph"');
    expect(html).toContain('aria-expanded="true" aria-controls="coding-inspector"');
    expect(html).toContain("Start or select a chat to see its connected graph.");
    expect(html).not.toContain("synthetic");
  });
  it("preserves model and permission gates before a task can be sent", () => {
    const html = renderCoding();
    expect(html).toContain('id="coding-prompt"');
    expect(html).toContain("Choose a model");
    expect(html).toMatch(/<button[^>]*class="codingSend"[^>]*disabled=""/);
    expect(html).toContain("Ask for approval");
    expect(html).toContain("Actions still require approval.");
    expect(html).not.toContain('aria-label="Chat settings"');
  });
  it("matches the compact navigation with collapsed collections and bottom settings", () => {
    const html = renderCoding();
    expect(html).toContain("New chat");
    expect(html).toContain("My Assistant");
    expect(html).toContain("Recents");
    expect(html).toContain('aria-label="Collapse sidebar"');
    expect(html).toContain('aria-label="Open sidebar"');
    expect(html).not.toContain("Workspace tools");
    expect(html).not.toContain("Saved coding chats");
    expect(html).not.toContain('class="codingActivity"');
    expect(html).toMatch(/<details class="appSidebarProjects" aria-label="Saved projects">/);
    expect(html).toMatch(/<details class="appSidebarRecents" aria-label="Recent chats">/);
    expect(html.indexOf('class="appSidebarFooter"')).toBeGreaterThan(
      html.indexOf('aria-label="Recent chats"'),
    );
  });
  it("keeps the shared navigation behind the settings popup route", () => {
    navigation.path = "/settings";
    const html = renderToStaticMarkup(
      createElement(AppShell, null, createElement("main", null, "Settings content")),
    );
    expect(html).toContain("appShell--coding");
    expect(html).toContain('aria-label="Application navigation"');
    expect(html).toContain('aria-controls="settings-popup"');
  });
});

describe("sidebar chat archives", () => {
  it("sends an archive for only the selected chat and surfaces refusal", async () => {
    vi.mocked(workspaceRequest).mockResolvedValueOnce({ ok: true, data: {} });
    await archiveSavedChat("chosen-chat");
    expect(workspaceRequest).toHaveBeenLastCalledWith("agent", {
      action: "session/archive",
      params: { sessionId: "chosen-chat" },
    });
    vi.mocked(workspaceRequest).mockResolvedValueOnce({ ok: false, reason: "Archive refused" });
    await expect(archiveSavedChat("chosen-chat")).rejects.toThrow("Archive refused");
  });
  it("offers an enabled archive in both lists even when pin metadata is unavailable", () => {
    const sessions = [{ id: "old", projectId: "one", preview: "Older chat" }];
    const actions = { sessions, onSelect: vi.fn(), onPin: vi.fn(), onArchive: vi.fn() };
    for (const html of [
      renderToStaticMarkup(createElement(ProjectChatList, { ...actions, projectId: "one" })),
      renderToStaticMarkup(createElement(SavedChatResults, { ...actions, query: "" })),
    ]) {
      expect(html).toMatch(
        /<button[^>]*class="appChatArchive"[^>]*aria-label="Archive Older chat"[^>]*title="Archive chat"/,
      );
      expect(html).not.toMatch(/<button[^>]*class="appChatArchive"[^>]*disabled/);
      expect(html).toContain("Pinning unavailable");
    }
  });
});

describe("sidebar chat creation", () => {
  it("opens setup without creating a chat when the default folder is absent", async () => {
    vi.mocked(workspaceRequest).mockClear();
    expect(await createSidebarChat(undefined, "")).toBe("/setup");
    expect(workspaceRequest).not.toHaveBeenCalled();
  });
  it("uses default setup selection and navigates to the returned chat", async () => {
    vi.mocked(workspaceRequest).mockResolvedValueOnce({
      ok: true,
      data: { result: { session: { id: "chat / one" } } },
    });
    expect(await createSidebarChat(undefined, "D:/project")).toBe(
      "/agent?session=chat%20%2F%20one",
    );
    expect(workspaceRequest).toHaveBeenLastCalledWith("agent", {
      action: "session/start",
      params: {},
    });
  });
  it("creates in the explicitly selected project even without a default folder", async () => {
    vi.mocked(workspaceRequest).mockResolvedValueOnce({
      ok: true,
      data: { result: { session: { id: "project-chat" } } },
    });
    expect(await createSidebarChat("project-id", "")).toBe("/agent?session=project-chat");
    expect(workspaceRequest).toHaveBeenLastCalledWith("agent", {
      action: "session/start",
      params: { projectId: "project-id" },
    });
  });
  it("keeps real creation errors visible instead of navigating to a fake chat", async () => {
    vi.mocked(workspaceRequest).mockResolvedValueOnce({ ok: false, reason: "Folder unavailable" });
    await expect(createSidebarChat("project-id", "")).rejects.toThrow("Folder unavailable");
  });
});

describe("project folder chat contents", () => {
  it("shows a plain empty label with no inline chat creation action", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectChatList, { projectId: "empty", sessions: [], onSelect: vi.fn() }),
    );
    expect(html).toContain("No chats");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a");
  });
  it("includes only chats belonging to the expanded project", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectChatList, {
        projectId: "one",
        onSelect: vi.fn(),
        sessions: [
          { id: "a", projectId: "one", preview: "First project chat" },
          { id: "b", projectId: "two", preview: "Other project chat" },
        ],
      }),
    );
    expect(html).toContain("First project chat");
    expect(html).toContain('href="/agent?session=a"');
    expect(html).not.toContain("Other project chat");
    expect(html).not.toContain("No chats");
  });
});

describe("saved chat title search", () => {
  const sessions = [
    { id: "a", preview: "Fix parser", projectId: "one" },
    { id: "b / two", preview: "Parser documentation", projectId: "two" },
    { id: "c", preview: "Release notes", projectId: "one" },
    { id: "empty", preview: "" },
  ];
  it("searches actual titles across projects without inspecting message bodies or changing order", () => {
    expect(searchSavedChats(sessions, "  PARSER ").map((s) => s.id)).toEqual(["a", "b / two"]);
    expect(searchSavedChats(sessions, " ")).toBe(sessions);
    expect(searchSavedChats(sessions, "Untitled").map((s) => s.id)).toEqual(["empty"]);
    expect(
      searchSavedChats([{ id: "x", preview: "Different title", messages: "Parser" }], "parser"),
    ).toEqual([]);
  });
  it("keeps actual session navigation and truthful no-match/empty states", () => {
    const onSelect = vi.fn();
    const html = renderToStaticMarkup(
      createElement(SavedChatResults, { sessions, query: "parser", onSelect }),
    );
    expect(html).toContain('href="/agent?session=b%20%2F%20two"');
    expect(html).not.toContain("Release notes");
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      renderToStaticMarkup(
        createElement(SavedChatResults, { sessions, query: "missing", onSelect }),
      ),
    ).toContain("No chats match this title.");
    expect(
      renderToStaticMarkup(createElement(SavedChatResults, { sessions: [], query: "", onSelect })),
    ).toContain("No saved chats.");
  });
});

describe("durable saved chat pins", () => {
  it("separates pinned projects and chats from ordinary lists while preserving order", () => {
    const pinnedProject = {
      projectId: "p",
      name: "Pinned project",
      workspacePath: null,
      pinned: true,
    };
    const project = { projectId: "normal", name: "Project", workspacePath: null };
    const pinned = { id: "a", pinned: true };
    const chat = { id: "b", pinned: false };
    expect(
      splitSidebarPins(
        [project, pinnedProject],
        [pinned, chat, { id: "gone", status: "archived" }],
      ),
    ).toEqual({
      pinnedProjects: [pinnedProject],
      projects: [project],
      pinnedChats: [pinned],
      recents: [chat],
    });
  });
  it("renders a chat bubble in pinned chat links while retaining unpin and archive", () => {
    const html = renderToStaticMarkup(
      createElement(SavedChatRow, {
        session: { id: "chat", preview: "Pinned chat", pinned: true },
        showIcon: true,
        onSelect: vi.fn(),
        onPin: vi.fn(),
        onArchive: vi.fn(),
      }),
    );
    expect(html).toMatch(/<a[^>]*><svg[^>]*aria-hidden="true"/);
    expect(html).toContain('aria-label="Unpin Pinned chat"');
    expect(html).toContain('aria-label="Archive Pinned chat"');
  });
  it("selects active pins across projects and excludes archived metadata", () => {
    expect(
      pinnedSavedChats([
        { id: "a", projectId: "one", pinned: true },
        { id: "b", projectId: "two", pinned: true },
        { id: "archive", pinned: true, archived: true },
        { id: "archive-status", pinned: true, status: "archived" },
        { id: "c", pinned: false },
      ]).map((s) => s.id),
    ).toEqual(["a", "b"]);
  });
  it("sends exact durable pin intent and surfaces backend errors", async () => {
    vi.mocked(workspaceRequest).mockResolvedValueOnce({ ok: true, data: {} });
    await setSavedChatPinned("actual-chat", true);
    expect(workspaceRequest).toHaveBeenLastCalledWith("agent", {
      action: "session/pin",
      params: { sessionId: "actual-chat", pinned: true },
    });
    vi.mocked(workspaceRequest).mockResolvedValueOnce({
      ok: false,
      reason: "Chat no longer available",
    });
    await expect(setSavedChatPinned("actual-chat", false)).rejects.toThrow(
      "Chat no longer available",
    );
  });
  it("renders truthful old-runtime gates and unpin action without a create control", () => {
    const render = (session: Record<string, unknown>) =>
      renderToStaticMarkup(
        createElement(SavedChatRow, { session, onSelect: vi.fn(), onPin: vi.fn() }),
      );
    expect(render({ id: "old", preview: "Old chat" })).toContain("runtime update required");
    expect(render({ id: "old", preview: "Old chat" })).toMatch(/<button[^>]*disabled/);
    const html = render({ id: "pinned", preview: "Pinned chat", pinned: true });
    expect(html).toContain('aria-label="Unpin Pinned chat"');
    expect(html).not.toContain("New chat");
  });
});
