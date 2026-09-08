import {
  SCHEMA_MIGRATIONS_TABLE,
  type SqliteDatabase,
  type SqliteMigration,
} from "@zet-harness/db";

export const RUNTIME_HEALTH_SERVICE = "zet-harness-runtime" as const;

export type RuntimeHealthStatus = "ok" | "unhealthy";
export type RuntimeHealthRuntimeState = "idle" | "running" | "stopped";
export type RuntimeHealthDatabaseState = "closed" | "open";
export type RuntimeHealthDatabaseQueryStatus = "ok" | "error";

export interface RuntimeHealthResponse {
  readonly status: RuntimeHealthStatus;
  readonly service: typeof RUNTIME_HEALTH_SERVICE;
  readonly checks?: unknown;
}

export type RuntimeHealthProvider = () => RuntimeHealthResponse;

export interface RuntimeMigrationHealthCheck {
  readonly status: RuntimeHealthStatus;
  readonly appliedCount: number;
  readonly expectedCount: number;
  readonly appliedVersion: number | null;
  readonly expectedVersion: number | null;
}

export interface RuntimeHealthReport extends RuntimeHealthResponse {
  readonly checks: {
    readonly runtime: {
      readonly status: RuntimeHealthStatus;
      readonly state: RuntimeHealthRuntimeState;
    };
    readonly database: {
      readonly status: RuntimeHealthStatus;
      readonly state: RuntimeHealthDatabaseState;
      readonly query: RuntimeHealthDatabaseQueryStatus;
      readonly migrations: RuntimeMigrationHealthCheck;
    };
  };
}

export interface InspectRuntimeHealthOptions {
  readonly runtimeState: RuntimeHealthRuntimeState;
  readonly database: SqliteDatabase;
  readonly migrations: readonly SqliteMigration[];
}

/**
 * Inspect only cheap local readiness signals.
 *
 * The probe performs no writes and intentionally avoids SQLite
 * `quick_check`/`integrity_check` or blob-tree scans on the request path.
 * Backup/restore owns deep integrity verification; health checks only
 * confirm the live connection can answer and its tiny migration history
 * still exactly matches the code-owned runtime catalog.
 */
export function inspectRuntimeHealth(options: InspectRuntimeHealthOptions): RuntimeHealthReport {
  const runtimeStatus: RuntimeHealthStatus =
    options.runtimeState === "running" ? "ok" : "unhealthy";
  const databaseSnapshot = options.database.snapshot();
  const expectedVersion = options.migrations.at(-1)?.version ?? null;

  let queryStatus: RuntimeHealthDatabaseQueryStatus = "error";
  let migrationCheck: RuntimeMigrationHealthCheck = Object.freeze({
    status: "unhealthy",
    appliedCount: 0,
    expectedCount: options.migrations.length,
    appliedVersion: null,
    expectedVersion,
  });

  if (databaseSnapshot.state === "open") {
    const connection = options.database.connection();

    try {
      const row = connection.prepare("SELECT 1 AS ok").get();
      if (row?.ok === 1) {
        queryStatus = "ok";
      }
    } catch {
      queryStatus = "error";
    }

    try {
      const rows = connection
        .prepare(`SELECT version, name FROM ${SCHEMA_MIGRATIONS_TABLE} ORDER BY version ASC`)
        .all();
      const appliedVersion = readAppliedVersion(rows);
      const historyMatches =
        rows.length === options.migrations.length &&
        rows.every((row, index) => {
          const expected = options.migrations[index];
          return (
            expected !== undefined && row.version === expected.version && row.name === expected.name
          );
        });

      migrationCheck = Object.freeze({
        status: historyMatches ? "ok" : "unhealthy",
        appliedCount: rows.length,
        expectedCount: options.migrations.length,
        appliedVersion,
        expectedVersion,
      });
    } catch {
      migrationCheck = Object.freeze({
        status: "unhealthy",
        appliedCount: 0,
        expectedCount: options.migrations.length,
        appliedVersion: null,
        expectedVersion,
      });
    }
  }

  const databaseStatus: RuntimeHealthStatus =
    databaseSnapshot.state === "open" && queryStatus === "ok" && migrationCheck.status === "ok"
      ? "ok"
      : "unhealthy";
  const status: RuntimeHealthStatus =
    runtimeStatus === "ok" && databaseStatus === "ok" ? "ok" : "unhealthy";

  return Object.freeze({
    status,
    service: RUNTIME_HEALTH_SERVICE,
    checks: Object.freeze({
      runtime: Object.freeze({
        status: runtimeStatus,
        state: options.runtimeState,
      }),
      database: Object.freeze({
        status: databaseStatus,
        state: databaseSnapshot.state,
        query: queryStatus,
        migrations: migrationCheck,
      }),
    }),
  });
}

function readAppliedVersion(rows: readonly Record<string, unknown>[]): number | null {
  const lastRow = rows.at(-1);
  if (lastRow === undefined) {
    return null;
  }

  return typeof lastRow.version === "number" && Number.isSafeInteger(lastRow.version)
    ? lastRow.version
    : null;
}
