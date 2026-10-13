import { realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { SORTABLE_ID_SOURCE } from "./ids";
import { guardLocalRequest, readJsonObject } from "./local-request-guard";
import { getFromRuntime } from "./runtime-client";

const EXPLORER = "C:\\Windows\\explorer.exe";
const ID = new RegExp(`^${SORTABLE_ID_SOURCE}$`, "u");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const error = (status: number, reason: string) =>
  Response.json(
    { error: { code: "PROJECT_EXPLORER_UNAVAILABLE", reason } },
    { status, headers: { "cache-control": "no-store" } },
  );

export interface ProjectExplorerDependencies {
  available: () => boolean;
  project: (id: string) => Promise<{ status: number; body: unknown }>;
  directory: (path: string) => Promise<string>;
  open: (path: string) => Promise<void>;
}
export const projectExplorerDependencies: ProjectExplorerDependencies = {
  available: () =>
    process.platform === "win32" && process.env.ZET_UI_ALLOW_PROJECT_EXPLORER === "true",
  project: (id) => getFromRuntime(`/api/projects/${id}`),
  directory: async (path) => {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("Project folder is unavailable.");
    return canonical;
  },
  open: async (path) => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(EXPLORER, [path], { shell: false, windowsHide: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  },
};

export function projectExplorerAvailability(
  request: Request,
  dependencies = projectExplorerDependencies,
) {
  const rejected = guardLocalRequest(request, "read");
  return (
    rejected ??
    Response.json(
      { available: dependencies.available() },
      { headers: { "cache-control": "no-store" } },
    )
  );
}
export async function openProjectExplorer(
  request: Request,
  dependencies = projectExplorerDependencies,
) {
  const rejected = guardLocalRequest(request, "mutation");
  if (rejected) return rejected;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (
    Object.keys(body).length !== 1 ||
    typeof body.projectId !== "string" ||
    !ID.test(body.projectId)
  )
    return error(400, "Select a valid project.");
  if (!dependencies.available()) return error(409, "Open in Explorer is not enabled on this host.");
  const result = await dependencies.project(body.projectId);
  if (result.status !== 200) return error(result.status, "Project could not be loaded.");
  const project = record(record(result.body).project);
  if (
    project.projectId !== body.projectId ||
    project.status !== "active" ||
    project.workspaceTrusted !== true ||
    typeof project.workspacePath !== "string"
  )
    return error(409, "Trust this active project's folder before opening it.");
  try {
    const canonical = await dependencies.directory(project.workspacePath);
    if (canonical !== project.workspacePath)
      return error(409, "The project folder changed. Review its trust first.");
    await dependencies.open(canonical);
    return Response.json({ requested: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return error(409, "Explorer could not open the project folder.");
  }
}
