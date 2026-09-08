import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SQLITE_MEMORY_PATH, SqliteDatabase } from "./index.js";

describe("SqliteDatabase", () => {
  it("opens and closes an in-memory node:sqlite connection idempotently", () => {
    const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });

    expect(database.snapshot()).toEqual({
      state: "closed",
      path: SQLITE_MEMORY_PATH,
      inMemory: true,
    });

    expect(database.open()).toBe(true);
    expect(database.open()).toBe(false);
    expect(database.snapshot().state).toBe("open");
    expect(database.connection().isOpen).toBe(true);
    expect(database.connection().prepare("SELECT 1 AS ok").get()).toEqual({ ok: 1 });

    expect(database.close()).toBe(true);
    expect(database.close()).toBe(false);
    expect(database.snapshot().state).toBe("closed");
    expect(() => database.connection()).toThrow("SQLite database is not open.");
  });

  it("enforces foreign keys on every opened connection", () => {
    const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    database.open();

    try {
      expect(database.connection().prepare("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });

      database.connection().exec(`
        CREATE TABLE parent(id INTEGER PRIMARY KEY);
        CREATE TABLE child(
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parent(id)
        );
      `);

      expect(() =>
        database.connection().exec("INSERT INTO child(id, parent_id) VALUES (1, 999)"),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("keeps the SQLite memory journal for in-memory databases", () => {
    const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    database.open();

    try {
      expect(database.connection().prepare("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "memory",
      });
    } finally {
      database.close();
    }
  });

  it("enables persistent WAL mode for file-backed databases and may reopen them", () => {
    const root = mkdtempSync(join(tmpdir(), "zet-harness-db-"));
    const path = join(root, "nested", "runtime.sqlite");
    const database = new SqliteDatabase({ path });

    try {
      expect(database.open()).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(database.connection().prepare("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      expect(database.connection().prepare("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });

      database.connection().exec("CREATE TABLE probe(value TEXT NOT NULL)");
      database.connection().exec("INSERT INTO probe(value) VALUES ('persisted')");
      expect(database.close()).toBe(true);

      expect(database.open()).toBe(true);
      expect(database.connection().prepare("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      expect(database.connection().prepare("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
      expect(database.connection().prepare("SELECT value FROM probe").get()).toEqual({
        value: "persisted",
      });
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an empty path before touching SQLite", () => {
    expect(() => new SqliteDatabase({ path: "   " })).toThrow(
      "SQLite database path must not be empty.",
    );
  });
});
