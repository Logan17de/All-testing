import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  AdapterInvocationContext,
  JsonObject,
  NodeDefinition,
  NodeManifest,
  ToolAdapter,
  ToolManifest,
} from "@zet-harness/plugin-api";

import type { LoadedPluginPackage } from "./plugin-loader.js";

/**
 * Process-isolated plugin execution.
 *
 * An in-process plugin runs with the harness's own privileges, so withholding
 * `fs:write` does not stop a plugin that simply imports `node:fs`. Isolation
 * closes that gap by running the plugin in a child process started under Node's
 * permission model, where the operating-system-level surfaces a plugin was not
 * granted are actually unavailable to it.
 *
 * This is a real boundary, not a wrapper: a denied write fails with
 * `ERR_ACCESS_DENIED` inside the child regardless of what the plugin code does.
 */

export type IsolationFailureCode =
  | "spawn-failed"
  | "activation-failed"
  | "child-exited"
  | "timeout"
  | "invocation-failed"
  | "message-too-large";

const ISOLATION_MARKER: unique symbol = Symbol("zet-harness.isolation-error");

export class PluginIsolationError extends Error {
  readonly code: IsolationFailureCode;

  constructor(code: IsolationFailureCode, message: string) {
    super(message);
    this.name = "PluginIsolationError";
    this.code = code;
    Object.defineProperty(this, ISOLATION_MARKER, { value: true, enumerable: false });
  }
}

export function isPluginIsolationError(value: unknown): value is PluginIsolationError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[ISOLATION_MARKER] === true
  );
}

/** Node's permission model matches directory subtrees with a trailing glob. */
const PATH_GLOB = "/*";

export interface SandboxGrantInput {
  /** The plugin's own package directory; always readable so it can import itself. */
  readonly packageDirectory: string;
  /** Project root a plugin granted filesystem capabilities may reach. */
  readonly workspaceRoot?: string;
  readonly grantedCapabilities: readonly string[];
}

/**
 * Translate capability grants into Node permission-model flags.
 *
 * Pure and separately testable, because this mapping is the whole security
 * boundary: a mistake here silently widens what a plugin can reach.
 *
 * **Node's permission model does not cover network access.** A plugin can still
 * open sockets, so network capabilities remain enforced only at the harness's
 * brokered surfaces. That limit is the model's, not a choice made here.
 */
export function deriveSandboxFlags(input: SandboxGrantInput): readonly string[] {
  const granted = new Set(input.grantedCapabilities);
  const flags = ["--permission"];

  // Without this the plugin cannot import its own entry module.
  flags.push(`--allow-fs-read=${resolve(input.packageDirectory)}${PATH_GLOB}`);

  if (input.workspaceRoot !== undefined) {
    const root = resolve(input.workspaceRoot);
    if (granted.has("fs:read") || granted.has("fs:write")) {
      flags.push(`--allow-fs-read=${root}${PATH_GLOB}`);
    }
    if (granted.has("fs:write")) {
      flags.push(`--allow-fs-write=${root}${PATH_GLOB}`);
    }
  }

  if (granted.has("process:exec")) flags.push("--allow-child-process");
  if (granted.has("worker")) flags.push("--allow-worker");

  return Object.freeze(flags);
}

const DEFAULT_ACTIVATION_TIMEOUT_MS = 15_000;
const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_CHARACTERS = 4_194_304;

/**
 * Bootstrap executed inside the isolated child.
 *
 * Delivered through `--input-type=module -e` rather than a file on disk, so the
 * sandbox needs no read grant beyond the plugin's own package and there is no
 * bootstrap file a plugin could tamper with.
 */
