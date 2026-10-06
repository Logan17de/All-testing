import {
  createRuntimePluginMakerController,
  type RuntimePluginMakerController,
} from "./runtime-plugin-maker-controller.js";
import { createRuntimePluginMakerHost } from "./runtime-plugin-maker-host.js";
import { createRuntimePluginMaker, type RuntimePluginMaker } from "./runtime-plugin-maker.js";
import { createPluginMakerPlugin } from "./runtime-plugin-maker-tools.js";
import {
  DURABLE_ASSISTANT_TOOL_ACCESS_MIGRATION,
  PARENT_DELEGABLE_NATIVE_TOOL_IDS,
} from "./runtime-assistant-tool-access.js";
import { DURABLE_NATIVE_CHAT_RUNS_MIGRATION } from "./runtime-native-chat-runs.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  DURABLE_ASSISTANT_ACCESS_MIGRATION,
  assertAssistantAccess,
} from "./runtime-assistant-access.js";
import {
  createRuntimeAssistantService,
  type RuntimeAssistantService,
} from "./runtime-assistant-service.js";
import { createRuntimeAssistantTools } from "./runtime-assistant-tools.js";
import { RuntimeAssistantController } from "./runtime-assistant-controller.js";
import { withoutPrivateModelState } from "./runtime-public-model-state.js";
import { collectInstalledAgentPluginTools } from "./runtime-agent-plugin-tools.js";
import {
  readNativeChatToolScopes,
  saveNativeChatToolScopes,
  DURABLE_NATIVE_CHAT_SCOPES_MIGRATION,
} from "./runtime-coding-plugin-scopes.js";
import {
  RuntimeCodingImageStore,
  type CodingImageAuthority,
} from "./runtime-coding-image-store.js";
import { createRuntimeCodingDesktopTools } from "./runtime-coding-desktop-tools.js";
import { configuredDesktopController } from "./runtime-desktop-http.js";
import { createRuntimeBrowserTools } from "./runtime-browser-tools.js";
import { RuntimeBrowserService } from "./runtime-browser-service.js";
import { createPlaywrightBrowserDriver } from "./runtime-browser-driver.js";
import { providerAwaitingDecision } from "./runtime-provider-policy.js";
import { resolve, dirname, join, relative, isAbsolute, sep } from "node:path";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createChatGPTPlanModelAdapter, listChatGPTPlanModels } from "./runtime-chatgpt-model.js";

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
  DURABLE_MODEL_CONNECTIONS_MIGRATION,
  listModelConfigs,
} from "@zet-harness/db/durable-model-records";
import { DURABLE_APP_SETTINGS_MIGRATION } from "@zet-harness/db/durable-setting-records";
import { DURABLE_WORKSPACES_MIGRATION } from "@zet-harness/db/durable-workspace-records";
import { DURABLE_TRIGGER_FIRES_MIGRATION } from "@zet-harness/db/durable-trigger-fire-records";
import { DURABLE_TRIGGERS_MIGRATION } from "@zet-harness/db/durable-trigger-records";
import { DURABLE_PROJECTS_MIGRATION } from "@zet-harness/db/durable-project-records";

