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
import { DURABLE_AGENT_STEPS_MIGRATION } from "@zet-harness/db/durable-agent-step-records";
import { DURABLE_PROJECT_RUN_LOCKS_MIGRATION } from "@zet-harness/db/durable-project-lock-records";
import { DURABLE_APPROVALS_MIGRATION } from "@zet-harness/db/durable-approval-records";
import { DURABLE_FILE_CHANGES_MIGRATION } from "@zet-harness/db/durable-file-change-records";
import { DURABLE_CONVERSATIONS_MIGRATION } from "@zet-harness/db/durable-conversation-records";
import {
  DURABLE_GOAL_ACTION_EFFECTS_MIGRATION,
  DURABLE_GOAL_BLOCKING_MIGRATION,
  DURABLE_GOALS_MIGRATION,
} from "@zet-harness/db/durable-goal-records";
import { DURABLE_PROJECTS_MIGRATION } from "@zet-harness/db/durable-project-records";

import {
  PluginHost,
  createAgentPlugin,
  createControlFlowPlugin,
  createHumanApprovalPlugin,
  type CapabilityPermissionPolicy,
} from "@zet-harness/core";
import type { IsolatedPlugin } from "@zet-harness/plugin-loader";

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
import { createAgentNodeExecutor } from "./runtime-agent-nodes.js";
import { createPluginNodeExecutor } from "./runtime-plugin-executor.js";
import {
  RuntimeRunDispatcher,
  type RuntimeExecutionOptions,
  type RuntimeDispatchReport,
  type RuntimeNodeExecution,
  type RuntimeNodeExecutionResult,
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
  DURABLE_PROJECTS_MIGRATION,
  DURABLE_CONVERSATIONS_MIGRATION,
  DURABLE_GOALS_MIGRATION,
  DURABLE_GOAL_ACTION_EFFECTS_MIGRATION,
  DURABLE_AGENT_STEPS_MIGRATION,
  DURABLE_GOAL_BLOCKING_MIGRATION,
  DURABLE_PROJECT_RUN_LOCKS_MIGRATION,
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
  private pluginSandboxes: readonly IsolatedPlugin[] = [];
  private pluginPolicies: ReadonlyMap<string, CapabilityPermissionPolicy> = new Map();

  constructor(options: RuntimeDaemonOptions = {}) {
    this.database = new SqliteDatabase(options.database ?? { path: DEFAULT_RUNTIME_DATABASE_PATH });
    this.migrations = options.migrations ?? RUNTIME_DATABASE_MIGRATIONS;
    this.redaction = options.redaction ?? new RuntimeRedactionRegistry();
    // Plugins load in start(), after construction, so both of these read plugin
    // state when they are called rather than capturing it now. A host-supplied
    // authority or executor always takes precedence.
    const authority: RuntimeApprovalAuthority | undefined =
      options.permissionAuthority ??
      (options.plugins === undefined
        ? undefined
        : { evaluate: (capability) => this.pluginAuthority(capability) });
    const execution: RuntimeExecutionOptions | undefined =
      options.execution ??
      (options.plugins === undefined
        ? undefined
        : { execute: (request) => this.executePluginNode(request) });
    this.approvals = new RuntimeHumanApprovals(this.database, {
      redaction: this.redaction,
      onResolved: (runId) => {
        this.dispatcher?.wake(runId);
      },
      ...(authority === undefined ? {} : { authority }),
    });
    this.dispatcher =
      execution === undefined
        ? undefined
        : new RuntimeRunDispatcher(
            this.database,
            this.approvals,
            execution,
            this.redaction,
            authority,
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
        projects: { database: this.database },
        conversations: { database: this.database },
        goals: { database: this.database },
        graphs: {
          database: this.database,
          sources: () => ({
            ...(this.pluginHost === undefined ? {} : { host: this.pluginHost }),
            sandboxes: this.pluginSandboxes,
          }),
          capabilityAuthority: () =>
            authority ?? { evaluate: () => ({ decision: "deny" as const }) },
          redact: (value) => this.redaction.redact(value),
          dispatch:
            execution === undefined
              ? undefined
              : (runId) => {
                  this.dispatcher?.wake(runId);
                },
        },
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
        // The human approval node is a runtime primitive rather than a third-party
        // plugin, so it is always present: any graph can pause for a person, and the
        // dispatcher handles it itself instead of sending it to an executor.
        const host = new PluginHost();
        await host.activate(createHumanApprovalPlugin());
        // Condition, Route and the joins are first-party control flow, registered
        // through the same public path; routers and joins never run plugin code.
        await host.activate(createControlFlowPlugin());
        // The agent model and tools steps compile like any node; the agent
        // executor runs them with the run's own identity and records each step.
        await host.activate(createAgentPlugin());
        const loaded = await loadRuntimePlugins(this.pluginOptions, host);
        this.pluginHost = loaded.host;
        this.pluginReport = loaded.report;
        this.pluginSandboxes = loaded.sandboxes;
        this.pluginPolicies = loaded.policies;
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

  /**
   * Coarse authority for compile time and the scheduler's invocation re-check:
   * a capability is available when any enabled plugin was granted it. The plugin
   * executor then checks the node's own plugin precisely, so this never lets one
   * plugin's grant run another plugin's node.
   */
  private pluginAuthority(capability: string): { readonly decision: "allow" | "deny" } {
    for (const policy of this.pluginPolicies.values()) {
      if (policy.allows(capability)) return { decision: "allow" };
    }
    return { decision: "deny" };
  }

  private executePluginNode(request: RuntimeNodeExecution): Promise<RuntimeNodeExecutionResult> {
    const plugins = createPluginNodeExecutor({
      ...(this.pluginHost === undefined ? {} : { host: this.pluginHost }),
      sandboxes: this.pluginSandboxes,
      policies: this.pluginPolicies,
    });
    const host = this.pluginHost;
    if (host === undefined) return plugins(request);
    // Agent steps get the plugins' models and tools, limited to granted capabilities.
    return createAgentNodeExecutor({
      database: this.database,
      models: host.models,
      tools: host.tools.listManifests().flatMap((manifest) => {
        const adapter = host.tools.getAdapter(manifest.id, manifest.version);
        return adapter === undefined ? [] : [adapter];
      }),
      allows: (capability) => this.pluginAuthority(capability).decision === "allow",
      fallback: plugins,
    })(request);
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
