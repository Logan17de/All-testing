import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  DURABLE_PROJECTS_MIGRATION,
  DurableProjectError,
  PROJECTS_TABLE,
  archiveProject,
  createProject,
  listProjects,
  readProject,
  restoreProject,
  updateProject,
} from "./durable-project-records.js";
import { runSqliteMigrations } from "./migrations.js";
import { SortableIdGenerator } from "./sortable-id.js";

const withDatabase = (run: (connection: DatabaseSync, ids: SortableIdGenerator) => void): void => {
  const connection = new DatabaseSync(":memory:", {
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });
  try {
    runSqliteMigrations(connection, [DURABLE_PROJECTS_MIGRATION], { now: () => 1 });
    run(connection, new SortableIdGenerator({ now: () => 1_000 }));
  } finally {
    connection.close();
  }
};

function failure(action: () => unknown): DurableProjectError {
  try {
    action();
  } catch (error) {
    if (error instanceof DurableProjectError) return error;
    throw error;
  }
  throw new Error("Expected the project write to be refused.");
}

describe("durable projects", () => {
  it("creates a project and reads it back", () => {
    withDatabase((connection, ids) => {
      const projectId = ids.next();
      const created = createProject(connection, {
        projectId,
        name: "  Website  ",
        description: "Landing page",
        workspacePath: "/work/site",
        nowMs: 10,
      });

      expect(created).toEqual({
        projectId,
        name: "Website",
        description: "Landing page",
        workspacePath: "/work/site",
        status: "active",
        createdAtMs: 10,
        updatedAtMs: 10,
        archivedAtMs: null,
      });
      expect(readProject(connection, projectId)).toEqual(created);
      expect(readProject(connection, ids.next())).toBeUndefined();
    });
  });

  it("lists the most recently changed projects first, filtered by status", () => {
    withDatabase((connection, ids) => {
      const a = createProject(connection, { projectId: ids.next(), name: "A", nowMs: 10 });
      const b = createProject(connection, { projectId: ids.next(), name: "B", nowMs: 20 });
      const c = createProject(connection, { projectId: ids.next(), name: "C", nowMs: 30 });
      updateProject(connection, a.projectId, { description: "touched", nowMs: 40 });
      archiveProject(connection, b.projectId, 50);

      const names = (status?: "active" | "archived" | "all") =>
        listProjects(connection, status === undefined ? {} : { status }).map(
          (project) => project.name,
        );
      expect(names()).toEqual(["A", "C"]);
      expect(names("archived")).toEqual(["B"]);
      expect(names("all")).toEqual(["B", "A", "C"]);
      expect(listProjects(connection, { status: "all", limit: 1 })).toHaveLength(1);
      expect(c.status).toBe("active");
    });
  });

  it("refuses invalid names, descriptions, workspace paths, ids and times", () => {
    withDatabase((connection, ids) => {
      const base = { projectId: ids.next(), name: "Valid", nowMs: 1 };

      expect(failure(() => createProject(connection, { ...base, name: "   " }))).toMatchObject({
        code: "PROJECT_INVALID",
        field: "name",
      });
      expect(
        failure(() => createProject(connection, { ...base, name: "x".repeat(201) })),
      ).toMatchObject({ field: "name" });
      expect(
        failure(() => createProject(connection, { ...base, description: "x".repeat(4_001) })),
      ).toMatchObject({ field: "description" });
      expect(
        failure(() => createProject(connection, { ...base, workspacePath: "relative/folder" })),
      ).toMatchObject({ field: "workspacePath" });
      expect(
        failure(() => createProject(connection, { ...base, projectId: "not-an-id" })),
      ).toMatchObject({ field: "projectId" });
      expect(failure(() => createProject(connection, { ...base, nowMs: -1 }))).toMatchObject({
        field: "nowMs",
      });

      const windows = createProject(connection, {
        ...base,
        workspacePath: "C:\\work\\site",
      });
      expect(windows.workspacePath).toBe("C:\\work\\site");
      const blank = createProject(connection, {
        projectId: ids.next(),
        name: "Blank path",
        workspacePath: "   ",
        nowMs: 1,
      });
      expect(blank.workspacePath).toBeNull();
    });
  });

  it("changes an active project, refuses changes once archived, and restores it", () => {
    withDatabase((connection, ids) => {
      const { projectId } = createProject(connection, {
        projectId: ids.next(),
        name: "Site",
        nowMs: 10,
      });

      expect(
        updateProject(connection, projectId, {
          name: "Marketing site",
          workspacePath: "/w",
          nowMs: 20,
        }),
      ).toMatchObject({ name: "Marketing site", workspacePath: "/w", updatedAtMs: 20 });
      expect(
        updateProject(connection, projectId, { workspacePath: null, nowMs: 21 }),
      ).toMatchObject({ workspacePath: null });

      const archived = archiveProject(connection, projectId, 30);
      expect(archived).toMatchObject({ status: "archived", archivedAtMs: 30, updatedAtMs: 30 });
      expect(archiveProject(connection, projectId, 40)).toEqual(archived);
      expect(
        failure(() => updateProject(connection, projectId, { name: "Again", nowMs: 45 })),
      ).toMatchObject({ code: "PROJECT_ARCHIVED" });

      expect(restoreProject(connection, projectId, 50)).toMatchObject({
        status: "active",
        archivedAtMs: null,
        updatedAtMs: 50,
      });
      expect(readProject(connection, projectId)).toMatchObject({
        status: "active",
        name: "Marketing site",
      });

      const missing = ids.next();
      expect(updateProject(connection, missing, { name: "Nope", nowMs: 60 })).toBeUndefined();
      expect(archiveProject(connection, missing, 60)).toBeUndefined();
      expect(restoreProject(connection, missing, 60)).toBeUndefined();
    });
  });

  it("never moves a project back in time when the clock steps backwards", () => {
    withDatabase((connection, ids) => {
      const { projectId } = createProject(connection, {
        projectId: ids.next(),
        name: "Clock",
        nowMs: 100,
      });

      expect(updateProject(connection, projectId, { name: "Later", nowMs: 50 })).toMatchObject({
        updatedAtMs: 100,
      });
      expect(archiveProject(connection, projectId, 60)).toMatchObject({ archivedAtMs: 100 });
    });
  });

  it("keeps every project in the table: no deletes, a stable id, and status agreeing with archive time", () => {
    withDatabase((connection, ids) => {
      const { projectId } = createProject(connection, {
        projectId: ids.next(),
        name: "Kept",
        nowMs: 1,
      });

      expect(() =>
        connection.prepare(`DELETE FROM ${PROJECTS_TABLE} WHERE project_id = ?`).run(projectId),
      ).toThrow(/archived, never deleted/u);
      expect(() =>
        connection
          .prepare(`UPDATE ${PROJECTS_TABLE} SET project_id = ? WHERE project_id = ?`)
          .run(ids.next(), projectId),
      ).toThrow(/keeps its id/u);
      expect(() =>
        connection
          .prepare(`UPDATE ${PROJECTS_TABLE} SET status = 'archived' WHERE project_id = ?`)
          .run(projectId),
      ).toThrow(/CHECK constraint failed/u);
    });
  });
});
