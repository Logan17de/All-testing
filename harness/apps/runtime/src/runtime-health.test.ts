import {
  SCHEMA_MIGRATIONS_TABLE,
  SQLITE_MEMORY_PATH,
  SqliteDatabase,
  runSqliteMigrations,
  type SqliteMigration,
} from "@zet-harness/db";
import { describe, expect, it } from "vitest";

import { inspectRuntimeHealth } from "./runtime-health.js";

const migrations: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "health_probe",
    sql: "CREATE TABLE health_probe(value TEXT NOT NULL)",
  },
];

describe("inspectRuntimeHealth", () => {
  it("reports a running runtime with a responsive database and exact migration catalog as healthy", () => {
    const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    database.open();

    try {
      runSqliteMigrations(database.connection(), migrations, { now: () => 1 });

      expect(
        inspectRuntimeHealth({
          runtimeState: "running",
          database,
          migrations,
        }),
      ).toEqual({
        status: "ok",
        service: "zet-harness-runtime",
        checks: {
          runtime: { status: "ok", state: "running" },
          database: {
            status: "ok",
            state: "open",
            query: "ok",
            migrations: {
              status: "ok",
              appliedCount: 1,
              expectedCount: 1,
              appliedVersion: 1,
              expectedVersion: 1,
            },
          },
        },
      });
    } finally {
      database.close();
    }
  });

  it("reports migration drift without leaking database errors", () => {
    const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    database.open();

    try {
      runSqliteMigrations(database.connection(), migrations, { now: () => 1 });
      database.connection().prepare(`DELETE FROM ${SCHEMA_MIGRATIONS_TABLE}`).run();

      expect(
        inspectRuntimeHealth({
          runtimeState: "running",
          database,
          migrations,
        }),
      ).toEqual({
        status: "unhealthy",
        service: "zet-harness-runtime",
        checks: {
          runtime: { status: "ok", state: "running" },
          database: {
            status: "unhealthy",
            state: "open",
            query: "ok",
            migrations: {
              status: "unhealthy",
              appliedCount: 0,
              expectedCount: 1,
              appliedVersion: null,
              expectedVersion: 1,
            },
          },
        },
      });
    } finally {
      database.close();
    }
  });

  it("reports closed database and non-running lifecycle states as unhealthy without opening resources", () => {
    const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });

    expect(
      inspectRuntimeHealth({
        runtimeState: "idle",
        database,
        migrations,
      }),
    ).toEqual({
      status: "unhealthy",
      service: "zet-harness-runtime",
      checks: {
        runtime: { status: "unhealthy", state: "idle" },
        database: {
          status: "unhealthy",
          state: "closed",
          query: "error",
          migrations: {
            status: "unhealthy",
            appliedCount: 0,
            expectedCount: 1,
            appliedVersion: null,
            expectedVersion: 1,
          },
        },
      },
    });
    expect(database.snapshot().state).toBe("closed");
  });
});
