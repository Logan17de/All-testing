import type { SettingStatementRunner } from "@zet-harness/db/durable-setting-records";
import type { DurableProjectRecord } from "@zet-harness/db/durable-project-records";
import { SORTABLE_ID_PATTERN } from "@zet-harness/db/sortable-id";
import { readSetting } from "@zet-harness/db/durable-setting-records";

export const PROJECT_FEATURES = Object.freeze({
  pin: true,
  edit: true,
  section: true,
  sourceFolders: true,
  archiveChats: true,
  remove: true,
  openExplorer: false,
});
export interface ProjectMetadata {
  pinned: boolean;
  section: string | null;
  sourceFolders: string[];
}
function key(id: string): string {
  if (!SORTABLE_ID_PATTERN.test(id)) throw new Error("Invalid project id.");
  return `project.metadata.${id}`;
}
export function readProjectMetadata(
  db: SettingStatementRunner,
  project: DurableProjectRecord,
): ProjectMetadata {
  const fallback = {
    pinned: false,
    section: null,
    sourceFolders: project.workspacePath ? [project.workspacePath] : [],
  };
  const row = db
    .prepare("SELECT value_json FROM app_settings WHERE key=?")
    .get(key(project.projectId));
  if (!row || typeof row["value_json"] !== "string") return fallback;
  let value: unknown;
  try {
    value = JSON.parse(row["value_json"]);
  } catch {
    return fallback;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const data = value as Record<string, unknown>;
  return {
    pinned: data.pinned === true,
    section: typeof data.section === "string" && data.section.length <= 80 ? data.section : null,
    sourceFolders:
      Array.isArray(data.sourceFolders) &&
      data.sourceFolders.length <= 20 &&
      data.sourceFolders.every((v: unknown) => typeof v === "string") &&
      data.sourceFolders[0] === project.workspacePath
        ? data.sourceFolders
        : fallback.sourceFolders,
  };
}
export function writeProjectMetadata(
  db: SettingStatementRunner,
  projectId: string,
  metadata: ProjectMetadata,
  nowMs: number,
): void {
  db.prepare(
    "INSERT INTO app_settings(key,value_json,updated_at_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at_ms=excluded.updated_at_ms",
  ).run(key(projectId), JSON.stringify(metadata), nowMs);
}
export function projectWithMetadata(db: SettingStatementRunner, project: DurableProjectRecord) {
  return {
    ...project,
    ...readProjectMetadata(db, project),
    workspaceTrusted:
      project.workspacePath !== null &&
      readSetting(db, `project.trusted.${project.projectId}`)?.value === project.workspacePath,
  };
}
