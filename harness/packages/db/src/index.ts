import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export {
  SCHEMA_MIGRATIONS_TABLE,
  runSqliteMigrations,
  type SqliteMigration,
  type SqliteMigrationRunnerOptions,
  type SqliteMigrationRunResult,
} from "./migrations.js";

export const SQLITE_MEMORY_PATH = ":memory:";

export type SqliteDatabaseState = "closed" | "open";

export interface SqliteDatabaseOptions {
  readonly path: string;
  readonly createParentDirectory?: boolean;
}

export interface SqliteDatabaseSnapshot {
  readonly state: SqliteDatabaseState;
  readonly path: string;
  readonly inMemory: boolean;
}

/**
 * Thin direct wrapper around Node 24 `node:sqlite`.
 *
 * This layer intentionally owns only connection lifecycle in Phase 4.4. Schema
 * migrations are a separate 4.5 primitive; foreign-key enforcement, WAL,
 * durable tables, and write serialization remain later Phase 4 items.
 */
export class SqliteDatabase {
  private readonly path: string;
  private readonly createParentDirectory: boolean;
  private connectionValue: DatabaseSync | undefined;

  constructor(options: SqliteDatabaseOptions) {
    if (options.path.trim().length === 0) {
      throw new TypeError("SQLite database path must not be empty.");
    }

    this.path = options.path;
    this.createParentDirectory = options.createParentDirectory ?? true;
  }

  snapshot(): SqliteDatabaseSnapshot {
    return Object.freeze({
      state: this.connectionValue === undefined ? "closed" : "open",
      path: this.path,
      inMemory: this.path === SQLITE_MEMORY_PATH,
    });
  }

  open(): boolean {
    if (this.connectionValue !== undefined) {
      return false;
    }

    if (this.path !== SQLITE_MEMORY_PATH && this.createParentDirectory) {
      mkdirSync(dirname(this.path), { recursive: true });
    }

    const connection = new DatabaseSync(this.path, {
      allowExtension: false,
      enableForeignKeyConstraints: false,
    });

    this.connectionValue = connection;
    return true;
  }

  close(): boolean {
    const connection = this.connectionValue;
    if (connection === undefined) {
      return false;
    }

    this.connectionValue = undefined;
    connection.close();
    return true;
  }

  connection(): DatabaseSync {
    const connection = this.connectionValue;
    if (connection === undefined) {
      throw new TypeError("SQLite database is not open.");
    }
    return connection;
  }
}