import {
  PluginHost,
  createAgentPlugin,
  createBoxesPlugin,
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
import { ChatGPTLoginController } from "./runtime-chatgpt-auth-http.js";
import { CodexSearchBridge } from "./runtime-codex-search.js";
import { createRuntimeCodingSearchTool } from "./runtime-coding-search-tool.js";
import {
  RuntimeCodingService,
  type NativeAgentToolCatalogEntry,
} from "./runtime-coding-service.js";
import type { AdapterInvocationContext, JsonObject, ToolAdapter } from "@zet-harness/plugin-api";
import { createRuntimeCodingSubagentTool } from "./runtime-coding-subagents.js";
import { createRuntimeCodingTools } from "./runtime-coding-tools.js";
import { readConversation } from "@zet-harness/db/durable-conversation-records";
import { readProject } from "@zet-harness/db/durable-project-records";
import { readWorkspace } from "./runtime-setup-http.js";
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
  DURABLE_APP_SETTINGS_MIGRATION,
  DURABLE_MODEL_CONNECTIONS_MIGRATION,
  DURABLE_WORKSPACES_MIGRATION,
  DURABLE_NATIVE_CHAT_SCOPES_MIGRATION,
  DURABLE_ASSISTANT_ACCESS_MIGRATION,
  DURABLE_NATIVE_CHAT_RUNS_MIGRATION,
  DURABLE_ASSISTANT_TOOL_ACCESS_MIGRATION,
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
  private openedDatabasePath: string | undefined;
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
  private readonly agent: RuntimeCodingService;
  private readonly assistantUserAuthority = Object.freeze({});
  private readonly pluginMakerUserAuthority = Object.freeze({});
  private pluginMakerGeneration = 0;
  private pluginMakerWorkspace: string | undefined;
  private pluginMakerScope: string | undefined;
  private pluginMakerState: RuntimePluginMaker | undefined;
  private pluginMakerController: RuntimePluginMakerController | undefined;
  private readonly pluginMaker = new Proxy({} as RuntimePluginMaker, {
    get: (_target, key) => {
      const current = this.currentPluginMaker();
      const value: unknown = Reflect.get(current, key) as unknown;
      return typeof value === "function"
        ? (...args: unknown[]) => Reflect.apply(value, current, args) as unknown
        : value;
    },
  });
  private assistantService: RuntimeAssistantService | undefined;
  private readonly assistantSignals = new Map<string, AbortController>();
  private readonly assistantInvocation = new AsyncLocalStorage<AdapterInvocationContext>();
  private readonly desktop = configuredDesktopController();
  private readonly imageInvocations = new Map<
    string,
    { authority: CodingImageAuthority; signal: AbortSignal }
  >();
  private readonly images = new RuntimeCodingImageStore({
    isCurrent: (authority) => this.imageAuthorityCurrent(authority),
  });
  private readonly browser: RuntimeBrowserService;
  private readonly chatGPTLogin = new ChatGPTLoginController(
    process.env["ZET_CHATGPT_HOST_ID"] ? { hostId: process.env["ZET_CHATGPT_HOST_ID"] } : {},
  );
  private chatGPTCatalogAccountKey: string | undefined;
  private readonly codexSearch = process.env["ZET_CHATGPT_SEARCH_MODEL"]
    ? new CodexSearchBridge({
        model: process.env["ZET_CHATGPT_SEARCH_MODEL"],
        accessToken: () => this.chatGPTLogin.auth.accessToken(),
      })
    : undefined;
  private readonly chatGPTModels = new Map<
    string,
    { id: string; displayName: string; provider: string; model: string }
  >();
  private readonly childTools = new Map<string, ToolAdapter>();
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
    const database = this.database;
    this.browser = new RuntimeBrowserService({
      cwd: () => readWorkspace(database)?.path ?? process.cwd(),
      createDriver: async (options) => {
        const { chromium } = await import("playwright-core");
        return createPlaywrightBrowserDriver({ ...options, engine: chromium });
      },
    });
    this.agent = new RuntimeCodingService({
      database,
      workspace: () => readWorkspace(database)?.path ?? process.cwd(),
      approvals: this.approvals,
      sources: () => ({
        ...(this.pluginHost === undefined ? {} : { host: this.pluginHost }),
        sandboxes: this.pluginSandboxes,
      }),
      capabilityAuthority: () => authority ?? { evaluate: () => ({ decision: "deny" as const }) },
      redact: (value) => this.redaction.redact(withoutPrivateModelState(value)),
      dispatch: execution === undefined ? undefined : (runId) => this.dispatcher?.wake(runId),
      modelCatalog: () => this.codingModelCatalog(),
      toolCatalog: () => this.installedAgentToolCatalog(),
      browserGeneration: () => {
        const state = this.browser.snapshot();
        return state.armed ? state.generation : undefined;
      },
      desktopGeneration: () => {
        const state = this.desktop.snapshot();
        return state.state === "armed" ? state.generation : undefined;
      },
      revokeRun: (runId) => {
        this.assistantSignals.get(runId)?.abort(new Error("Native run policy revoked."));
        this.assistantSignals.delete(runId);
        this.images.revokeRun(runId);
        for (const [key, invocation] of this.imageInvocations)
          if (invocation.authority.runId === runId) this.imageInvocations.delete(key);
      },
      roleInstructions: (sessionId) => {
        if (!this.hasAssistantSchema()) return undefined;
        const root = this.database
          .connection()
          .prepare("SELECT 1 FROM assistant_roots WHERE assistant_id=?")
          .get(sessionId);
        return root
          ? "You are the user's personal assistant. Help plan and coordinate work using only the currently offered assistant chat tools and explicit graph connections. Existing chats are private unless connected by the user. Read permitted chats for current context, create child chats with an explicit subset of your current read/control grants, and delegate bounded coding tasks only to those created children. Connected ordinary chats support read/status and interruption of their own native turns with current read/control grants; they cannot be delegated into. Children receive scoped chat and native coding tools within inherited user-granted tool restrictions. Mutation opt-in is inherited from the originating user turn, but each write/process/Git/worktree action still requires its own exact human approval. Private runtime database files and sidecars are excluded from filesystem and sandbox execution. Plugin/MCP, browser and desktop tools remain unavailable in assistant-bound turns; use a separately authorized normal coding chat for those operations. You cannot connect or reconnect chats. You may decide child tool requests only within an explicit user-delegated ceiling and your current frozen tool authority; requests beyond that ceiling require the user. Grant changes cancel active turns and take effect on a fresh turn. Revocation cancels pending work and excludes past source-bearing context from future turns; never claim retroactive forgetting of already observed outputs."
          : undefined;
      },
      restrictToolScopes: (sessionId, scope) => {
        if (!this.hasAssistantSchema()) return scope;
        const db = this.database.connection();
        let current = sessionId;
        let model = scope.model,
          tools = scope.tools;
        const seen = new Set<string>();
        for (let depth = 0; depth < 64; depth++) {
          if (seen.has(current)) throw new Error("Assistant ancestry cycle.");
          seen.add(current);
          const actor = db
            .prepare("SELECT parent_chat_id FROM assistant_actors WHERE chat_id=?")
            .get(current);
          if (!actor || actor.parent_chat_id === null) return { model, tools };
          if (typeof actor.parent_chat_id !== "string")
            throw new Error("Assistant parent unavailable.");
          current = actor.parent_chat_id;
          const parent = readNativeChatToolScopes(db, current);
          const intersect = (a: string[] | null, b: string[] | null) =>
            a === null ? b : b === null ? a : a.filter((id) => b.includes(id));
          model = intersect(model, parent.model);
          tools = intersect(tools, parent.tools);
        }
        throw new Error("Assistant ancestry limit.");
      },
      prepareTurn: (sessionId) => {
        if (!this.hasAssistantSchema()) return undefined;
        const actor = this.database
          .connection()
          .prepare("SELECT assistant_id FROM assistant_actors WHERE chat_id=?")
          .get(sessionId);
        if (!actor) return undefined;
        const binding = this.assistants().issueBinding(String(actor.assistant_id), sessionId);
        return {
          check: () =>
            assertAssistantAccess(this.database.connection(), binding, sessionId, "control"),
          bind: (runId: string, target: string) => {
            this.assistants().bindRun(runId, binding, target, "user");
            this.assistantSignals.set(runId, new AbortController());
          },
        };
      },
      beforeDispatch: (runId, sessionId) => {
        if (!this.hasAssistantSchema()) return;
        const actor = this.database
          .connection()
          .prepare("SELECT assistant_id FROM assistant_actors WHERE chat_id=?")
          .get(sessionId);
        if (actor) {
          const binding = this.assistants().issueBinding(String(actor.assistant_id), sessionId);
          this.assistants().bindRun(runId, binding, sessionId, "user");
          this.assistantSignals.set(runId, new AbortController());
        }
      },
      providerIdentity: () => this.currentChatGPTAccountKey(),
      isModelConfigured: (modelId) =>
        this.configuredModelIds().has(modelId) &&
        this.pluginHost?.models.has(modelId, "1") === true,
      cancel: async (runId) => {
        if (!this.dispatcher) throw new Error("No execution adapter configured.");
        await this.dispatcher.cancelRun(runId);
      },
    });
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
    // The loopback API uses the same native session and configured provider services.
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
        setup: {
          database: this.database,
          onWorkspaceSelection: () => {
            this.pluginMakerGeneration++;
            this.pluginMakerController?.invalidateScope();
            this.pluginMakerState = undefined;
            this.pluginMakerScope = undefined;
            this.agent.close();
          },
        },
        pluginMaker: this.createPluginMakerController(),
        agent: this.agent,
        assistant: new RuntimeAssistantController({
          database: this.database,
          coding: this.agent,
          assistant: () => this.assistants(),
          userAuthority: this.assistantUserAuthority,
          workspace: () => readWorkspace(this.database)?.path ?? process.cwd(),
        }),
        browser: this.browser,
        desktop: this.desktop,
        chatGPTAuth: {
          controller: this.chatGPTLogin,
          ...(this.codexSearch ? { search: this.codexSearch } : {}),
        },
        connections: {
          database: this.database,
        },
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
          redact: (value) => this.redaction.redact(withoutPrivateModelState(value)),
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
          redact: (value) => this.redaction.redact(withoutPrivateModelState(value)),
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
    return this.eventStream.publish(type, this.redaction.redact(withoutPrivateModelState(data)));
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
    this.openedDatabasePath = this.database.snapshot().inMemory
      ? undefined
      : resolve(this.database.snapshot().path);
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
        // Text box, Model and Output box: text in, text out, no conversation needed.
        await host.activate(createBoxesPlugin());
        await host.activate(createPluginMakerPlugin(this.pluginMaker));
        // GitHub exposes first-party read components and owned read tools to authorized agents.
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

  private async executePluginNode(
    request: RuntimeNodeExecution,
  ): Promise<RuntimeNodeExecutionResult> {
    const assistantRun = this.assistantRun(request.runId);
    if (assistantRun) {
      const currentChat = request.operation.config["conversationId"];
      if (typeof currentChat === "string" && currentChat !== assistantRun.targetChatId)
        throw new Error("Assistant run cannot switch chat identity.");
      let controller = this.assistantSignals.get(request.runId);
      if (!controller) {
        controller = new AbortController();
        this.assistantSignals.set(request.runId, controller);
      }
      request = { ...request, signal: AbortSignal.any([request.signal, controller.signal]) };
    } else {
      const chat = request.operation.config["conversationId"];
      if (
        this.hasAssistantSchema() &&
        typeof chat === "string" &&
        this.database
          .connection()
          .prepare("SELECT 1 FROM assistant_actors WHERE chat_id=?")
          .get(chat)
      )
        throw new Error("Assistant graph execution requires a current bound run.");
    }
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
    const config = request.operation.config as Record<string, unknown>;
    const conversation =
      typeof config["conversationId"] === "string"
        ? readConversation(this.database.connection(), config["conversationId"])
        : undefined;
    const project = conversation
      ? readProject(this.database.connection(), conversation.projectId)
      : undefined;
    const planner =
      assistantRun?.targetChatId === assistantRun?.binding.assistantId &&
      assistantRun !== undefined;
    const databasePath = this.openedDatabasePath;
    const privatePaths =
      databasePath !== undefined
        ? Object.freeze([databasePath, `${databasePath}-wal`, `${databasePath}-shm`])
        : Object.freeze([] as string[]);
    const codingTools =
      !planner && project?.workspacePath
        ? createRuntimeCodingTools({ root: project.workspacePath, privatePaths }).map((tool) => ({
            ...tool,
            invoke: async (input: JsonObject, context: AdapterInvocationContext) => {
              if (typeof input["path"] === "string") {
                const path = resolve(project.workspacePath!, input["path"]);
                const privatePath = resolve(this.database.snapshot().path);
                const norm = (value: string) =>
                  process.platform === "win32" ? value.toLowerCase() : value;
                if (
                  [privatePath, `${privatePath}-wal`, `${privatePath}-shm`]
                    .map(norm)
                    .includes(norm(path))
                )
                  throw new Error("Private runtime state is not a coding resource.");
              }
              return tool.invoke(input, context);
            },
          }))
        : [];
    const toolPolicy = this.agent.toolPolicy(request.runId);
    const { createRuntimeGitTools } = project?.workspacePath
      ? await import("./runtime-coding-git-tools.js")
      : { createRuntimeGitTools: undefined };
    const mutationFactories =
      !planner && project?.workspacePath && toolPolicy?.mutationConsent
        ? await Promise.all([
            import("./runtime-coding-mutation-tools.js"),
            import("./runtime-coding-file-tools.js"),
          ])
        : undefined;
    const mutationTools =
      project?.workspacePath && mutationFactories
        ? mutationFactories[0]
            .createRuntimeMutationTools({
              root: project.workspacePath,
              privatePaths,
              approve: (tool, context) => this.agent.approveTool(tool, context),
            })
            .filter(
              (tool) => process.platform !== "win32" || tool.manifest.id !== "harness.fs.write",
            )
        : [];
    const fileTools =
      project?.workspacePath && mutationFactories
        ? mutationFactories[1].createRuntimeCodingFileTools({
            root: project.workspacePath,
            privatePaths,
            approve: (tool, context) => this.agent.approveTool(tool, context),
          })
        : [];
    const gitTools =
      !planner && project?.workspacePath && createRuntimeGitTools
        ? createRuntimeGitTools({
            root: project.workspacePath,
            privatePaths,
            sandbox: async (request) => {
              const { runSandboxedProcess } = await import("./runtime-process-sandbox.js");
              return runSandboxedProcess(request, undefined, undefined, undefined, privatePaths);
            },
            managedJournalPath: isAbsolute(this.database.snapshot().path)
              ? join(
                  resolve(dirname(this.database.snapshot().path), "managed-worktrees"),
                  `${createHash("sha256").update(project.workspacePath).digest("hex")}.json`,
                )
              : undefined,
            ...(toolPolicy?.mutationConsent
              ? {
                  approve: (
                    tool: { tool: string; args: JsonObject },
                    context: AdapterInvocationContext,
                  ) => this.agent.approveTool(tool, context),
                }
              : {}),
          })
        : [];
    if (
      !assistantRun &&
      toolPolicy?.subagentsEnabled &&
      !this.childTools.has(request.runId) &&
      this.childTools.size < 1000
    ) {
      this.childTools.set(
        request.runId,
        createRuntimeCodingSubagentTool({
          readTools: codingTools,
          generate: async (childRequest, context) => {
            if (!this.configuredModelIds().has(toolPolicy.modelId))
              throw new Error("Selected child inference model unavailable.");
            const adapter = host.models.getAdapter(toolPolicy.modelId, "1");
            if (!adapter) throw new Error("Selected child inference model unavailable.");
            const secrets = this.models?.secretsFor(toolPolicy.modelId);
            const result = await adapter.generate(childRequest, {
              ...context,
              ...(secrets === undefined ? {} : { secrets }),
            });
            return result;
          },
        }),
      );
    }
    const childTool = toolPolicy?.subagentsEnabled ? this.childTools.get(request.runId) : undefined;
    const searchTool =
      toolPolicy?.searchEnabled &&
      this.codexSearch &&
      this.chatGPTLogin.status().state === "connected" &&
      toolPolicy.providerIdentity === this.currentChatGPTAccountKey()
        ? createRuntimeCodingSearchTool({
            search: (query, signal) => {
              const bridge = new CodexSearchBridge({
                model: process.env["ZET_CHATGPT_SEARCH_MODEL"]!,
                accessToken: () => this.accountBoundChatGPTToken(toolPolicy.providerIdentity),
              });
              return bridge.search(query, signal);
            },
          })
        : undefined;
    const browserTools =
      !assistantRun && toolPolicy?.browserEnabled && toolPolicy.browserGeneration !== undefined
        ? createRuntimeBrowserTools(this.browser, toolPolicy.browserGeneration)
        : [];
    let worktreeJournalPath: string | undefined;
    const worktreeTools: ToolAdapter[] = [];
    if (
      !planner &&
      project?.workspacePath &&
      toolPolicy?.mutationConsent &&
      process.platform === "linux"
    ) {
      const stateRoot = resolve(dirname(this.database.snapshot().path), "managed-worktrees");
      const rel = relative(project.workspacePath, stateRoot);
      if (
        isAbsolute(this.database.snapshot().path) &&
        (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      ) {
        await mkdir(stateRoot, { recursive: true, mode: 0o700 });
        worktreeJournalPath = join(
          stateRoot,
          `${createHash("sha256").update(project.workspacePath).digest("hex")}.json`,
        );
        const [{ createRuntimeWorktreeTools }, { runSandboxedManagedWorktree }] = await Promise.all(
          [import("./runtime-coding-worktrees.js"), import("./runtime-process-sandbox.js")],
        );
        worktreeTools.push(
          ...createRuntimeWorktreeTools({
            root: project.workspacePath,
            journalPath: worktreeJournalPath,
            approve: (tool, context) => this.agent.approveTool(tool, context),
            sandbox: (request, scope) => runSandboxedManagedWorktree(request, scope, privatePaths),
          }),
        );
      }
    }
    const imageAuthority = this.codingImageAuthority(request.runId);
    const desktopTools =
      !assistantRun && imageAuthority
        ? createRuntimeCodingDesktopTools({
            controller: this.desktop,
            authority: imageAuthority,
            imageStore: this.images,
          })
        : [];
    const assistantTools = assistantRun
      ? createRuntimeAssistantTools(this.assistants(), assistantRun.binding).map((tool) => ({
          ...tool,
          invoke: (input: JsonObject, context: AdapterInvocationContext) =>
            this.assistantInvocation.run(context, () => tool.invoke(input, context)),
        }))
      : [];
    const nativeTools = [
      ...assistantTools,
      ...(!planner
        ? [
            ...codingTools,
            ...mutationTools,
            ...fileTools,
            ...gitTools,
            ...browserTools,
            ...desktopTools,
            ...worktreeTools,
          ]
        : []),
      ...(!planner && childTool ? [childTool] : []),
      ...(!planner && searchTool ? [searchTool] : []),
    ];
    const installed = assistantRun ? [] : this.installedAgentPluginTools(host);
    const nativeOwners = new WeakSet<ToolAdapter>(nativeTools);
    const installedOwners = new WeakMap<ToolAdapter, string>(
      installed.map(({ adapter, owner }) => [adapter, owner]),
    );
    const installedTools = installed.map(({ adapter }) => adapter);
    return createAgentNodeExecutor({
      database: this.database,
      assertInvocation: (context) => {
        context.signal.throwIfAborted();
        if (assistantRun) {
          this.assistants().assertRunAccess(context.runId);
          const policy = this.agent.toolPolicy(context.runId);
          if (
            !policy ||
            policy.sessionId !== assistantRun.targetChatId ||
            (typeof config["modelId"] === "string" && policy.modelId !== config["modelId"])
          )
            throw new Error("Assistant run policy expired.");
        }
      },
      projectContext: !assistantRun,
      filterMessagePath: (context, chatId, path) => {
        if (!assistantRun) return path;
        const scoped = this.assistants().assertRunAccess(context.runId);
        if (scoped.targetChatId !== chatId)
          throw new Error("Assistant conversation identity changed.");
        const floor = this.assistants().contextFloor(scoped.binding, chatId);
        if (!floor) return path;
        const index = path.findIndex((message) => message.messageId === floor);
        if (index < 0)
          throw new Error("Revoked assistant context cannot be replayed through another branch.");
        return path.slice(index + 1);
      },
      models: host.models,
      tools: [...nativeTools, ...installedTools],
      // These are the same guarded instances as the default tools, never raw registry adapters.
      componentTools: installedTools,
      toolOwner: (tool) => (nativeOwners.has(tool) ? "harness.native" : installedOwners.get(tool)),
      allows: (capability) =>
        (["assistant:read", "assistant:control"].includes(capability) &&
          assistantTools.length > 0) ||
        (capability === "desktop:task" && desktopTools.length > 0) ||
        (capability === "browser:task" && browserTools.length > 0) ||
        (capability === "git:read" && gitTools.length > 0) ||
        (capability === "git:worktree" && worktreeTools.length > 0) ||
        (capability === "git:write" && toolPolicy?.mutationConsent === true) ||
        (capability === "fs:read" && codingTools.length > 0) ||
        (["fs:write", "process:exec"].includes(capability) && mutationTools.length > 0) ||
        (capability === "agent:delegate" && childTool !== undefined) ||
        (capability === "network:codex-search" && searchTool !== undefined) ||
        installed.some(({ adapter }) =>
          adapter.manifest.behavior.requiredCapabilities.includes(capability),
        ) ||
        (capability === "plugin:author" && !assistantRun) ||
        this.pluginAuthority(capability).decision === "allow",
      configuredModels: () => this.configuredModelIds(),
      providerStatePolicy: (context, sessionId, modelId) => {
        const grant = this.agent.toolPolicy(context.runId);
        return grant?.explicitModelSelection &&
          grant.sessionId === sessionId &&
          grant.modelId === modelId
          ? "omit-incompatible"
          : "require";
      },
      modelUserParts: (context, sessionId, modelId) => {
        if (
          request.operation.sourceNodeId !== "reply" ||
          context.runId !== request.runId ||
          context.opIndex !== request.op ||
          context.signal.aborted ||
          !context.toolScope?.includes("harness.desktop.share")
        )
          return [];
        const authority = this.codingImageAuthority(context.runId);
        if (!authority || authority.sessionId !== sessionId || authority.modelId !== modelId)
          return [];
        const parts = this.images.partsFor(authority);
        if (parts.length) {
          if (this.imageInvocations.size >= 1000)
            throw new Error("Image invocation capacity reached.");
          this.imageInvocations.set(`${context.runId}:${context.logicalEffectId}`, {
            authority,
            signal: context.signal,
          });
          context.signal.addEventListener("abort", () => this.images.revokeRun(context.runId), {
            once: true,
          });
        }
        return parts;
      },
      modelSecrets: (modelId) => this.models?.secretsFor(modelId),
      onStreamProgress: (progress) => {
        this.publishEvent("model.progress", progress);
      },
      fallback: plugins,
    })(request);
  }

  private installedAgentPluginTools(host = this.pluginHost) {
    if (!host) return [];
    return collectInstalledAgentPluginTools({
      host,
      allows: (pluginId, capability) =>
        pluginId === "zet.plugin-maker"
          ? capability === "plugin:author"
          : pluginId === GITHUB_PLUGIN_ID
            ? capability === "network:https"
            : this.pluginPolicies.get(pluginId)?.allows(capability) === true,
      approve: (request, context) => this.agent.approveTool(request, context),
    })
      .map((entry) => {
        const pluginId = host.tools.getResolution(
          entry.adapter.manifest.id,
          entry.adapter.manifest.version,
        )?.plugin.id;
        if (pluginId !== "zet.plugin-maker") return entry;
        const captured = entry.adapter;
        return {
          ...entry,
          adapter: {
            ...captured,
            invoke: async (input: JsonObject, context: AdapterInvocationContext) => {
              context.signal.throwIfAborted();
              const policy = this.agent.toolPolicy(context.runId);
              const root = readWorkspace(this.database)?.path;
              const generation = this.pluginMakerScopeGeneration();
              if (!policy || !root || policy.root !== root || this.assistantRun(context.runId))
                throw new Error("Plugin maker invocation authority expired.");
              const result = await captured.invoke(input, context);
              context.signal.throwIfAborted();
              if (
                this.agent.toolPolicy(context.runId) !== policy ||
                readWorkspace(this.database)?.path !== root ||
                this.pluginMakerScopeGeneration() !== generation
              )
                throw new Error("Plugin maker invocation authority expired.");
              return result;
            },
          },
        };
      })
      .filter(({ adapter }) => {
        const pluginId = host.tools.getResolution(adapter.manifest.id, adapter.manifest.version)
          ?.plugin.id;
        return (
          pluginId !== GITHUB_PLUGIN_ID ||
          ["none", "external-read"].includes(adapter.manifest.behavior.effect)
        );
      });
  }
  private installedAgentToolCatalog(): readonly NativeAgentToolCatalogEntry[] {
    const host = this.pluginHost;
    if (!host) return [];
    return this.installedAgentPluginTools(host).map(({ adapter }) => ({
      id: adapter.manifest.id,
      title: adapter.manifest.title,
      pluginId: host.tools.getResolution(adapter.manifest.id, adapter.manifest.version)!.plugin.id,
      status: ["none", "external-read"].includes(adapter.manifest.behavior.effect)
        ? "enabled-host-granted"
        : "requires-turn-and-per-call-mutation-consent",
    }));
  }

  private pluginMakerScopeGeneration(): number {
    const root =
      this.database.snapshot().state === "open" &&
      this.database
        .connection()
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'")
        .get()
        ? readWorkspace(this.database)?.path
        : undefined;
    if (root !== this.pluginMakerWorkspace) {
      this.pluginMakerWorkspace = root;
      this.pluginMakerGeneration++;
      this.pluginMakerState = undefined;
      this.pluginMakerScope = undefined;
      this.pluginMakerController?.invalidateScope();
    }
    return this.pluginMakerGeneration;
  }

  private createPluginMakerController(): RuntimePluginMakerController {
    const host = createRuntimePluginMakerHost(
      {
        workspaceRoot: () => {
          const root = readWorkspace(this.database)?.path;
          if (!root) throw new Error("Select a workspace before authoring plugins.");
          return root;
        },
        scopeGeneration: () => this.pluginMakerScopeGeneration(),
        privatePaths: () =>
          this.openedDatabasePath
            ? [
                this.openedDatabasePath,
                `${this.openedDatabasePath}-wal`,
                `${this.openedDatabasePath}-shm`,
              ]
            : [],
        pluginOptions: () => this.pluginOptions ?? {},
        // This callback is reached only through the opaque human controller authority
        // after exact artifact/directory/scopes/execution confirmation; models cannot call it.
        approve: (_request, signal) => {
          signal.throwIfAborted();
          return Promise.resolve(true);
        },
      },
      this.pluginMakerUserAuthority,
    );
    this.pluginMakerController = createRuntimePluginMakerController({
      maker: this.pluginMaker,
      userAuthority: this.pluginMakerUserAuthority,
      scopeGeneration: () => this.pluginMakerScopeGeneration(),
      host: {
        materialize: async (artifact, directory, operation) => {
          await host.materialize(this.pluginMakerUserAuthority, artifact, directory, operation);
        },
        test: (artifact, directory, operation) =>
          host.test(this.pluginMakerUserAuthority, artifact, directory, operation),
        enable: async (artifact, directory, _scopes, operation) => {
          const result = await host.enable(
            this.pluginMakerUserAuthority,
            artifact,
            directory,
            { confirmTrustedCodeExecution: true },
            operation,
          );
          operation.check();
          await this.rescanPlugins();
          operation.check();
          return result;
        },
      },
    });
    return this.pluginMakerController;
  }

  private currentPluginMaker(): RuntimePluginMaker {
    const root = readWorkspace(this.database)?.path;
    if (!root) throw new Error("Plugin maker requires a selected workspace.");
    const scope = `${this.pluginMakerScopeGeneration()}:${root}`;
    if (this.pluginMakerScope !== scope || !this.pluginMakerState) {
      this.pluginMakerScope = scope;
      this.pluginMakerState = createRuntimePluginMaker(
        {
          write: () =>
            Promise.reject(new Error("Use the human-confirmed plugin maker materialize action.")),
        },
        this.pluginMakerUserAuthority,
      );
    }
    return this.pluginMakerState;
  }

  private hasAssistantSchema(): boolean {
    return !!this.database
      .connection()
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_runs'")
      .get();
  }
  private assistantRun(runId: string) {
    if (
      !this.hasAssistantSchema() ||
      !this.database.connection().prepare("SELECT 1 FROM assistant_runs WHERE run_id=?").get(runId)
    )
      return undefined;
    return this.assistants().assertRunAccess(runId);
  }
  private assistants(): RuntimeAssistantService {
    if (this.assistantService) return this.assistantService;
    const db = this.database.connection();
    this.assistantService = createRuntimeAssistantService(
      db,
      {
        toolCatalog: () =>
          PARENT_DELEGABLE_NATIVE_TOOL_IDS.filter(
            (id) =>
              ["linux", "win32"].includes(process.platform) &&
              (process.platform === "win32" ||
                !["harness.fs.rename", "harness.fs.delete"].includes(id)),
          ),
        parentToolAuthority: (binding, context) => {
          const invocation = this.assistantInvocation.getStore();
          if (invocation !== context || context.signal.aborted) return undefined;
          const run = this.assistants().assertRunAccess(context.runId);
          const policy = this.agent.toolPolicy(context.runId);
          if (
            !policy ||
            run.binding.assistantId !== binding.assistantId ||
            run.binding.actorChatId !== binding.actorChatId ||
            run.binding.epoch !== binding.epoch ||
            policy.sessionId !== run.targetChatId ||
            run.targetChatId !== binding.actorChatId
          )
            return undefined;
          const catalog = PARENT_DELEGABLE_NATIVE_TOOL_IDS.filter(
            (id) =>
              (process.platform === "win32" ||
                !["harness.fs.rename", "harness.fs.delete"].includes(id)) &&
              (policy.mutationConsent ||
                ![
                  "harness.fs.write",
                  "harness.fs.apply_patch",
                  "harness.fs.mkdir",
                  "harness.fs.rename",
                  "harness.fs.delete",
                  "harness.shell.run",
                  "harness.git.add",
                  "harness.git.commit",
                  "harness.git.worktree.create",
                  "harness.git.worktree.remove",
                ].includes(id)),
          );
          const model = catalog.filter(
            (id) => policy.modelToolScope === null || policy.modelToolScope.includes(id),
          );
          const tools = catalog.filter(
            (id) => policy.executionToolScope === null || policy.executionToolScope.includes(id),
          );
          const intersection = model.filter((id) => tools.includes(id));
          return { model: intersection, tools: intersection };
        },
        read: async (chatId, signal, binding) => {
          signal.throwIfAborted();
          await this.agent.action("session/graph", { sessionId: chatId });
          signal.throwIfAborted();
          assertAssistantAccess(db, binding, chatId, "read");
          const floor = this.assistants().contextFloor(binding, chatId);
          let boundary = 0;
          if (floor) {
            const row = db
              .prepare(
                "SELECT rowid AS ordinal FROM messages WHERE message_id=? AND conversation_id=?",
              )
              .get(floor, chatId);
            if (!row) throw new Error("Assistant context boundary unavailable.");
            boundary = Number(row.ordinal);
          }
          const rows = db
            .prepare(
              "SELECT message_id,role,CASE WHEN length(CAST(content_json AS BLOB))<=32768 THEN content_json ELSE NULL END AS content_json FROM messages WHERE conversation_id=? AND rowid>? ORDER BY rowid DESC LIMIT 41",
            )
            .all(chatId, boundary);
          let bytes = 0,
            truncated = rows.length > 40;
          const messages = [];
          for (const row of rows.slice(0, 40)) {
            const parts =
              row.content_json === null
                ? [{ kind: "text", text: "[Oversized authorized message omitted]" }]
                : withoutPrivateModelState(JSON.parse(String(row.content_json)));
            const message = { id: String(row.message_id), role: String(row.role), parts };
            const size = Buffer.byteLength(JSON.stringify(message));
            if (bytes + size > 65536) {
              truncated = true;
              continue;
            }
            bytes += size;
            messages.push(message);
          }
          return { chatId, messages: messages.reverse(), truncated, contextEpoch: binding.epoch };
        },
        status: async (chatId, signal, binding) => {
          signal.throwIfAborted();
          assertAssistantAccess(db, binding, chatId, "read");
          await this.agent.action("session/graph", { sessionId: chatId });
          signal.throwIfAborted();
          assertAssistantAccess(db, binding, chatId, "read");
          return {
            chatId,
            turns: db
              .prepare(
                "SELECT r.run_id AS id,r.status FROM native_chat_runs n JOIN runs r ON r.run_id=n.run_id LEFT JOIN assistant_runs a ON a.run_id=r.run_id WHERE n.conversation_id=? AND (a.run_id IS NULL OR (a.assistant_id=? AND a.target_chat_id=?)) ORDER BY r.created_at_ms DESC,r.run_id DESC LIMIT 20",
              )
              .all(chatId, binding.assistantId, chatId),
          };
        },
        create: async (parent, signal) => {
          signal.throwIfAborted();
          const source = readConversation(db, parent);
          if (!source) throw new Error("Assistant parent unavailable.");
          const result = (await this.agent.action("session/start", {
            projectId: source.projectId,
            title: "Assistant child",
          })) as { session: { id: string } };
          signal.throwIfAborted();
          saveNativeChatToolScopes(
            db,
            result.session.id,
            readNativeChatToolScopes(db, parent),
            Date.now(),
          );
          return result.session.id;
        },
        delegate: async (chatId, input, signal, binding) => {
          signal.throwIfAborted();
          if (
            Object.keys(input).some((key) => key !== "text") ||
            typeof input["text"] !== "string" ||
            !input["text"].trim() ||
            input["text"].length > 16000
          )
            throw new Error("Delegate requires only a bounded task text.");
          const invocation = this.assistantInvocation.getStore();
          if (!invocation || invocation.signal !== signal)
            throw new Error("Delegation requires a bound assistant tool invocation.");
          const parent = this.assistants().assertRunAccess(invocation.runId);
          if (
            parent.binding.assistantId !== binding.assistantId ||
            parent.binding.actorChatId !== binding.actorChatId ||
            parent.binding.epoch !== binding.epoch ||
            parent.origin !== "user"
          )
            throw new Error("Assistant delegation depth exceeded or authority changed.");
          const children = Number(
            db
              .prepare("SELECT count(*) AS total FROM runs WHERE parent_run_id=?")
              .get(invocation.runId)?.total ?? 0,
          );
          if (children >= 4) throw new Error("Assistant child run budget exceeded.");
          const policy = this.agent.toolPolicy(invocation.runId);
          if (!policy) throw new Error("Assistant parent run policy expired.");
          const childBinding = this.assistants().issueBinding(binding.assistantId, chatId);
          if (childBinding.actorChatId === childBinding.assistantId)
            throw new Error("Delegation requires an explicitly created child.");
          const inheritedScope =
            policy.modelToolScope === null
              ? policy.executionToolScope
              : policy.executionToolScope === null
                ? policy.modelToolScope
                : policy.modelToolScope.filter((id) => policy.executionToolScope!.includes(id));
          const result = (await this.agent.startAuthorizedTurn(
            {
              sessionId: chatId,
              modelId: policy.modelId,
              text: input["text"],
              mutationConsent: policy.mutationConsent,
              subagentsEnabled: false,
              searchEnabled: false,
              browserEnabled: false,
              desktopEnabled: false,
            },
            {
              toolAllowlist:
                inheritedScope === null ? undefined : Object.freeze([...inheritedScope]),
              check: () => {
                signal.throwIfAborted();
                this.assistants().assertRunAccess(invocation.runId);
                assertAssistantAccess(db, binding, chatId, "read");
                assertAssistantAccess(db, binding, chatId, "control");
              },
              bind: (runId, target) => {
                this.assistants().bindRun(runId, binding, target, "delegated");
                db.prepare("UPDATE runs SET parent_run_id=? WHERE run_id=?").run(
                  invocation.runId,
                  runId,
                );
                this.assistantSignals.set(runId, new AbortController());
              },
            },
          )) as { turn: { id: string; status: string } };
          return { chatId, turn: result.turn, delegationDepth: 1 };
        },
        control: async (chatId, input, signal, binding) => {
          signal.throwIfAborted();
          if (
            Object.keys(input).some((key) => key !== "action" && key !== "turnId") ||
            input["action"] !== "interrupt" ||
            typeof input["turnId"] !== "string"
          )
            throw new Error("Assistant control supports exact turn interruption only.");
          await this.agent.action("session/graph", { sessionId: chatId });
          signal.throwIfAborted();
          assertAssistantAccess(db, binding, chatId, "read");
          assertAssistantAccess(db, binding, chatId, "control");
          const run = db
            .prepare(
              "SELECT r.run_id,a.assistant_id,a.target_chat_id FROM native_chat_runs n JOIN runs r ON r.run_id=n.run_id LEFT JOIN assistant_runs a ON a.run_id=r.run_id WHERE r.run_id=? AND n.conversation_id=?",
            )
            .get(input["turnId"], chatId);
          if (
            !run ||
            (run.assistant_id !== null &&
              (run.assistant_id !== binding.assistantId || run.target_chat_id !== chatId))
          )
            throw new Error("Turn is outside the authorized native chat.");
          this.assistantSignals
            .get(input["turnId"])
            ?.abort(new Error("Assistant interrupted turn."));
          return this.agent.action("turn/interrupt", {
            sessionId: chatId,
            turnId: input["turnId"],
          });
        },
        revoke: (id) => {
          const runs = db.prepare("SELECT run_id FROM assistant_runs WHERE assistant_id=?").all(id);
          for (const row of runs) {
            const runId = String(row.run_id);
            this.assistantSignals.get(runId)?.abort(new Error("Assistant graph access revoked."));
            this.images.revokeRun(runId);
            void this.dispatcher?.cancelRun(runId).catch(() => undefined);
          }
        },
        invalidateMemory: (id, epoch) => {
          for (const chatId of this.assistants().revocationChatIds(id)) {
            const latest = db
              .prepare(
                "SELECT message_id FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
              )
              .get(chatId);
            this.assistants().setContextFloor(
              id,
              chatId,
              epoch,
              latest ? String(latest.message_id) : null,
            );
          }
        },
      },
      this.assistantUserAuthority,
    );
    return this.assistantService;
  }
  private codingImageAuthority(runId: string): CodingImageAuthority | undefined {
    const grant = this.agent.toolPolicy(runId);
    if (
      !grant?.desktopEnabled ||
      grant.desktopGeneration === undefined ||
      !grant.providerIdentity ||
      !this.chatGPTModels.has(grant.modelId)
    )
      return undefined;
    const authority: CodingImageAuthority = {
      runId,
      sessionId: grant.sessionId,
      modelId: grant.modelId,
      accountId: grant.providerIdentity,
      root: grant.root,
      desktopGeneration: grant.desktopGeneration,
    };
    return this.imageAuthorityCurrent(authority) ? authority : undefined;
  }
  private imageAuthorityCurrent(authority: CodingImageAuthority): boolean {
    const grant = this.agent.toolPolicy(authority.runId);
    const state = this.desktop.snapshot();
    return (
      !!grant &&
      grant.desktopEnabled &&
      grant.sessionId === authority.sessionId &&
      grant.modelId === authority.modelId &&
      grant.root === authority.root &&
      grant.desktopGeneration === authority.desktopGeneration &&
      state.state === "armed" &&
      state.generation === authority.desktopGeneration &&
      grant.providerIdentity === authority.accountId &&
      this.currentChatGPTAccountKey() === authority.accountId &&
      this.configuredModelIds().has(authority.modelId)
    );
  }
  private currentChatGPTAccountKey(): string | undefined {
    const account = this.chatGPTLogin.auth.account();
    return account
      ? createHash("sha256")
          .update(JSON.stringify([account.clientId, account.subject]))
          .digest("hex")
      : undefined;
  }
  private async accountBoundChatGPTToken(accountKey: string | undefined): Promise<string> {
    if (!accountKey || this.currentChatGPTAccountKey() !== accountKey)
      throw new Error("The selected ChatGPT account is no longer connected.");
    const token = await this.chatGPTLogin.auth.accessToken();
    if (this.currentChatGPTAccountKey() !== accountKey)
      throw new Error("The selected ChatGPT account changed.");
    return token;
  }
  private async codingModelCatalog() {
    const host = this.pluginHost;
    if (this.chatGPTLogin.status().state === "connected" && host) {
      const accountKey = this.currentChatGPTAccountKey();
      const discovered = await listChatGPTPlanModels({
        accessToken: () => this.accountBoundChatGPTToken(accountKey),
      });
      if (!accountKey || this.currentChatGPTAccountKey() !== accountKey)
        throw new Error("ChatGPT account changed while reading models.");
      this.chatGPTCatalogAccountKey = accountKey;
      this.chatGPTModels.clear();
      for (const model of discovered.slice(0, 100)) {
        const id = `chatgpt.${createHash("sha256")
          .update(JSON.stringify([accountKey, model.slug]))
          .digest("hex")
          .slice(0, 24)}`;
        if (!host.models.has(id, "1"))
          host.models.register(
            createChatGPTPlanModelAdapter({
              id,
              model: model.slug,
              stateScope: accountKey,
              resolveImage: async (ref, context) => {
                const invocation = this.imageInvocations.get(
                  `${context.runId}:${context.logicalEffectId}`,
                );
                if (
                  !invocation ||
                  invocation.signal !== context.signal ||
                  context.signal.aborted ||
                  !context.toolScope?.includes("harness.desktop.share") ||
                  invocation.authority.modelId !== id ||
                  invocation.authority.accountId !== accountKey
                )
                  throw new Error("Image invocation is not authorized.");
                return {
                  bytes: await this.images.resolve(ref, invocation.authority, context.signal),
                  mediaType: "image/png",
                };
              },
              validateImageAuthority: (context) => {
                const invocation = this.imageInvocations.get(
                  `${context.runId}:${context.logicalEffectId}`,
                );
                if (
                  !invocation ||
                  invocation.signal !== context.signal ||
                  context.signal.aborted ||
                  !context.toolScope?.includes("harness.desktop.share") ||
                  invocation.authority.modelId !== id ||
                  invocation.authority.accountId !== accountKey ||
                  !this.imageAuthorityCurrent(invocation.authority)
                )
                  throw new Error("Image transmission authority expired.");
              },
              accessToken: () => this.accountBoundChatGPTToken(accountKey),
            }),
          );
        this.chatGPTModels.set(id, {
          id,
          displayName: model.displayName,
          provider: "chatgpt-plan",
          model: model.slug,
        });
      }
    } else this.chatGPTModels.clear();
    const active = this.configuredModelIds();
    return [
      ...listModelConfigs(this.database.connection())
        .filter((m) => active.has(m.modelId) && host?.models.has(m.modelId, "1") === true)
        .map((m) => ({ id: m.modelId, displayName: m.title, provider: m.profile, model: m.model })),
      ...this.chatGPTModels.values(),
    ];
  }
  /** Ids of the models a person configured in this harness. */
  private configuredModelIds(): ReadonlySet<string> {
    return new Set([
      ...(this.chatGPTLogin.status().state === "connected" &&
      this.chatGPTCatalogAccountKey === this.currentChatGPTAccountKey()
        ? [...this.chatGPTModels.keys()]
        : []),
      ...listModelConfigs(this.database.connection())
        .filter(
          (model) =>
            model.profile !== "openrouter" &&
            model.credential !== "connection" &&
            !providerAwaitingDecision(model),
        )
        .map((model) => model.modelId),
    ]);
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
    this.pluginMakerGeneration++;
    this.pluginMakerController?.invalidateScope();
    this.pluginMakerState = undefined;
    this.pluginMakerScope = undefined;
    const schedule = this.triggerSchedule.stop();
    this.desktop.close();
    this.images.clear();
    this.imageInvocations.clear();
    for (const controller of this.assistantSignals.values())
      controller.abort(new Error("Assistant runtime stopped."));
    this.assistantSignals.clear();
    this.assistantService = undefined;
    await this.browser.close();
    this.agent.close();
    await this.agent.drainCancellations();
    this.chatGPTLogin.close();
    this.chatGPTModels.clear();
    this.childTools.clear();
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
