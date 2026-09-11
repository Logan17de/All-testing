import {
  PLUGIN_API_VERSION,
  type CapabilityId,
  type HarnessPlugin,
  type JsonObject,
  type NodeDefinition,
  type NodeEffectClass,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeExecutor,
  type NodeIdempotency,
  type NodeInputPort,
  type NodeManifest,
  type NodeOutputPort,
  type NodePortName,
  type NodeRecoveryPolicy,
  type NodeRetryDefaults,
  type PluginContext,
  type Version,
} from "@zet-harness/plugin-api";

/**
 * Authoring helpers for third-party plugins.
 *
 * Everything here is built on the frozen public contracts in
 * `@zet-harness/plugin-api` and nothing else. A plugin written against this SDK
 * depends on the same surface an external author has, so the SDK cannot drift
 * into privileges a hand-written plugin could not obtain.
 *
 * The helpers validate at definition time, which is when a plugin author can
 * still fix the mistake, rather than leaving it for the host to reject at
 * activation on someone else's machine.
 */

const NODE_TYPE_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/u;

export interface NodeExecuteArguments {
  readonly inputs: JsonObject;
  readonly config: JsonObject;
  readonly signal: AbortSignal;
}

export type NodeExecuteFunction = (
  args: NodeExecuteArguments,
) => NodeExecutionResult | Promise<NodeExecutionResult>;

interface BaseNodeOptions {
  /** Namespaced type, for example `vendor.thing`. */
  readonly type: string;
  readonly version?: Version;
  readonly title: string;
  readonly description?: string;
  readonly inputs?: Readonly<Record<NodePortName, NodeInputPort>>;
  readonly outputs?: Readonly<Record<NodePortName, NodeOutputPort>>;
  readonly configSchema?: JsonObject;
  readonly timeoutMs?: number;
  readonly retry?: NodeRetryDefaults;
  readonly execute: NodeExecuteFunction;
}

function assertType(type: string): void {
  if (!NODE_TYPE_PATTERN.test(type)) {
    throw new TypeError(
      `Node type '${type}' must be namespaced lowercase segments, such as 'vendor.thing'. ` +
        "A global name would collide with other authors' nodes.",
    );
  }
}

function assertTitle(title: string): void {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new TypeError("Node title must be a non-empty string.");
  }
}

function assertPorts(ports: Readonly<Record<string, unknown>> | undefined, label: string): void {
  if (ports === undefined) return;
  for (const [name, port] of Object.entries(ports)) {
    if (name.length === 0) throw new TypeError(`${label} port names must be non-empty.`);
    if (typeof port !== "object" || port === null) {
      throw new TypeError(`${label} port '${name}' must be an object with a schema.`);
    }
    if (!("schema" in port)) {
      throw new TypeError(`${label} port '${name}' must declare a schema.`);
    }
  }
}

function wrapExecute(execute: NodeExecuteFunction): NodeExecutor {
  if (typeof execute !== "function") {
    throw new TypeError("Node execute must be a function.");
  }
  return (request, context: NodeExecutionContext) =>
    execute({ inputs: request.inputs, config: request.config, signal: context.signal });
}

function buildDefinition(
  options: BaseNodeOptions,
  behavior: NodeManifest["behavior"],
): NodeDefinition {
  assertType(options.type);
  assertTitle(options.title);
  assertPorts(options.inputs, "Input");
  assertPorts(options.outputs, "Output");

  return Object.freeze({
    manifest: Object.freeze({
      type: options.type,
      version: options.version ?? "1",
      title: options.title,
      ...(options.description === undefined ? {} : { description: options.description }),
      inputs: Object.freeze({ ...(options.inputs ?? {}) }),
      outputs: Object.freeze({ ...(options.outputs ?? {}) }),
      configSchema:
        options.configSchema ??
        Object.freeze({ type: "object", additionalProperties: false, properties: {} }),
      behavior,
    }),
    execute: wrapExecute(options.execute),
  });
}

export type PureNodeOptions = BaseNodeOptions;

/**
 * Define a node with no side effects.
 *
 * A pure node is safe to rerun, so the behavior metadata is filled in rather
 * than asked for. This is the only category where defaults are safe.
 */
export function definePureNode(options: PureNodeOptions): NodeDefinition {
  return buildDefinition(
    options,
    Object.freeze({
      primitiveFamily: "pure" as const,
      determinism: "deterministic" as const,
      effect: "none" as const,
      idempotency: "not-applicable" as const,
      recovery: "rerun" as const,
      executionMode: "in-process" as const,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
      requiredCapabilities: Object.freeze([]),
    }),
  );
}

