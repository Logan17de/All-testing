import { resolve } from "node:path";

import {
  DURABLE_CHECKPOINTS_MIGRATION,
  DURABLE_EVENTS_MIGRATION,
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_NODE_ATTEMPTS_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  SqliteDatabase,
  runSqliteMigrations,
  type SqliteDatabaseOptions,
  type SqliteDatabaseSnapshot,
  type SqliteMigration,
} from "@zet-harness/db";
import { DURABLE_APPROVALS_MIGRATION } from "@zet-harness/db/durable-approval-records";
import { DURABLE_FILE_CHANGES_MIGRATION } from "@zet-harness/db/durable-file-change-records";

import type { PluginHost } from "@zet-harness/core";

import { RuntimeEventStream, type RuntimeStreamEvent } from "./runtime-event-stream.js";
import { inspectRuntimeHealth } from "./runtime-health.js";
import {
  RuntimeHttpServer,
  type RuntimeHttpServerOptions,
  type RuntimeHttpServerSnapshot,
} from "./runtime-http-server.js";
import {
  RuntimeHumanApprovals,
  type RuntimeApprovalAuthority,
  type SuspendForApprovalInput,
} from "./runtime-human-approvals.js";
import {
  RuntimeRunDispatcher,
  type RuntimeExecutionOptions,
  type RuntimeDispatchReport,
} from "./runtime-run-dispatcher.js";
import { probeRuntimePathLimits, type RuntimePathLimitReport } from "./runtime-path-limits.js";
import {
  DEFAULT_PLUGINS_DIRECTORY,
  emptyPluginReport,
  loadRuntimePlugins,
  type RuntimePluginOptions,
  type RuntimePluginReport,
} from "./runtime-plugins.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";

export const DEFAULT_RUNTIME_DATABASE_PATH = resolve("data", "zet-harness.sqlite");
export const RUNTIME_DATABASE_MIGRATIONS: readonly SqliteMigration[] = Object.freeze([
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  DURABLE_NODE_ATTEMPTS_MIGRATION,
  DURABLE_EVENTS_MIGRATION,
  DURABLE_CHECKPOINTS_MIGRATION,
  DURABLE_APPROVALS_MIGRATION,
  DURABLE_FILE_CHANGES_MIGRATION,
]);
export type RuntimeDaemonState = "idle" | "running" | "stopped";

export interface RuntimeDaemonOptions {
  readonly api?: RuntimeHttpServerOptions;
  readonly database?: SqliteDatabaseOptions;
  readonly migrations?: readonly SqliteMigration[];
  readonly permissionAuthority?: RuntimeApprovalAuthority;
  readonly redaction?: RuntimeRedactionRegistry;
  readonly execution?: RuntimeExecutionOptions;
  /**
   * Probe host path limits during startup. Defaults to true.
   *
   * The probe is advisory and never fails startup; a host that runs many short
   * lived daemons can disable it rather than repeating the same measurement.
   */
  readonly probePathLimits?: boolean;
  /** Injection point for tests; the default probe writes under the temp directory. */
  readonly pathLimitProbe?: () => Promise<RuntimePathLimitReport>;
  /**
   * Third-party plugin loading.
   *
   * Omit to run with no plugin directory at all. Supplying it does not enable
   * any plugin: each package still has to be enabled in the plugin config.
   */
  readonly plugins?: RuntimePluginOptions;
}
export interface RuntimeDaemonSnapshot {
  readonly state: RuntimeDaemonState;
  readonly api: RuntimeHttpServerSnapshot;
  readonly database: SqliteDatabaseSnapshot;
  /** Populated once startup has probed the host; undefined when disabled. */
  readonly pathLimits: RuntimePathLimitReport | undefined;
  /** What was installed, enabled and activated at startup. */
  readonly plugins: RuntimePluginReport;
}

/** Owns transport, journal, human waits and redaction; a wait never retains a live task. */
export class RuntimeDaemon {
  private state: RuntimeDaemonState = "idle";
  private readonly eventStream = new RuntimeEventStream();
  private readonly database: SqliteDatabase;
  private readonly migrations: readonly SqliteMigration[];
  private readonly httpServer: RuntimeHttpServer;
  private readonly redaction: RuntimeRedactionRegistry;
  private readonly approvals: RuntimeHumanApprovals;
  private readonly dispatcher: RuntimeRunDispatcher | undefined;
  private readonly stoppedPromise: Promise<void>;
  private readonly resolveStopped: () => void;
  private stopPromise: Promise<boolean> | undefined;
  private readonly pathLimitProbe: (() => Promise<RuntimePathLimitReport>) | undefined;
  private pathLimits: RuntimePathLimitReport | undefined;
  private readonly pluginOptions: RuntimePluginOptions | undefined;
  private pluginHost: PluginHost | undefined;
  private pluginReport: RuntimePluginReport;
  private pluginSandboxes: readonly { readonly close: () => Promise<void> }[] = [];

