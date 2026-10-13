import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initialProjectFolders,
  foldersNeedingTrust,
  projectEditPayload,
  saveProjectEdit,
  ProjectEditDialog,
  type EditableProject,
} from "./project-edit-dialog";
import { workspaceRequest } from "../../lib/workspace-client";
vi.mock("../../lib/workspace-client", () => ({ workspaceRequest: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const project: EditableProject = {
  projectId: "project-id",
  name: "Fixture",
  workspacePath: "D:\\first",
  sourceFolders: ["D:\\first", "D:\\second"],
  projectFeatures: { sourceFolders: true, edit: true, remove: true },
};
describe("project edit scope and explicit folder trust", () => {
  it("falls back to existing primary and preserves folders on name-only changes without new trust", () => {
    expect(
      initialProjectFolders({ projectId: "old", name: "Old", workspacePath: "D:\\old" }),
    ).toEqual(["D:\\old"]);
    expect(projectEditPayload(project, " Renamed ", ["D:\\first", "D:\\second"], [])).toEqual({
      name: "Renamed",
      sourceFolders: ["D:\\first", "D:\\second"],
    });
    expect(projectEditPayload(project, "Fixture", ["D:\\first"], [])).not.toHaveProperty("trusted");
  });
  it("requires trust for newly added roots and for an existing secondary becoming primary", () => {
    expect(foldersNeedingTrust(project, ["D:\\second"])).toEqual(["D:\\second"]);
    expect(() => projectEditPayload(project, "Fixture", ["D:\\second"], [])).toThrow(
      "Trust each added folder",
    );
    expect(projectEditPayload(project, "Fixture", ["D:\\second"], ["D:\\second"])).toEqual({
      name: "Fixture",
      sourceFolders: ["D:\\second"],
      trusted: true,
    });
    expect(() => projectEditPayload(project, "Fixture", ["D:\\first", "D:\\new"], [])).toThrow();
    expect(
      projectEditPayload(project, "Fixture", ["D:\\first", "D:\\new"], ["D:\\new"]),
    ).toHaveProperty("trusted", true);
  });
  it("refuses empty/overlong names, no source folder and duplicate or excessive roots", () => {
    for (const name of [" ", "x".repeat(201)])
      expect(() => projectEditPayload(project, name, ["D:\\first"], [])).toThrow();
    for (const folders of [
      [],
      ["D:\\first", "D:\\first"],
      Array.from({ length: 21 }, (_, i) => `D:\\folder${i}`),
    ])
      expect(() => projectEditPayload(project, "Fixture", folders, folders)).toThrow();
  });
  it("sends only validated project metadata and keeps backend failures visible", async () => {
    vi.mocked(workspaceRequest).mockResolvedValueOnce({ ok: true, data: {} });
    await saveProjectEdit(project, "Renamed", ["D:\\first"], []);
    expect(workspaceRequest).toHaveBeenCalledExactlyOnceWith("projects/project-id", {
      name: "Renamed",
      sourceFolders: ["D:\\first"],
    });
    vi.mocked(workspaceRequest).mockResolvedValueOnce({
      ok: false,
      reason: "Folder identity changed",
    });
    await expect(saveProjectEdit(project, "Renamed", ["D:\\first"], [])).rejects.toThrow(
      "Folder identity changed",
    );
    await expect(
      saveProjectEdit({ ...project, projectFeatures: {} }, "Renamed", ["D:\\first"], []),
    ).rejects.toThrow("runtime update required");
  });
  it("renders native dialog with exact folder removal labels and no implicit save/removal", () => {
    const onSaved = vi.fn();
    const onRemoveRequested = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ProjectEditDialog, { project, onClose: vi.fn(), onSaved, onRemoveRequested }),
    );
    expect(html).toContain("<dialog");
    expect(html).toContain("Edit project");
    expect(html).toContain('aria-label="Remove source folder D:\\first"');
    expect(html).toContain("Primary folder");
    expect(html).toContain("files remain on disk");
    expect(html).toContain("Add folder");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onRemoveRequested).not.toHaveBeenCalled();
    expect(workspaceRequest).not.toHaveBeenCalled();
  });
});
