import { describe, expect, it, vi } from "vitest";
import {
  groupSidebarProjects,
  saveSidebarProjectAction,
  type SidebarProject,
} from "./project-sidebar-actions";
import { workspaceRequest } from "../../lib/workspace-client";
vi.mock("../../lib/workspace-client", () => ({ workspaceRequest: vi.fn() }));
const project: SidebarProject = {
  projectId: "project-one",
  name: "One",
  workspacePath: "D:/one",
  pinned: false,
  projectFeatures: { pin: true, section: true, archiveChats: true, remove: true },
};
describe("saved project sidebar actions", () => {
  it("groups projects and keeps pins first without mutating the input", () => {
    const input = [
      project,
      { ...project, projectId: "pinned", pinned: true },
      { ...project, projectId: "two", section: "Work" },
    ];
    expect(
      groupSidebarProjects(input).map((group) => [
        group.section,
        group.projects.map((p) => p.projectId),
      ]),
    ).toEqual([
      ["", ["pinned", "project-one"]],
      ["Work", ["two"]],
    ]);
    expect(input[0]).toBe(project);
  });
  it("uses exact project-scoped intent for pin/section/archive/remove", async () => {
    vi.mocked(workspaceRequest).mockResolvedValue({ ok: true, data: {} });
    await saveSidebarProjectAction(project, "pin");
    expect(workspaceRequest).toHaveBeenLastCalledWith("projects/project-one", { pinned: true });
    await saveSidebarProjectAction(project, "section", "Work");
    expect(workspaceRequest).toHaveBeenLastCalledWith("projects/project-one", { section: "Work" });
    await saveSidebarProjectAction(project, "archiveChats");
    expect(workspaceRequest).toHaveBeenLastCalledWith("projects/project-one/archive-chats", {});
    await saveSidebarProjectAction(project, "remove");
    expect(workspaceRequest).toHaveBeenLastCalledWith("projects/project-one/remove", {});
  });
  it("rejects old runtime capability and surfaces save failures", async () => {
    vi.mocked(workspaceRequest).mockClear();
    await expect(
      saveSidebarProjectAction({ ...project, projectFeatures: {} }, "pin"),
    ).rejects.toThrow("runtime update required");
    expect(workspaceRequest).not.toHaveBeenCalled();
    vi.mocked(workspaceRequest).mockResolvedValueOnce({ ok: false, reason: "Project archived" });
    await expect(saveSidebarProjectAction(project, "pin")).rejects.toThrow("Project archived");
  });
});