const CHILD_BOOTSTRAP = `
const entryUrl = process.env.ZET_PLUGIN_ENTRY;
const nodes = new Map();
const tools = new Map();
const disposers = [];

const reply = (message) => { try { process.send(message); } catch { /* parent gone */ } };

const context = Object.freeze({
  config: process.env.ZET_PLUGIN_CONFIG ? JSON.parse(process.env.ZET_PLUGIN_CONFIG) : undefined,
  nodes: Object.freeze({
    register(definition) {
      nodes.set(JSON.stringify([definition.manifest.type, definition.manifest.version]), definition);
    },
  }),
  models: Object.freeze({
    register() {
      throw new Error("Model adapters are not supported in an isolated plugin yet.");
    },
  }),
  tools: Object.freeze({
    register(adapter) { tools.set(adapter.manifest.id, adapter); },
  }),
  onDispose(disposer) { disposers.push(disposer); },
});

try {
  const module = await import(entryUrl);
  const plugin = module.default ?? module.plugin;
  await plugin.activate(context);
  reply({
    type: "ready",
    nodes: [...nodes.values()].map((definition) => definition.manifest),
    tools: [...tools.values()].map((adapter) => adapter.manifest),
  });
} catch (error) {
  reply({ type: "activation-failed", message: String(error && error.message ? error.message : error) });
  process.exit(1);
}

process.on("message", (message) => {
  void (async () => {
    if (message.type === "shutdown") {
      for (const dispose of disposers.reverse()) { try { await dispose(); } catch { /* ignore */ } }
      process.exit(0);
    }
    try {
      if (message.type === "invoke-node") {
        const definition = nodes.get(message.key);
        if (!definition || typeof definition.execute !== "function") {
          throw new Error("Unknown node " + message.key);
        }
        const result = await definition.execute(
          { inputs: message.inputs, config: message.config },
          { signal: new AbortController().signal },
        );
        reply({ type: "result", id: message.id, value: { outputs: result.outputs } });
        return;
      }
      if (message.type === "invoke-tool") {
        const adapter = tools.get(message.toolId);
        if (!adapter) throw new Error("Unknown tool " + message.toolId);
        const result = await adapter.invoke(message.input, {
          runId: message.runId,
          opIndex: message.opIndex,
          iteration: message.iteration,
          attempt: message.attempt,
          logicalEffectId: message.logicalEffectId,
          signal: new AbortController().signal,
          retryBudget: {
            maxAttempts: 1,
            repeatAuthorized: false,
            usedAttempts: 1,
            remainingAttempts: 0,
            reportInternalRetries: () => 0,
          },
        });
        reply({ type: "result", id: message.id, value: { value: result.value } });
        return;
      }
      throw new Error("Unknown message type");
    } catch (error) {
      reply({
        type: "error",
        id: message.id,
        message: String(error && error.message ? error.message : error),
      });
    }
  })();
});
`;

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

export interface IsolatedPluginOptions {
  readonly workspaceRoot?: string;
  readonly grantedCapabilities?: readonly string[];
  readonly config?: JsonObject;
  readonly activationTimeoutMs?: number;
  readonly invokeTimeoutMs?: number;
  /** Node executable to run the sandbox with. Defaults to the current one. */
  readonly nodeExecutable?: string;
}

export interface IsolatedPlugin {
  readonly pluginId: string;
  /** Pinned into compiled plans alongside the id, as for in-process plugins. */
  readonly pluginVersion: string;
  readonly nodes: readonly NodeDefinition[];
  readonly tools: readonly ToolAdapter[];
  /** Flags the sandbox was started with, for auditing and tests. */
  readonly sandboxFlags: readonly string[];
  readonly close: () => Promise<void>;
}

/**
 * Start a plugin in an isolated child process.
 *
 * Registrations come back as manifests and are re-published locally as proxy
 * definitions that forward each invocation into the child. The plugin's code
 * never runs in the harness process.
 */
