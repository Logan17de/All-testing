import { describe, expect, it, vi } from "vitest";
import {
  openProjectExplorer,
  projectExplorerAvailability,
  type ProjectExplorerDependencies,
} from "./project-explorer-route";
const id = "01a1112c-b795-7027-8238-9214dc98deb8";
const path = "D:\\fixture\\project";
function deps(
  project = { projectId: id, status: "active", workspaceTrusted: true, workspacePath: path },
): ProjectExplorerDependencies {
  return {
    available: () => true,
    project: vi.fn(() => Promise.resolve({ status: 200, body: { project } })),
    directory: vi.fn(() => Promise.resolve(path)),
    open: vi.fn(() => Promise.resolve()),
  };
}
function request(body: unknown, origin = "http://127.0.0.1:3005") {
  return new Request("http://127.0.0.1:3005/api/editor/project-explorer", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}
describe("human project Explorer action", () => {
  it("uses only the trusted canonical project directory", async () => {
    const d = deps();
    expect((await openProjectExplorer(request({ projectId: id }), d)).status).toBe(200);
    expect(d.project).toHaveBeenCalledWith(id);
    expect(d.open).toHaveBeenCalledWith(path);
  });
  it("blocks cross-origin requests and arbitrary caller paths before lookup/launch", async () => {
    const d = deps();
    expect(
      (await openProjectExplorer(request({ projectId: id }, "https://example.com"), d)).status,
    ).toBe(403);
    expect(
      (await openProjectExplorer(request({ projectId: id, path: "C:\\other" }), d)).status,
    ).toBe(400);
    expect((await openProjectExplorer(request({ projectId: "../../other" }), d)).status).toBe(400);
    expect(d.project).not.toHaveBeenCalled();
    expect(d.open).not.toHaveBeenCalled();
  });
  it("rejects archived/untrusted projects and changed filesystem roots", async () => {
    for (const project of [
      { projectId: id, status: "archived", workspaceTrusted: true, workspacePath: path },
      { projectId: id, status: "active", workspaceTrusted: false, workspacePath: path },
    ]) {
      const d = deps(project);
      expect((await openProjectExplorer(request({ projectId: id }), d)).status).toBe(409);
      expect(d.open).not.toHaveBeenCalled();
    }
    const d = deps();
    d.directory = () => Promise.resolve("C:\\different");
    expect((await openProjectExplorer(request({ projectId: id }), d)).status).toBe(409);
    expect(d.open).not.toHaveBeenCalled();
  });
  it("requires host enablement and availability never launches a process", async () => {
    const d = deps();
    d.available = () => false;
    expect((await openProjectExplorer(request({ projectId: id }), d)).status).toBe(409);
    expect(
      await projectExplorerAvailability(
        new Request("http://127.0.0.1:3005/api/editor/project-explorer"),
        d,
      ).json(),
    ).toEqual({ available: false });
    expect(d.open).not.toHaveBeenCalled();
  });
});
