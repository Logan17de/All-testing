import { resolve } from "node:path";

import {
  SqliteDatabase,
  runSqliteMigrations,
  type SqliteDatabaseOptions,
  type SqliteDatabaseSnapshot,
  type SqliteMigration,
} from "@zet-harness/db";

import { RuntimeEventStream, type RuntimeStreamEvent } from "./runtime-event-stream.js";
import {
  RuntimeHttpServer,
  type RuntimeHttpServerOptions,
  type RuntimeHttpServerSnapshot,
} from "./runtime-http-server.js";

export const DEFAULT_RUNTIME_DATABASE_PATH = resolve("data", "zet-harness.sqlite");
export const RUNTIME_DATABASE_MIGRATIONS: readonly SqliteMigration[] = Object.freeze([]);

export type RuntimeDaemonState = "idle" | "running" | "stopped";

export interface RuntimeDaemonOptions {
  readonly api?: RuntimeHttpServerOptions;
  readonly database?: SqliteDatabaseOptions;
  readonly migrations?: readonly SqliteMigration[];
}

export interface RuntimeDaemonSnapshot {
  readonly state: RuntimeDaemonState;
  readonly api: RuntimeHttpServerSnapshot;
  readonly database: SqliteDatabaseSnapshot;
}

/**
 * Long-lived runtime lifecycle.
 *
 * The daemon owns the process-local event stream, loopback HTTP transport, and
 * native SQLite connection. Ordered SQL migrations run before API readiness;
 * foreign-key/WAL policy and durable application tables remain later Phase 4 work.
 */
export class RuntimeDaemon {
  private state: RuntimeDaemonState = "idle";
  private readonly eventStream = new RuntimeEventStream();
  private readonly database: SqliteDatabase;
  private readonly migrations: readonly SqliteMigration[];
  private readonly httpServer: RuntimeHttpServer;
  private readonly stoppedPromise: Promise<void>;
  private readonly resolveStopped: () => void;
  private stopPromise: Promise<boolean> | undefined;

  constructor(options: RuntimeDaemonOptions = {}) {
    this.database = new SqliteDatabase(options.database ?? { path: DEFAULT_RUNTIME_DATABASE_PATH });
    this.migrations = options.migrations ?? RUNTIME_DATABASE_MIGRATIONS;
    this.httpServer = new RuntimeHttpServer(options.api, this.eventStream);

    let resolveStopped!: () => void;
    this.stoppedPromise = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    this.resolveStopped = resolveStopped;
  }

  snapshot(): RuntimeDaemonSnapshot {
    return Object.freeze({
      state: this.state,
      api: this.httpServer.snapshot(),
      database: this.database.snapshot(),
    });
  }

  publishEvent(type: string, data: unknown): RuntimeStreamEvent {
    if (this.state !== "running") {
      throw new TypeError("Runtime daemon must be running before publishing stream events.");
    }
    return this.eventStream.publish(type, data);
  }

  /** Start only after SQLite migrations and the loopback API are ready. */
  async start(): Promise<boolean> {
    if (this.state === "stopped") {
      throw new TypeError("Runtime daemon cannot restart after it has stopped.");
    }
    if (this.state === "running") {
      return false;
    }

    this.database.open();
    try {
      runSqliteMigrations(this.database.connection(), this.migrations);
      await this.httpServer.start();
    } catch (error) {
      this.database.close();
      throw error;
    }

    this.state = "running";
    return true;
  }

  /** Stop once, closing SSE/API transport before the SQLite connection. */
  async stop(): Promise<boolean> {
    if (this.state === "stopped") {
      return false;
    }
    if (this.stopPromise !== undefined) {
      await this.stopPromise;
      return false;
    }

    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  waitUntilStopped(): Promise<void> {
    return this.stoppedPromise;
  }

  private async stopOnce(): Promise<boolean> {
    try {
      await this.httpServer.stop();
    } finally {
      this.database.close();
    }

    this.state = "stopped";
    this.resolveStopped();
    return true;
  }
}
