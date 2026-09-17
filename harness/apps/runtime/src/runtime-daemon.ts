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
import { DURABLE_PROJECT_MEMORIES_MIGRATION } from "@zet-harness/db/durable-memory-records";
import { DURABLE_CONVERSATION_SUMMARIES_MIGRATION } from "@zet-harness/db/durable-summary-records";
import { DURABLE_CLIENT_SESSIONS_MIGRATION } from "@zet-harness/db/durable-client-records";
import {
  DURABLE_MODEL_CONFIGS_MIGRATION,
  listModelConfigs,
} from "@zet-harness/db/durable-model-records";
import { DURABLE_TRIGGER_FIRES_MIGRATION } from "@zet-harness/db/durable-trigger-fire-records";
import { DURABLE_TRIGGERS_MIGRATION } from "@zet-harness/db/durable-trigger-records";
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
import { GITHUB_PLUGIN_ID, createGitHubPlugin } from "@zet-harness/github";
import { createAgentNodeExecutor } from "./runtime-agent-nodes.js";
import { RuntimeModels } from "./runtime-models.js";
import type { ModelCheckResult } from "./runtime-model-http.js";
import { createCompositeNodeResolver } from "./runtime-graphs.js";
import { createPluginNodeExecutor } from "./runtime-plugin-executor.js";
import {
  RuntimeRunDispatcher,
  type RuntimeExecutionOptions,
  type RuntimeDispatchReport,
  type RuntimeNodeExecution,
  type RuntimeNodeExecutionResult,
} from "./runtime-run-dispatcher.js";
import { probeRuntimePathLimits, type RuntimePathLimitReport } from "./runtime-path-limits.js";
import { RuntimeTriggerScheduler } from "./runtime-trigger-scheduler.js";
import {
  DEFAULT_PLUGINS_DIRECTORY,
  emptyPluginReport,
  listInstalledPlugins,
  loadRuntimePlugins,
  type RuntimePluginOptions,
  type RuntimePluginReport,
} from "./runtime-plugins.js";
import {
  installPluginPackage,
  PluginInstallError,
  type InstalledPluginPackage,
  type PluginInstallSource,
} from "@zet-harness/plugin-loader";
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
  DURABLE_PROJECT_MEMORIES_MIGRATION,
  DURABLE_CONVERSATION_SUMMARIES_MIGRATION,
  DURABLE_TRIGGERS_MIGRATION,
  DURABLE_TRIGGER_FIRES_MIGRATION,
  DURABLE_CLIENT_SESSIONS_MIGRATION,
  DURABLE_MODEL_CONFIGS_MIGRATION,
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
  private readonly triggerSchedule: RuntimeTriggerScheduler;
  private readonly stoppedPromise: Promise<void>;
  private readonly resolveStopped: () => void;
  private stopPromise: Promise<boolean> | undefined;
  private readonly pathLimitProbe: (() => Promise<RuntimePathLimitReport>) | undefined;
  private pathLimits: RuntimePathLimitReport | undefined;
  private readonly pluginOptions: RuntimePluginOptions | undefined;
  private pluginHost: PluginHost | undefined;
  private pluginReport: RuntimePluginReport;
  private pluginSandboxes: readonly IsolatedPlugin[] = [];
  private models: RuntimeModels | undefined;
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
        : {
            execute: (request) => this.executePluginNode(request),
            resolveNode: (type, version) => this.resolveNodePin(type, version),
          });
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
    // Cron triggers are due at times kept in the database, so the schedule survives
    // a restart and the process only ever holds a short timer to the next check.
    this.triggerSchedule = new RuntimeTriggerScheduler({
      database: this.database,
      ...(execution === undefined
        ? {}
        : {
            dispatch: (runId: string) => {
              this.dispatcher?.wake(runId);
            },
          }),
    });
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
        plugins: () => this.servedPluginReport(),
        ...(options.plugins?.install === undefined
          ? {}
          : {
              installPlugin: (source: {
                readonly kind: "npm" | "git";
                readonly spec?: string;
                readonly url?: string;
                readonly ref?: string;
              }) =>
                this.installPlugin(
                  source.kind === "npm"
                    ? { kind: "npm", spec: source.spec ?? "" }
                    : {
                        kind: "git",
                        url: source.url ?? "",
                        ...(source.ref === undefined ? {} : { ref: source.ref }),
                      },
                ),
            }),
        projects: { database: this.database },
        memories: { database: this.database },
        models: {
          database: this.database,
          refresh: (modelId: string) => {
            this.models?.refresh(modelId);
          },
          remove: (modelId: string) => {
            this.models?.remove(modelId);
          },
          check: (modelId: string) => this.checkModel(modelId),
        },
        clients: {
          database: this.database,
          approvals: this.approvals,
          redact: (value) => this.redaction.redact(value),
          registerSecret: (secret) => {
            this.redaction.registerSecret(secret);
          },
          dispatch:
            execution === undefined
              ? undefined
              : (runId) => {
                  this.dispatcher?.wake(runId);
                },
        },
        triggers: {
          database: this.database,
          sources: () => ({
            ...(this.pluginHost === undefined ? {} : { host: this.pluginHost }),
            sandboxes: this.pluginSandboxes,
          }),
          capabilityAuthority: () =>
            authority ?? { evaluate: () => ({ decision: "deny" as const }) },
          registerSecret: (secret) => {
            this.redaction.registerSecret(secret);
          },
          dispatch:
            execution === undefined
              ? undefined
              : (runId) => {
                  this.dispatcher?.wake(runId);
                },
        },
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

  /**
   * Install a plugin package from npm or a Git repository.
   *
   * Nothing of the package is imported and nothing is enabled: it lands in the
   * plugins directory, is read by the same discovery the loader uses at startup, and
   * waits for a person to enable it and grant what it asks for. The installed list
   * refreshes straight away, because reading manifests runs no plugin code; the new
   * plugin itself is activated at the next start.
   */
  async installPlugin(source: PluginInstallSource): Promise<InstalledPluginPackage> {
    if (this.state !== "running" || this.stopPromise !== undefined) {
      throw new TypeError("Runtime daemon must be running before installing a plugin.");
    }
    const options = this.pluginOptions;
    if (options === undefined) {
      throw new PluginInstallError(
        "INSTALL_NOT_ALLOWED",
        "This runtime has no plugins directory, so there is nowhere to install one.",
      );
    }
    const pluginsDirectory = options.directory ?? DEFAULT_PLUGINS_DIRECTORY;
    const installed = await installPluginPackage({
      pluginsDirectory,
      source,
      ...(options.install === undefined ? {} : { allow: options.install }),
      ...(options.harnessVersion === undefined ? {} : { harnessVersion: options.harnessVersion }),
    });
    // The new plugin is only activated at the next start, but what is installed
    // can refresh now, because reading manifests runs no plugin code.
    await this.rescanPlugins();
    return installed;
  }

  /**
   * What a UI is told about plugins.
   *
   * The loaded report, plus whether this harness installs at all and from where, so a
   * page can offer installing only where the host turned it on rather than offering a
   * button that always refuses. Installing still enables nothing.
   */
  private servedPluginReport(): RuntimePluginReport & {
    readonly install: { readonly npm: boolean; readonly git: boolean };
  } {
    const install = this.pluginOptions?.install;
    return Object.freeze({
      ...this.pluginReport,
      install: Object.freeze({ npm: install?.npm === true, git: install?.git === true }),
    });
  }

  /**
   * Re-read the plugins directory.
   *
   * Manifests only: nothing a package ships is imported, so this is safe while runs
   * are in flight. It refreshes what is installed and what each package asks for;
   * enabling, granting and activating remain start-time decisions.
   */
  async rescanPlugins(): Promise<RuntimePluginReport> {
    const options = this.pluginOptions;
    if (options === undefined) return this.pluginReport;
    this.pluginReport = Object.freeze({
      ...this.pluginReport,
      installed: await listInstalledPlugins(options),
    });
    return this.pluginReport;
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
        // GitHub is a first-party component: a workflow uses it only by wiring it in.
        // Its token, when there is one, is read per request and never recorded.
        const githubToken = process.env["GITHUB_TOKEN"];
        if (githubToken !== undefined && githubToken.length > 0) {
          this.redaction.registerSecret(githubToken);
        }
        const githubApi = process.env["GITHUB_API_URL"];
        await host.activate(
          createGitHubPlugin({
            ...(githubApi === undefined || githubApi.length === 0 ? {} : { apiBaseUrl: githubApi }),
            token: () => {
              const token = process.env["GITHUB_TOKEN"];
              return token === undefined || token.length === 0 ? undefined : token;
            },
          }),
        );
        const loaded = await loadRuntimePlugins(this.pluginOptions, host);
        this.pluginHost = loaded.host;
        this.pluginReport = loaded.report;
        this.pluginSandboxes = loaded.sandboxes;
        this.pluginPolicies = loaded.policies;
        // Models a person configured are registered beside the plugins', and their
        // keys are redacted out of everything this runtime records from here on.
        this.models = new RuntimeModels({
          database: this.database,
          register: (adapter) => loaded.host.models.register(adapter),
          registerSecret: (secret) => this.redaction.registerSecret(secret),
        });
        this.models.load();
      }
      await this.httpServer.start();
    } catch (error) {
      this.database.close();
      throw error;
    }
    this.state = "running";
    try {
      this.dispatcher?.start();
      // After the dispatcher, so a trigger that fires immediately has somewhere to run.
      this.triggerSchedule.start();
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

  /** How this daemon would resolve a node type now, for the dispatcher's plan checks. */
  private resolveNodePin(
    type: string,
    version: string,
  ): { readonly pluginId: string; readonly pluginVersion: string } | undefined {
    const resolution = createCompositeNodeResolver({
      ...(this.pluginHost === undefined ? {} : { host: this.pluginHost }),
      sandboxes: this.pluginSandboxes,
    }).getResolution(type, version);
    return resolution === undefined
      ? undefined
      : { pluginId: resolution.plugin.id, pluginVersion: resolution.plugin.version };
  }

  private executePluginNode(request: RuntimeNodeExecution): Promise<RuntimeNodeExecutionResult> {
    const plugins = createPluginNodeExecutor({
      ...(this.pluginHost === undefined ? {} : { host: this.pluginHost }),
      sandboxes: this.pluginSandboxes,
      policies: this.pluginPolicies,
    });
    const host = this.pluginHost;
    if (host === undefined) return plugins(request);
    // Agent steps get the plugins' models, limited to granted capabilities, plus
    // whatever models a person configured here, which carry their own authority.
    // Plugin tools reach a step only through a component wired into it, and only
    // tools whose plugin was granted what they need — first-party ones excepted.
    return createAgentNodeExecutor({
      database: this.database,
      models: host.models,
      componentTools: host.tools.listManifests().flatMap((manifest) => {
        const adapter = host.tools.getAdapter(manifest.id, manifest.version);
        if (adapter === undefined) return [];
        const pluginId = host.tools.getResolution(manifest.id, manifest.version)?.plugin.id;
        if (pluginId === GITHUB_PLUGIN_ID) return [adapter];
        const policy = pluginId === undefined ? undefined : this.pluginPolicies.get(pluginId);
        const granted = manifest.behavior.requiredCapabilities.every(
          (capability) => policy?.allows(capability) === true,
        );
        return granted ? [adapter] : [];
      }),
      allows: (capability) => this.pluginAuthority(capability).decision === "allow",
      configuredModels: () => this.configuredModelIds(),
      modelSecrets: (modelId) => this.models?.secretsFor(modelId),
      fallback: plugins,
    })(request);
  }

  /** Ids of the models a person configured in this harness. */
  private configuredModelIds(): ReadonlySet<string> {
    return new Set(listModelConfigs(this.database.connection()).map((model) => model.modelId));
  }

  /**
   * Ask a configured model to answer, so a wrong key or model name is found here.
   *
   * One request for a single token, with the same credential path a run would use.
   * Failures come back as the transport's own code rather than an exception: this
   * is a question a person asked, not a run going wrong.
   */
  private async checkModel(modelId: string): Promise<ModelCheckResult> {
    const host = this.pluginHost;
    const adapter = host?.models.getAdapter(modelId, "1");
    if (adapter === undefined) {
      return {
        ok: false,
        code: "MODEL_NOT_REGISTERED",
        reason: "This model is configured but not registered; restart the runtime.",
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 30_000);
    const startedAt = Date.now();
    const secrets = this.models?.secretsFor(modelId);
    try {
      await adapter.generate(
        {
          messages: [{ role: "user", parts: [{ kind: "text", text: "ping" }] }],
          maxOutputTokens: 1,
        },
        {
          runId: `model-check:${modelId}`,
          opIndex: 0,
          iteration: 0,
          attempt: 1,
          logicalEffectId: `model-check:${modelId}:${String(startedAt)}`,
          signal: controller.signal,
          retryBudget: {
            maxAttempts: 1,
            repeatAuthorized: false,
            usedAttempts: 1,
            remainingAttempts: 0,
            reportInternalRetries: () => 0,
          },
          ...(secrets === undefined ? {} : { secrets }),
        },
      );
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code: unknown }).code
          : undefined;
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? (error as { readonly status: unknown }).status
          : undefined;
      return {
        ok: false,
        code: typeof code === "string" ? code : "MODEL_CHECK_FAILED",
        ...(typeof status === "number" ? { status } : {}),
        reason:
          error instanceof Error && error.message.length > 0
            ? error.message
            : "The endpoint did not answer.",
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Node/model/tool catalogs contributed by activated plugins. */
  get plugins(): PluginHost | undefined {
    return this.pluginHost;
  }

  private async stopOnce(): Promise<boolean> {
    const schedule = this.triggerSchedule.stop();
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
      await schedule;
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
