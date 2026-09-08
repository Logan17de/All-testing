import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface SqliteMigrationRunnerOptions {
  readonly now?: () => number;
}

export interface SqliteMigrationRunResult {
  readonly appliedVersions: readonly number[];
  readonly currentVersion: number;
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
}

const createSchemaMigrationsSql = `
CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
)`;

const selectAppliedMigrationsSql = `
SELECT version, name
FROM ${SCHEMA_MIGRATIONS_TABLE}
ORDER BY version ASC
`;

const insertAppliedMigrationSql = `
INSERT INTO ${SCHEMA_MIGRATIONS_TABLE}(version, name, applied_at_ms)
VALUES (?, ?, ?)
`;

/**
 * Apply a trusted, strictly ordered SQL migration catalog.
 *
 * The migration SQL and its `schema_migrations` row commit atomically. The
 * catalog itself is code-owned rather than discovered from the filesystem so
 * packaged runtime behavior stays deterministic across platforms.
 */
export function runSqliteMigrations(
  connection: DatabaseSync,
  migrations: readonly SqliteMigration[],
  options: SqliteMigrationRunnerOptions = {},
): SqliteMigrationRunResult {
  assertMigrationCatalog(migrations);

  connection.exec(createSchemaMigrationsSql);
  const applied = readAppliedMigrations(connection);
  assertAppliedHistoryMatchesCatalog(applied, migrations);

  const appliedVersions: number[] = [];
  const now = options.now ?? Date.now;
  const insertAppliedMigration = connection.prepare(insertAppliedMigrationSql);

  for (let index = applied.length; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (migration === undefined) {
      throw new TypeError(`SQLite migration ${String(index)} is missing.`);
    }

    const appliedAtMs = now();
    if (!Number.isSafeInteger(appliedAtMs) || appliedAtMs < 0) {
      throw new TypeError("SQLite migration clock must return a non-negative safe integer.");
    }

    let transactionStarted = false;
    try {
      connection.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      connection.exec(migration.sql);
      insertAppliedMigration.run(migration.version, migration.name, appliedAtMs);
      connection.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          connection.exec("ROLLBACK");
        } catch {
          // Preserve the original migration failure. A broken rollback will
          // still leave the connection unusable to the caller, which should
          // close it rather than masking the root error.
        }
      }
      throw error;
    }

    appliedVersions.push(migration.version);
  }

  const currentVersion =
    migrations.length === 0 ? 0 : (migrations[migrations.length - 1]?.version ?? 0);

  return Object.freeze({
    appliedVersions: Object.freeze(appliedVersions),
    currentVersion,
  });
}

function assertMigrationCatalog(migrations: readonly SqliteMigration[]): void {
  let previousVersion = 0;

  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (migration === undefined) {
      throw new TypeError(`SQLite migration ${String(index)} is missing.`);
    }

    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new TypeError(
        `SQLite migration at index ${String(index)} must have a positive safe-integer version.`,
      );
    }
    if (migration.version <= previousVersion) {
      throw new TypeError("SQLite migrations must be strictly increasing by version.");
    }
    if (migration.name.trim().length === 0) {
      throw new TypeError(`SQLite migration ${String(migration.version)} must have a name.`);
    }
    if (migration.sql.trim().length === 0) {
      throw new TypeError(`SQLite migration ${String(migration.version)} must contain SQL.`);
    }

    previousVersion = migration.version;
  }
}

function readAppliedMigrations(connection: DatabaseSync): readonly AppliedMigrationRow[] {
  const rows = connection.prepare(selectAppliedMigrationsSql).all();

  return rows.map((row, index) => {
    const version = row.version;
    const name = row.name;

    if (typeof version !== "number" || !Number.isSafeInteger(version) || typeof name !== "string") {
      throw new TypeError(
        `SQLite migration history row ${String(index)} has an invalid version or name.`,
      );
    }

    return Object.freeze({ version, name });
  });
}

function assertAppliedHistoryMatchesCatalog(
  applied: readonly AppliedMigrationRow[],
  migrations: readonly SqliteMigration[],
): void {
  if (applied.length > migrations.length) {
    throw new TypeError("SQLite migration history is newer than this runtime migration catalog.");
  }

  for (let index = 0; index < applied.length; index += 1) {
    const appliedMigration = applied[index];
    const catalogMigration = migrations[index];

    if (
      appliedMigration === undefined ||
      catalogMigration === undefined ||
      appliedMigration.version !== catalogMigration.version ||
      appliedMigration.name !== catalogMigration.name
    ) {
      throw new TypeError(
        "SQLite migration history does not match the ordered runtime migration catalog.",
      );
    }
  }
}
