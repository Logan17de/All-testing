import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  DURABLE_PROJECT_MEMORIES_MIGRATION,
  DurableMemoryError,
  MEMORY_BODY_MAX_LENGTH,
  PROJECT_MEMORIES_TABLE,
  createMemory,
  forgetMemory,
  listMemories,
  readMemory,
  updateMemory,
} from "./durable-memory-records.js";
import {
  DURABLE_PROJECTS_MIGRATION,
  archiveProject,
  createProject,
} from "./durable-project-records.js";
import {
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  runSqliteMigrations,
} from "./index.js";
import { SortableIdGenerator } from "./sortable-id.js";

interface Fixture {
  readonly connection: DatabaseSync;
  readonly ids: SortableIdGenerator;
  readonly projectId: string;
}

function fixture(): Fixture {
  const connection = new DatabaseSync(":memory:");
  connection.exec("PRAGMA foreign_keys = ON");
  runSqliteMigrations(connection, [
    DURABLE_GRAPH_IDENTITY_MIGRATION,
    DURABLE_RUNS_MIGRATION,
    DURABLE_PROJECTS_MIGRATION,
    DURABLE_PROJECT_MEMORIES_MIGRATION,
  ]);
  const ids = new SortableIdGenerator();
  const project = createProject(connection, {
    projectId: ids.next(),
    name: "Harness",
    nowMs: 1_000,
  });
  return { connection, ids, projectId: project.projectId };
}

describe("project memories", () => {
  it("remembers something, reads it back and lists pinned memories first", () => {
    const { connection, ids, projectId } = fixture();

    const note = createMemory(connection, {
      memoryId: ids.next(),
      projectId,
      title: "Deploys happen on Thursdays",
      body: "Release windows are Thursday afternoons, never Fridays.",
      kind: "fact",
      nowMs: 2_000,
    });
    expect(note).toMatchObject({
      projectId,
      kind: "fact",
      pinned: false,
      source: "person",
      sourceRunId: null,
      createdAtMs: 2_000,
      updatedAtMs: 2_000,
    });
    expect(readMemory(connection, note.memoryId)).toEqual(note);

    const older = createMemory(connection, {
      memoryId: ids.next(),
      projectId,
      title: "Prefers short replies",
      body: "Answer in a few lines unless asked for detail.",
      kind: "preference",
      pinned: true,
      nowMs: 1_500,
    });

    // Pinned first, then most recently changed, which is also the recall order.
    expect(listMemories(connection, projectId).map((memory) => memory.memoryId)).toEqual([
      older.memoryId,
      note.memoryId,
    ]);
    expect(
      listMemories(connection, projectId, { pinnedOnly: true }).map((memory) => memory.title),
    ).toEqual(["Prefers short replies"]);
    expect(listMemories(connection, projectId, { kind: "fact" })).toHaveLength(1);
    expect(listMemories(connection, projectId, { limit: 1 })).toHaveLength(1);
  });

  it("changes what a memory says, pins it, and forgets it outright", () => {
    const { connection, ids, projectId } = fixture();
    const memory = createMemory(connection, {
      memoryId: ids.next(),
      projectId,
      title: "Staging URL",
      body: "https://staging.example",
      nowMs: 2_000,
    });

    const changed = updateMemory(connection, memory.memoryId, {
      body: "https://staging.example/app",
      pinned: true,
      nowMs: 3_000,
    });
    expect(changed).toMatchObject({
      title: "Staging URL",
      body: "https://staging.example/app",
      pinned: true,
      updatedAtMs: 3_000,
    });
    expect(updateMemory(connection, ids.next(), { pinned: true, nowMs: 3_000 })).toBeUndefined();
    expect(() => updateMemory(connection, memory.memoryId, { nowMs: 3_000 })).toThrow(
      DurableMemoryError,
    );

    expect(forgetMemory(connection, memory.memoryId)).toBe(true);
    expect(forgetMemory(connection, memory.memoryId)).toBe(false);
    expect(readMemory(connection, memory.memoryId)).toBeUndefined();
    expect(
      connection.prepare(`SELECT COUNT(*) AS count FROM ${PROJECT_MEMORIES_TABLE}`).get(),
    ).toEqual({ count: 0 });
  });

  it("refuses empty or oversized text, an unknown or archived project, and a run on a person's memory", () => {
    const { connection, ids, projectId } = fixture();
    const write = (input: Record<string, unknown>) =>
      createMemory(connection, {
        memoryId: ids.next(),
        projectId,
        title: "A title",
        body: "A body",
        nowMs: 2_000,
        ...input,
      });

    expect(() => write({ title: "   " })).toThrow(DurableMemoryError);
    expect(() => write({ body: "x".repeat(MEMORY_BODY_MAX_LENGTH + 1) })).toThrow(
      DurableMemoryError,
    );
    expect(() => write({ sourceRunId: "run-1" })).toThrow(DurableMemoryError);
    expect(() => write({ projectId: ids.next() })).toThrow(
      expect.objectContaining({ code: "PROJECT_NOT_FOUND" }) as Error,
    );

    archiveProject(connection, projectId, 4_000);
    expect(() => write({})).toThrow(expect.objectContaining({ code: "PROJECT_ARCHIVED" }) as Error);
  });

  it("keeps a memory's identity when it is changed", () => {
    const { connection, ids, projectId } = fixture();
    const memory = createMemory(connection, {
      memoryId: ids.next(),
      projectId,
      title: "Keep me",
      body: "Unchanged identity.",
      nowMs: 2_000,
    });
    expect(() =>
      connection
        .prepare(`UPDATE ${PROJECT_MEMORIES_TABLE} SET created_at_ms = 1 WHERE memory_id = ?`)
        .run(memory.memoryId),
    ).toThrow();
  });
});
