/**
 * The folders this harness works in.
 *
 * One is open at a time. A project belongs to the folder it was created in, so
 * the Projects page shows the open folder's projects and says when others exist
 * elsewhere.
 */

export interface WorkspaceEntry {
  readonly path: string;
  /** False when the folder was chosen once and has since gone. */
  readonly exists: boolean;
  readonly current: boolean;
  readonly openedAtMs: number;
}

export function isWorkspaceEntry(value: unknown): value is WorkspaceEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["path"] === "string" &&
    typeof record["exists"] === "boolean" &&
    typeof record["current"] === "boolean"
  );
}

/** Whether a project made in `projectPath` belongs to the folder `workspacePath`. */
export function inWorkspace(projectPath: string | null, workspacePath: string | null): boolean {
  if (workspacePath === null) return true;
  if (projectPath === null) return false;
  const left = normalize(projectPath);
  const right = normalize(workspacePath);
  return left === right || left.startsWith(`${right}/`);
}

/** Compare paths the way both Windows and POSIX write them, without case folding. */
function normalize(path: string): string {
  return path.replace(/\\/gu, "/").replace(/\/+$/u, "");
}
