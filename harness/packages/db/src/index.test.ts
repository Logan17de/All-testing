import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SQLITE_MEMORY_PATH, SqliteDatabase, type SqliteCommitCallback } from "./index.js";

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

  it("serializes queued commits in FIFO order and returns each callback result", async () => {
    const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    database.open();
    database.connection().exec("CREATE TABLE commit_order(position INTEGER, label TEXT)");

    try {
      const observed: string[] = [];
      const first = database.commit((connection) => {
        observed.push("first");
        connection
          .prepare("INSERT INTO commit_order(position, label) VALUES (?, ?)")
          .run(1, "first");
        return "one";
      });
      const second = database.commit((connection) => {
        observed.push("second");
        connection
          .prepare("INSERT INTO commit_order(position, label) VALUES (?, ?)")
          .run(2, "second");
        return "two";
      });
      const third = database.commit((connection) => {
        observed.push("third");
        connection
          .prepare("INSERT INTO commit_order(position, label) VALUES (?, ?)")
          .run(3, "third");
        return "three";
      });

      expect(observed).toEqual([]);
      await expect(Promise.all([first, second, third])).resolves.toEqual(["one", "two", "three"]);
      expect(observed).toEqual(["first", "second", "third"]);
      expect(
        database
          .connection()
          .prepare("SELECT position, label FROM commit_order ORDER BY position")
          .all(),
      ).toEqual([
        { position: 1, label: "first" },
        { position: 2, label: "second" },
        { position: 3, label: "third" },
      ]);
    } finally {
      database.close();
    }
  });

  it("rolls back a failed commit and keeps later queued writes runnable", async () => {
    const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    database.open();
    database.connection().exec("CREATE TABLE durable_values(value TEXT NOT NULL)");

    try {
      const failed = database.commit((connection) => {
        connection.prepare("INSERT INTO durable_values(value) VALUES (?)").run("rolled-back");
        throw new TypeError("commit failed");
      });
      const afterFailure = database.commit((connection) => {
        connection.prepare("INSERT INTO durable_values(value) VALUES (?)").run("committed");
        return 7;
      });

      await expect(failed).rejects.toThrow("commit failed");
      await expect(afterFailure).resolves.toBe(7);
      expect(database.connection().prepare("SELECT value FROM durable_values").all()).toEqual([
        { value: "committed" },
      ]);
    } finally {
      database.close();
    }
  });

  it("rejects nested commits before another transaction can enter the queue", async () => {
    const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    database.open();

    try {
      await expect(
        database.commit(() => {
          expect(() => database.commit(() => undefined)).toThrow(
            "Nested SQLite commits are not allowed.",
          );
          return "outer";
        }),
      ).resolves.toBe("outer");
    } finally {
      database.close();
    }
  });

  it("rejects promise-returning commit callbacks as a runtime safety backstop", async () => {
    const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    database.open();

    try {
      const unsafeAsyncWrite = (() =>
        Promise.resolve("async")) as unknown as SqliteCommitCallback<string>;

      await expect(database.commit(unsafeAsyncWrite)).rejects.toThrow(
        "SQLite commit callbacks must be synchronous",
      );
    } finally {
      database.close();
    }
  });

  it("refuses to close with queued writes and exposes an explicit drain boundary", async () => {
    const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    database.open();

    const pending = database.commit(() => "done");
    expect(() => database.close()).toThrow(
      "SQLite database cannot close while serialized writes are pending; await drainWrites() first.",
    );

    await expect(database.drainWrites()).resolves.toBeUndefined();
    await expect(pending).resolves.toBe("done");
    expect(database.close()).toBe(true);
  });

  it("requires an open database before accepting a serialized commit", () => {
    const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    expect(() => database.commit(() => undefined)).toThrow("SQLite database is not open.");
  });

  it("rejects an empty path before touching SQLite", () => {
    expect(() => new SqliteDatabase({ path: "   " })).toThrow(
      "SQLite database path must not be empty.",
    );
  });
});
