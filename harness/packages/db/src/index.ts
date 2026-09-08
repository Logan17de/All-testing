import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export {
  CONTENT_ADDRESSED_BLOB_ALGORITHM,
  CONTENT_ADDRESSED_BLOB_ID_PREFIX,
  ContentAddressedBlobIntegrityError,
  FileContentAddressedBlobStore,
  type ContentAddressedBlobId,
  type ContentAddressedBlobRef,
  type FileContentAddressedBlobStoreOptions,
  type FileContentAddressedBlobStoreSnapshot,
} from "./content-addressed-blob-store.js";
export {
  commitDurableNodeCompletion,
  type DurableNodeCompletionCommitResult,
  type DurableNodeCompletionInput,
  type DurableNodeCompletionTerminalEventInput,
  type SerializedSqliteCommitPath,
} from "./durable-node-completion.js";
export {
  CHECKPOINT_CONTROL_EDGES_TABLE,
  CHECKPOINT_OP_FRONTIER_TABLE,
  CHECKPOINT_ROUTER_SELECTIONS_TABLE,
  DURABLE_CHECKPOINTS_MIGRATION,
  RUN_CHECKPOINTS_TABLE,
  type DurableCheckpointControlEdgeRecord,
  type DurableCheckpointControlEdgeStatus,
  type DurableCheckpointOpFrontierRecord,
  type DurableCheckpointOpStatus,
  type DurableCheckpointRouterSelectionRecord,
  type DurableRunCheckpointRecord,
} from "./durable-checkpoint-records.js";
export {
  DURABLE_EVENTS_MIGRATION,
  DURABLE_EVENTS_TABLE,
  type DurableEventRecord,
} from "./durable-event-records.js";
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

type NonPromise<T> = T extends PromiseLike<unknown> ? never : unknown;

export type SqliteCommitCallback<T> = (connection: DatabaseSync) => T & NonPromise<T>;

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
 * unavailable there. Runtime durability writes enter through `commit()`, which
 * admits callers FIFO and executes one short synchronous `BEGIN IMMEDIATE`
 * transaction at a time. Startup migrations remain a pre-readiness bootstrap
 * primitive and therefore use the raw connection directly.
 */
export class SqliteDatabase {
  private readonly path: string;
  private readonly createParentDirectory: boolean;
  private connectionValue: DatabaseSync | undefined;
  private writeTail: Promise<void> = Promise.resolve();
  private pendingWriteCount = 0;
  private writeActive = false;

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

    if (this.pendingWriteCount !== 0 || this.writeActive) {
      throw new TypeError("SQLite database cannot open while serialized writes are pending.");
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

    if (this.pendingWriteCount !== 0 || this.writeActive) {
      throw new TypeError(
        "SQLite database cannot close while serialized writes are pending; await drainWrites() first.",
      );
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

  /**
   * Serialize one short durability transaction behind all earlier callers.
   *
   * The callback must be synchronous. Async work must happen before entering the
   * commit path so SQLite locks are never held across an `await`.
   */
  commit<T>(write: SqliteCommitCallback<T>): Promise<T> {
    const connection = this.connection();
    if (this.writeActive) {
      throw new TypeError("Nested SQLite commits are not allowed.");
    }

    this.pendingWriteCount += 1;

    const queuedWrite = this.writeTail.then(() => {
      if (this.connectionValue !== connection) {
        throw new TypeError("SQLite connection changed before a queued commit could run.");
      }

      this.writeActive = true;
      try {
        return executeSerializedCommit(connection, write);
      } finally {
        this.writeActive = false;
      }
    });

    const trackedWrite = queuedWrite.then(
      (value) => {
        this.pendingWriteCount -= 1;
        return value;
      },
      (error: unknown) => {
        this.pendingWriteCount -= 1;
        throw error;
      },
    );

    this.writeTail = trackedWrite.then(
      () => undefined,
      () => undefined,
    );

    return trackedWrite;
  }

  /** Resolve after every currently queued serialized write has settled. */
  drainWrites(): Promise<void> {
    return this.writeTail;
  }
}

function executeSerializedCommit<T>(connection: DatabaseSync, write: SqliteCommitCallback<T>): T {
  connection.exec("BEGIN IMMEDIATE");

  try {
    const value = write(connection);
    if (isPromiseLike(value)) {
      throw new TypeError(
        "SQLite commit callbacks must be synchronous; perform async work before commit().",
      );
    }

    connection.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "SQLite commit failed and its rollback also failed.",
      );
    }
    throw error;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }

  return "then" in value && typeof (value as { readonly then?: unknown }).then === "function";
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