export interface EffectNodeOptions extends BaseNodeOptions {
  /**
   * What the node does to state outside the harness.
   *
   * Required, with no default. Guessing an effect class would let a node that
   * writes be scheduled as if it only read, which is the one mistake the
   * recovery machinery cannot compensate for later.
   */
  readonly effect: Exclude<NodeEffectClass, "none">;
  readonly idempotency: NodeIdempotency;
  readonly recovery: NodeRecoveryPolicy;
  /** Capabilities this node needs. A declaration is a request, never a grant. */
  readonly requiredCapabilities?: readonly CapabilityId[];
  readonly determinism?: "deterministic" | "nondeterministic";
}

/**
 * Define a node that touches the outside world.
 *
 * Effect, idempotency and recovery must all be stated explicitly. The host uses
 * them to decide whether an interrupted attempt may be repeated, so a wrong or
 * assumed value here is how duplicate side effects happen.
 */
export function defineEffectNode(options: EffectNodeOptions): NodeDefinition {
  if (options.effect !== "external-read" && options.effect !== "external-write") {
    throw new TypeError("Effect nodes must declare 'external-read' or 'external-write'.");
  }
  if (options.effect === "external-write" && options.recovery === "reuse") {
    throw new TypeError(
      "An external write cannot declare 'reuse' recovery: there is no stored output to reuse.",
    );
  }

  return buildDefinition(
    options,
    Object.freeze({
      primitiveFamily: "effect" as const,
      determinism: options.determinism ?? ("nondeterministic" as const),
      effect: options.effect,
      idempotency: options.idempotency,
      recovery: options.recovery,
      executionMode: "in-process" as const,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
      requiredCapabilities: Object.freeze([...(options.requiredCapabilities ?? [])]),
    }),
  );
}

export interface DefinePluginOptions {
  readonly id: string;
  readonly name: string;
  readonly version: Version;
  readonly nodes?: readonly NodeDefinition[];
  /**
   * Capabilities the plugin requests.
   *
   * The host decides what to grant. Listing a capability here does not obtain
   * it, and every node's own requirements must appear in this list.
   */
  readonly capabilities?: readonly CapabilityId[];
  /** Extra activation work, for registering models or tools. */
  readonly activate?: (context: PluginContext) => void | Promise<void>;
}

/**
 * Build a plugin from node definitions.
 *
 * The plugin's declared capability list is checked against what its nodes
 * require, so a mismatch is caught while the author can still fix it instead of
 * failing at activation on a user's machine.
 */
export function definePlugin(options: DefinePluginOptions): HarnessPlugin {
  if (typeof options.id !== "string" || options.id.trim().length === 0) {
    throw new TypeError("Plugin id must be a non-empty string.");
  }
  if (typeof options.version !== "string" || options.version.trim().length === 0) {
    throw new TypeError("Plugin version must be a non-empty string.");
  }

  const nodes = Object.freeze([...(options.nodes ?? [])]);
  const declared = new Set(options.capabilities ?? []);

  for (const node of nodes) {
    for (const required of node.manifest.behavior.requiredCapabilities) {
      if (!declared.has(required)) {
        throw new TypeError(
          `Node '${node.manifest.type}' requires capability '${required}', ` +
            `which plugin '${options.id}' does not declare.`,
        );
      }
    }
  }

  const seen = new Set<string>();
  for (const node of nodes) {
    const key = `${node.manifest.type}\0${node.manifest.version}`;
    if (seen.has(key)) {
      throw new TypeError(`Plugin '${options.id}' defines '${node.manifest.type}' twice.`);
    }
    seen.add(key);
  }

  return Object.freeze({
    manifest: Object.freeze({
      id: options.id,
      name: options.name,
      version: options.version,
      apiVersion: PLUGIN_API_VERSION,
      capabilities: Object.freeze([...declared].map((id) => Object.freeze({ id }))),
    }),
    async activate(context: PluginContext): Promise<void> {
      for (const node of nodes) {
        context.nodes.register(node);
      }
      if (options.activate !== undefined) {
        await options.activate(context);
      }
    },
  });
}

/**
 * Produce the `nodes` array for a package manifest from node definitions.
 *
 * The loader refuses a plugin that registers a node its package manifest does
 * not declare. Generating the declaration from the same definitions keeps the
 * two in step instead of relying on an author to update both by hand.
 */
export function describeNodesForManifest(
  nodes: readonly NodeDefinition[],
): readonly { readonly type: string; readonly version: Version; readonly title: string }[] {
  return Object.freeze(
    nodes.map((node) =>
      Object.freeze({
        type: node.manifest.type,
        version: node.manifest.version,
        title: node.manifest.title,
      }),
    ),
  );
}