  constructor(options: RuntimeDaemonOptions = {}) {
    this.database = new SqliteDatabase(options.database ?? { path: DEFAULT_RUNTIME_DATABASE_PATH });
    this.migrations = options.migrations ?? RUNTIME_DATABASE_MIGRATIONS;
    this.redaction = options.redaction ?? new RuntimeRedactionRegistry();
    this.approvals = new RuntimeHumanApprovals(this.database, {
      redaction: this.redaction,
      onResolved: (runId) => {
        this.dispatcher?.wake(runId);
      },
      ...(options.permissionAuthority === undefined
        ? {}
        : { authority: options.permissionAuthority }),
    });
    this.dispatcher =
      options.execution === undefined
        ? undefined
        : new RuntimeRunDispatcher(
            this.database,
            this.approvals,
            options.execution,
            this.redaction,
            options.permissionAuthority,
          );
    this.httpServer = new RuntimeHttpServer(
      options.api,
      this.eventStream,
      () =>
        inspectRuntimeHealth({
          runtimeState: this.state,
          database: this.database,
          migrations: this.migrations,
        }),
      {
        approvals: this.approvals,
        redaction: this.redaction,
        plugins: () => this.pluginReport,
      },
    );
    this.pathLimitProbe =
      options.probePathLimits === false
        ? undefined
        : (options.pathLimitProbe ?? (() => probeRuntimePathLimits()));
    this.pluginOptions = options.plugins;
    this.pluginReport = emptyPluginReport(options.plugins?.directory ?? DEFAULT_PLUGINS_DIRECTORY);
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
      pathLimits: this.pathLimits,
      plugins: this.pluginReport,
    });
  }

  publishEvent(type: string, data: unknown): RuntimeStreamEvent {
    if (this.state !== "running") {
      throw new TypeError("Runtime daemon must be running before publishing stream events.");
    }
    return this.eventStream.publish(type, this.redaction.redact(data));
  }

  /** Host dispatch boundary. Never expose this method to a model as approval authority. */
  suspendForApproval(input: SuspendForApprovalInput): ReturnType<RuntimeHumanApprovals["suspend"]> {
    if (this.state !== "running" || this.stopPromise !== undefined) {
      throw new TypeError("Runtime daemon must be running before requesting approval.");
    }
    return this.approvals.suspend(input);
  }

  /** Dispatch a stored, compiler-admitted run; arbitrary graph submission stays host-owned. */
  dispatchRun(runId: string): Promise<RuntimeDispatchReport> {
    if (
      this.state !== "running" ||
      this.stopPromise !== undefined ||
      this.dispatcher === undefined
    ) {
      throw new TypeError("A running daemon with a trusted execution adapter is required.");
    }
    return this.dispatcher.dispatch(runId);
  }

  waitForRunIdle(runId: string): Promise<RuntimeDispatchReport> {
    if (this.dispatcher === undefined) throw new TypeError("No execution adapter is configured.");
    return this.dispatcher.waitForIdle(runId);
  }

  async start(): Promise<boolean> {
    if (this.state === "stopped") {
      throw new TypeError("Runtime daemon cannot restart after it has stopped.");
    }
    if (this.state === "running") return false;
    this.database.open();
    try {
      runSqliteMigrations(this.database.connection(), this.migrations);
      // Measure host path limits before anything can write a project file, so a
      // Windows MAX_PATH limitation is reported rather than discovered later as
      // an unexplained tool failure. The probe is advisory: it never throws.
      if (this.pathLimitProbe !== undefined) {
        this.pathLimits = await this.pathLimitProbe();
      }
      if (this.pluginOptions !== undefined) {
        // A third-party plugin that fails to load is reported, not fatal: one
        // bad package must not stop the runtime from starting.
        const loaded = await loadRuntimePlugins(this.pluginOptions);
        this.pluginHost = loaded.host;
        this.pluginReport = loaded.report;
        this.pluginSandboxes = loaded.sandboxes;
      }
      await this.httpServer.start();
    } catch (error) {
      this.database.close();
      throw error;
    }
    this.state = "running";
    try {
      this.dispatcher?.start();
    } catch (error) {
      // A dispatch bootstrap failure after HTTP binding must not leave a live
      // listener claiming readiness. This instance is stopped; use a fresh daemon.
      await this.stop();
      throw error;
    }
    return true;
  }

  async stop(): Promise<boolean> {
    if (this.state === "stopped") return false;
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

  /** Node/model/tool catalogs contributed by activated plugins. */
  get plugins(): PluginHost | undefined {
    return this.pluginHost;
  }

  private async stopOnce(): Promise<boolean> {
    const draining = this.dispatcher?.stop();
    const pluginCleanup = Promise.all([
      this.pluginHost?.dispose().catch(() => undefined),
      // A sandboxed plugin is its own process; leaving it running would
      // outlive the runtime that started it.
      ...this.pluginSandboxes.map((sandbox) => sandbox.close().catch(() => undefined)),
    ]);
    try {
      await this.httpServer.stop();
    } finally {
      await draining;
      await pluginCleanup;
      await this.database.drainWrites();
      this.database.close();
    }
    this.state = "stopped";
    this.resolveStopped();
    return true;
  }
}
