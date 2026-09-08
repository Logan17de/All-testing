import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export {
  COMPILED_PLANS_TABLE,
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  GRAPH_COMPILATIONS_TABLE,
  GRAPH_SOURCES_TABLE,
  type DurableCompiledPlanRecord,
  type DurableGraphCompilationRecord,
  type DurableGraphSourceRecord,
} from "./durable-identity-records.js";
export {
  DURABLE_NODE_ATTEMPTS_MIGRATION,
  NODE_ATTEMPTS_TABLE,
  NODE_INVOCATIONS_TABLE,
  type DurableNodeAttemptRecord,
  type DurableNodeAttemptStatus,
  type DurableNodeInvocationRecord,
} from "./durable-node-attempt-records.js";
export {
  DURABLE_RUNS_MIGRATION,
  RUNS_TABLE,
  type DurableRunRecord,
  type DurableRunStatus,
} from "./durable-run-records.js";
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
 * Connections enforce foreign keys. File-backed databases use WAL mode;
 * `:memory:` databases retain SQLite's in-memory journal mode because WAL is
 * unavailable there. Schema migrations remain a separate primitive, while
 * durable application tables and write serialization remain later Phase 4 items.
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
      enableForeignKeyConstraints: true,
    });

    try {
      assertForeignKeysEnabled(connection);
      if (this.path !== SQLITE_MEMORY_PATH) {
        enableAndAssertWalMode(connection);
      }
    } catch (error) {
      connection.close();
      throw error;
    }

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

function assertForeignKeysEnabled(connection: DatabaseSync): void {
  const row = connection.prepare("PRAGMA foreign_keys").get();
  if (row?.foreign_keys !== 1) {
    throw new TypeError("SQLite foreign-key enforcement could not be enabled.");
  }
}

function enableAndAssertWalMode(connection: DatabaseSync): void {
  const row = connection.prepare("PRAGMA journal_mode = WAL").get();
  if (typeof row?.journal_mode !== "string" || row.journal_mode.toLowerCase() !== "wal") {
    throw new TypeError("SQLite WAL journal mode could not be enabled.");
  }
}