export async function startIsolatedPlugin(
  loaded: LoadedPluginPackage,
  packageDirectory: string,
  options: IsolatedPluginOptions = {},
): Promise<IsolatedPlugin> {
  const sandboxFlags = deriveSandboxFlags({
    packageDirectory,
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    grantedCapabilities: options.grantedCapabilities ?? [],
  });

  const entryUrl = pathToFileURL(resolve(packageDirectory, loaded.manifest.entry)).href;

  let child: ChildProcess;
  try {
    child = spawn(
      options.nodeExecutable ?? process.execPath,
      [...sandboxFlags, "--input-type=module", "-e", CHILD_BOOTSTRAP],
      {
        // A minimal environment: the harness environment can hold credentials
        // and an isolated plugin has no reason to see any of it.
        env: {
          ZET_PLUGIN_ENTRY: entryUrl,
          ...(options.config === undefined
            ? {}
            : { ZET_PLUGIN_CONFIG: JSON.stringify(options.config) }),
        },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
  } catch (error: unknown) {
    throw new PluginIsolationError(
      "spawn-failed",
      error instanceof Error ? error.message : "Isolated plugin could not be started.",
    );
  }

  const pending = new Map<number, PendingCall>();
  let nextId = 1;
  let stderrTail = "";
  let closed = false;

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4096);
  });

  const failAll = (error: PluginIsolationError): void => {
    for (const [, call] of pending) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
  };

  const ready = new Promise<{
    readonly nodes: readonly NodeManifest[];
    readonly tools: readonly ToolManifest[];
  }>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(
        new PluginIsolationError("timeout", "Isolated plugin did not finish activating in time."),
      );
    }, options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS);
    timer.unref?.();

    child.on("message", (raw: unknown) => {
      const message = raw as Record<string, unknown>;
      if (message["type"] === "ready") {
        clearTimeout(timer);
        resolveReady({
          nodes: (message["nodes"] ?? []) as readonly NodeManifest[],
          tools: (message["tools"] ?? []) as readonly ToolManifest[],
        });
        return;
      }
      if (message["type"] === "activation-failed") {
        clearTimeout(timer);
        rejectReady(
          new PluginIsolationError(
            "activation-failed",
            typeof message["message"] === "string" ? message["message"] : "unknown",
          ),
        );
        return;
      }

      const id = message["id"];
      if (typeof id !== "number") return;
      const call = pending.get(id);
      if (call === undefined) return;
      pending.delete(id);
      clearTimeout(call.timer);

      if (message["type"] === "error") {
        call.reject(
          new PluginIsolationError(
            "invocation-failed",
            typeof message["message"] === "string" ? message["message"] : "unknown",
          ),
        );
        return;
      }
      call.resolve(message["value"]);
    });

    child.on("error", () => {
      clearTimeout(timer);
      rejectReady(new PluginIsolationError("spawn-failed", "Isolated plugin transport failed."));
    });

    child.on("exit", () => {
      clearTimeout(timer);
      closed = true;
      const error = new PluginIsolationError(
        "child-exited",
        stderrTail.length > 0 ? `Isolated plugin exited: ${stderrTail}` : "Isolated plugin exited.",
      );
      rejectReady(error);
      failAll(error);
    });
  });

  const call = (payload: Record<string, unknown>): Promise<unknown> => {
    if (closed) {
      return Promise.reject(
        new PluginIsolationError("child-exited", "Isolated plugin is no longer running."),
      );
    }
    const id = nextId;
    nextId += 1;

    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_MESSAGE_CHARACTERS) {
      return Promise.reject(
        new PluginIsolationError("message-too-large", "Isolated plugin payload is too large."),
      );
    }

    return new Promise<unknown>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectCall(new PluginIsolationError("timeout", "Isolated plugin call timed out."));
      }, options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      child.send({ ...payload, id });
    });
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    failAll(new PluginIsolationError("child-exited", "Isolated plugin closed."));
    try {
      child.send({ type: "shutdown" });
    } catch {
      // Already gone.
    }
    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        resolveClose();
      }, 2_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
  };

  let manifests;
  try {
    manifests = await ready;
  } catch (error: unknown) {
    await close();
    throw error;
  }

  const nodes: NodeDefinition[] = manifests.nodes.map((manifest) =>
    Object.freeze({
      manifest,
      execute: async (request: { inputs: JsonObject; config: JsonObject }) => {
        const value = (await call({
          type: "invoke-node",
          key: JSON.stringify([manifest.type, manifest.version]),
          inputs: request.inputs,
          config: request.config,
        })) as { outputs: JsonObject };
        return { outputs: value.outputs };
      },
    }),
  );

  const tools: ToolAdapter[] = manifests.tools.map((manifest) =>
    Object.freeze({
      manifest,
      invoke: async (input: JsonObject, context: AdapterInvocationContext) => {
        context.signal.throwIfAborted();
        const value = (await call({
          type: "invoke-tool",
          toolId: manifest.id,
          input,
          runId: context.runId,
          opIndex: context.opIndex,
          iteration: context.iteration,
          attempt: context.attempt,
          logicalEffectId: context.logicalEffectId,
        })) as { value: unknown };
        return { value: value.value as never };
      },
    }),
  );

  return Object.freeze({
    pluginId: loaded.manifest.id,
    pluginVersion: loaded.manifest.version,
    nodes: Object.freeze(nodes),
    tools: Object.freeze(tools),
    sandboxFlags,
    close,
  });
}
