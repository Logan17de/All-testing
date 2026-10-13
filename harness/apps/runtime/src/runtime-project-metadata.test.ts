import { describe, expect, it } from "vitest";
import { SqliteDatabase, SQLITE_MEMORY_PATH, runSqliteMigrations } from "@zet-harness/db";
import { createProject } from "@zet-harness/db/durable-project-records";
import { createSortableId } from "@zet-harness/db/sortable-id";
import { writeSetting } from "@zet-harness/db/durable-setting-records";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import {
  projectWithMetadata,
  readProjectMetadata,
  writeProjectMetadata,
} from "./runtime-project-metadata.js";

describe("project metadata compatibility", () => {
  it("falls back for old or invalid metadata and never infers workspace trust", () => {
    const db = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    db.open();
    runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
    try {
      const project = createProject(db.connection(), {
        projectId: createSortableId(),
        name: "Legacy",
        workspacePath: "D:\\fixture",
        nowMs: 1,
      });
      expect(projectWithMetadata(db.connection(), project)).toMatchObject({
        pinned: false,
        section: null,
        sourceFolders: ["D:\\fixture"],
        workspaceTrusted: false,
      });
      writeProjectMetadata(
        db.connection(),
        project.projectId,
        { pinned: true, section: "Work", sourceFolders: ["D:\\fixture", "D:\\extra"] },
        2,
      );
      expect(projectWithMetadata(db.connection(), project)).toMatchObject({
        pinned: true,
        section: "Work",
        sourceFolders: ["D:\\fixture", "D:\\extra"],
        workspaceTrusted: false,
      });
      db.connection()
        .prepare("UPDATE app_settings SET value_json=? WHERE key=?")
        .run(
          JSON.stringify({ sourceFolders: ["D:\\wrong"], pinned: false, section: 42 }),
          `project.metadata.${project.projectId}`,
        );
      expect(readProjectMetadata(db.connection(), project)).toEqual({
        pinned: false,
        section: null,
        sourceFolders: ["D:\\fixture"],
      });
      writeSetting(db.connection(), `project.trusted.${project.projectId}`, "D:\\wrong", 3);
      expect(projectWithMetadata(db.connection(), project).workspaceTrusted).toBe(false);
      writeSetting(db.connection(), `project.trusted.${project.projectId}`, "D:\\fixture", 4);
      expect(projectWithMetadata(db.connection(), project).workspaceTrusted).toBe(true);
      expect(
        projectWithMetadata(db.connection(), { ...project, workspacePath: null }).workspaceTrusted,
      ).toBe(false);
    } finally {
      db.close();
    }
  });
});
