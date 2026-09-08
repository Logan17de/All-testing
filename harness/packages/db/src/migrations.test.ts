import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { SCHEMA_MIGRATIONS_TABLE, runSqliteMigrations, type SqliteMigration } from "./index.js";

const migrations: readonly SqliteMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: "create_items",
    sql: "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
  }),
  Object.freeze({
    version: 2,
    name: "seed_items",
    sql: "INSERT INTO items(value) VALUES ('ready')",
  }),
]);

const withDatabase = (run: (connection: DatabaseSync) => void): void => {
  const connection = new DatabaseSync(":memory:", {
    allowExtension: false,
    enableForeignKeyConstraints: false,
  });

  try {
    run(connection);
  } finally {
    connection.close();
  }
};

describe("runSqliteMigrations", () => {
  it("creates schema_migrations even when the application catalog is empty", () => {
    withDatabase((connection) => {
      expect(runSqliteMigrations(connection, [])).toEqual({
        appliedVersions: [],
        currentVersion: 0,
      });

      expect(
        connection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(SCHEMA_MIGRATIONS_TABLE),
      ).toEqual({ name: SCHEMA_MIGRATIONS_TABLE });
      expect(
        connection.prepare(`SELECT COUNT(*) AS count FROM ${SCHEMA_MIGRATIONS_TABLE}`).get(),
      ).toEqual({
        count: 0,
      });
    });
  });

  it("applies pending migrations in catalog order and records them atomically", () => {
    withDatabase((connection) => {
      let now = 1_000;
      const result = runSqliteMigrations(connection, migrations, {
        now: () => {
          const value = now;
          now += 1;
          return value;
        },
      });

      expect(result).toEqual({ appliedVersions: [1, 2], currentVersion: 2 });
      expect(connection.prepare("SELECT value FROM items").all()).toEqual([{ value: "ready" }]);
      expect(
        connection
          .prepare(
            `SELECT version, name, applied_at_ms AS appliedAtMs FROM ${SCHEMA_MIGRATIONS_TABLE} ORDER BY version`,
          )
          .all(),
      ).toEqual([
        { version: 1, name: "create_items", appliedAtMs: 1_000 },
        { version: 2, name: "seed_items", appliedAtMs: 1_001 },
      ]);
    });
  });

  it("is idempotent when the complete migration catalog is already applied", () => {
    withDatabase((connection) => {
      runSqliteMigrations(connection, migrations, { now: () => 100 });

      const result = runSqliteMigrations(connection, migrations, {
        now: () => {
          throw new Error("clock should not be called when nothing is pending");
        },
      });

      expect(result).toEqual({ appliedVersions: [], currentVersion: 2 });
      expect(
        connection.prepare(`SELECT COUNT(*) AS count FROM ${SCHEMA_MIGRATIONS_TABLE}`).get(),
      ).toEqual({
        count: 2,
      });
    });
  });

  it("rolls back both SQL effects and migration history when a migration fails", () => {
    withDatabase((connection) => {
      const failing: readonly SqliteMigration[] = [
        {
          version: 1,
          name: "broken",
          sql: `
            CREATE TABLE should_rollback(value TEXT NOT NULL);
            INSERT INTO missing_table(value) VALUES ('boom');
          `,
        },
      ];

      expect(() => runSqliteMigrations(connection, failing, { now: () => 10 })).toThrow();
      expect(
        connection
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        connection.prepare(`SELECT COUNT(*) AS count FROM ${SCHEMA_MIGRATIONS_TABLE}`).get(),
      ).toEqual({
        count: 0,
      });
    });
  });

  it("rejects invalid or reordered catalogs before applying application SQL", () => {
    withDatabase((connection) => {
      expect(() =>
        runSqliteMigrations(connection, [
          { version: 2, name: "second", sql: "SELECT 1" },
          { version: 1, name: "first", sql: "SELECT 1" },
        ]),
      ).toThrow("strictly increasing");

      expect(() =>
        runSqliteMigrations(connection, [{ version: 0, name: "zero", sql: "SELECT 1" }]),
      ).toThrow("positive safe-integer version");
      expect(() =>
        runSqliteMigrations(connection, [{ version: 1, name: " ", sql: "SELECT 1" }]),
      ).toThrow("must have a name");
      expect(() =>
        runSqliteMigrations(connection, [{ version: 1, name: "empty", sql: "   " }]),
      ).toThrow("must contain SQL");

      expect(
        connection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'")
          .get(),
      ).toBeUndefined();
    });
  });

  it("rejects migration history that is newer than or different from the runtime catalog", () => {
    withDatabase((connection) => {
      runSqliteMigrations(connection, migrations, { now: () => 50 });

      expect(() => runSqliteMigrations(connection, migrations.slice(0, 1))).toThrow(
        "newer than this runtime migration catalog",
      );

      expect(() =>
        runSqliteMigrations(connection, [
          { version: 1, name: "renamed", sql: migrations[0]?.sql ?? "SELECT 1" },
          migrations[1] ?? { version: 2, name: "seed_items", sql: "SELECT 1" },
        ]),
      ).toThrow("does not match the ordered runtime migration catalog");
    });
  });

  it("rejects an invalid migration clock without starting the migration transaction", () => {
    withDatabase((connection) => {
      expect(() =>
        runSqliteMigrations(connection, migrations.slice(0, 1), { now: () => -1 }),
      ).toThrow("migration clock must return a non-negative safe integer");
      expect(
        connection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'")
          .get(),
      ).toBeUndefined();
      expect(
        connection.prepare(`SELECT COUNT(*) AS count FROM ${SCHEMA_MIGRATIONS_TABLE}`).get(),
      ).toEqual({
        count: 0,
      });
    });
  });
});
