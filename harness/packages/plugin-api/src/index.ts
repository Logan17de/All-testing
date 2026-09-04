/**
 * JSON-safe values that may cross the public Harness/plugin boundary.
 *
 * Keep this structural and dependency-free. Runtime validation belongs to the
 * compiler/runtime boundary, not to this package.
 */
export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** A JSON Schema `$ref` URI or fragment. */
export interface SchemaReference {
  readonly $ref: string;
}

/** Public JSON Schema dialect used by every Zet Harness v1 schema surface. */
export const JSON_SCHEMA_DIALECT_URI = "https://json-schema.org/draft/2020-12/schema" as const;

export type JsonSchemaDialectUri = typeof JSON_SCHEMA_DIALECT_URI;

/**
 * Dependency-free public JSON Schema document shape.
 *
 * Every `JsonSchema` exposed by the v1 plugin/graph contracts is interpreted as
 * JSON Schema Draft 2020-12. V1 does not negotiate dialects per node, port, or
 * graph field. Runtime validation remains outside this package so plugins do not
 * depend on a validator implementation.
 *
 * JSON Schema permits an object schema or the boolean schemas `true`/`false`.
 */
export type JsonSchema = JsonObject | boolean;

/** Version identifiers stay strings so plugins are not forced into one scheme. */
export type Version = string;

/** Generic identity for a versioned public contract or extension. */
export interface VersionedId {
  readonly id: string;
  readonly version: Version;
}

/** Stable capability identifier, for example `fs:read` or `network:http`. */
export type CapabilityId = string;

/** A capability requested by a plugin, node, model, or tool contract. */
export interface CapabilityRequirement {
  readonly id: CapabilityId;
  readonly optional?: boolean;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticPathSegment = string | number;

/**
 * Generic diagnostic location. Graph-specific node/edge helpers can be layered
 * on top later without changing the base diagnostic contract.
 */
export interface DiagnosticLocation {
  readonly path?: readonly DiagnosticPathSegment[];
  readonly entityKind?: string;
  readonly entityId?: string;
}

/** Machine-readable diagnostic returned by public validation/compiler APIs. */
export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly location?: DiagnosticLocation;
  readonly details?: JsonObject;
}

/** The public plugin API compatibility level understood by this harness version. */
export const PLUGIN_API_VERSION = 1 as const;

export type PluginApiVersion = typeof PLUGIN_API_VERSION;

/** Cleanup callback owned and invoked by the plugin host. */
export type PluginDisposer = () => void | Promise<void>;

/** Static plugin metadata. The host can inspect this before activation. */
export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: Version;
  readonly apiVersion: PluginApiVersion;
  readonly capabilities?: readonly CapabilityRequirement[];
}

/** Stable globally-namespaced node type, for example `builtin.transform.json`. */
export type NodeType = string;

/** Stable semantic port name used by Graph JSON and node executors. */
export type NodePortName = string;

/**
 * One compiler-readable node input port.
 *
 * `multiple` controls connection/binding cardinality: false/omitted accepts at
 * most one source, while true allows multiple sources. The compiler defines
 * deterministic aggregation rules when multi-source execution lands.
 *
 * `secret` marks a secret-only input. Graph validation must reject literals,
 * public graph inputs, and node data edges for that port; only an opaque secret
 * reference may bind it. Secret material itself never belongs in Graph JSON.
 */
export interface NodeInputPort {
  readonly schema: JsonSchema;
  readonly required?: boolean;
  readonly multiple?: boolean;
  readonly secret?: boolean;
}

/** One compiler-readable node output port. */
export interface NodeOutputPort {
  readonly schema: JsonSchema;
  readonly required?: boolean;
}

/** Small scheduler/compiler-facing primitive families. */
export type NodePrimitiveFamily = "pure" | "effect" | "control" | "interrupt";

/** Whether repeating an execution with the same inputs is expected to match. */
export type NodeDeterminism = "deterministic" | "nondeterministic";

/** Observable side-effect class used for policy, retry, and recovery decisions. */
export type NodeEffectClass = "none" | "external-read" | "external-write";

/**
 * Idempotency promise for repeated execution of one logical operation.
 *
 * `idempotency-key` means the executor/integration can honor a stable key owned
 * by the harness. `unknown` means the harness must not assume a repeat is safe.
 */
export type NodeIdempotency = "not-applicable" | "idempotent" | "idempotency-key" | "unknown";

/** Crash/restart strategy available to the future durable runtime. */
export type NodeRecoveryPolicy = "not-applicable" | "rerun" | "reuse" | "reconcile" | "manual";

/**
 * Where a node implementation is intended to execute.
 *
 * `none` is for compile-time/control structures that have no runtime executor.
 * Process/WASM isolation are contract reservations; supporting them is later work.
 */
export type NodeExecutionMode = "none" | "in-process" | "process" | "wasm";

/** Static retry defaults; compiler/runtime policy may further restrict them. */
export interface NodeRetryDefaults {
  readonly maxAttempts: number;
  readonly backoffMs?: number;
}

/**
 * Explicit router control shape. The compiler interprets `entry` as the single
 * incoming control lane and `branches` as named outgoing activation choices.
 * How a router selects a branch is node/config-specific and lands later.
 */
export interface NodeRouterControlContract {
  readonly kind: "router";
  readonly entry: NodePortName;
  readonly branches: readonly NodePortName[];
}

/**
 * Explicit join control shape. V1 reserves only activation-aware `all-active`;
 * `any`/quorum semantics are intentionally not smuggled into this contract yet.
 */
export interface NodeJoinControlContract {
  readonly kind: "join";
  readonly inputs: readonly NodePortName[];
  readonly output: NodePortName;
  readonly mode: "all-active";
}

/**
 * Explicit loop boundary shape only. This does not make cycles executable.
 * 2.10 still rejects graph SCCs; bounded loop lowering/execution lands later.
 */
export interface NodeLoopControlContract {
  readonly kind: "loop";
  readonly entry: NodePortName;
  readonly continue: NodePortName;
  readonly body: NodePortName;
  readonly exit: NodePortName;
}

/**
 * Explicit durable human-interrupt control shape. `outcomes` are named resume
 * paths such as approved/rejected; persistence and resume behavior land later.
 */
export interface NodeHumanInterruptControlContract {
  readonly kind: "human-interrupt";
  readonly entry: NodePortName;
  readonly outcomes: readonly NodePortName[];
}

/**
 * Explicit subgraph call boundary. Graph identity/bindings are invocation config;
 * this static contract reserves only control entry/exit names for compilation.
 */
export interface NodeSubgraphControlContract {
  readonly kind: "subgraph";
  readonly entry: NodePortName;
  readonly exits: readonly NodePortName[];
}

/**
 * Compiler-readable structured control contract for node types that own control
 * semantics. Ordinary nodes omit this and may still participate in unported
 * ordering-only control edges.
 */
export type NodeStructuredControlContract =
  | NodeRouterControlContract
  | NodeJoinControlContract
  | NodeLoopControlContract
  | NodeHumanInterruptControlContract
  | NodeSubgraphControlContract;

/**
 * Static scheduler/compiler-facing behavior metadata for one node type.
 *
 * Numeric bounds and cross-field consistency are validated later by the graph
 * compiler/runtime. Keeping this structural preserves a dependency-free API.
 */
export interface NodeBehavior {
  readonly primitiveFamily: NodePrimitiveFamily;
  readonly determinism: NodeDeterminism;
  readonly effect: NodeEffectClass;
  readonly idempotency: NodeIdempotency;
  readonly recovery: NodeRecoveryPolicy;
  readonly executionMode: NodeExecutionMode;
  readonly timeoutMs?: number;
  readonly retry?: NodeRetryDefaults;
  readonly requiredCapabilities: readonly CapabilityId[];
}

/**
 * Static metadata for one versioned node type.
 *
 * Input/output ports are first-class so graph validation never has to infer a
 * port model from arbitrary object-shaped JSON Schema. Port schemas, config
 * schema, behavior metadata, and optional structured-control contract are all
 * inspectable without executing node code.
 */
export interface NodeManifest {
  readonly type: NodeType;
  readonly version: Version;
  readonly title: string;
  readonly description?: string;
  readonly inputs: Readonly<Record<NodePortName, NodeInputPort>>;
  readonly outputs: Readonly<Record<NodePortName, NodeOutputPort>>;
  readonly configSchema: JsonSchema;
  readonly behavior: NodeBehavior;
  readonly control?: NodeStructuredControlContract;
}

/** JSON-safe values supplied to one node execution, keyed by input port name. */
export interface NodeExecutionRequest {
  readonly inputs: JsonObject;
  readonly config: JsonObject;
}

/** JSON-safe result produced by one node execution, keyed by output port name. */
export interface NodeExecutionResult {
  readonly outputs: JsonObject;
}

/** Minimal host controls available while one node execution is active. */
export interface NodeExecutionContext {
  readonly signal: AbortSignal;
}

/** Runtime implementation for an executable node definition. */
export type NodeExecutor = (
  request: NodeExecutionRequest,
  context: NodeExecutionContext,
) => NodeExecutionResult | Promise<NodeExecutionResult>;

/**
 * Universal public node definition.
 *
 * `execute` is optional because some node types are compile-time/control
 * structures rather than directly executable operations. Manifest behavior
 * metadata gives the compiler/runtime the static execution intent.
 */
export interface NodeDefinition {
  readonly manifest: NodeManifest;
  readonly execute?: NodeExecutor;
}

/**
 * Host-owned node registration surface exposed during plugin activation.
 *
 * Plugins never receive private registry internals. The host tracks cleanup for
 * every successful registration automatically as part of the activation scope.
 */
export interface PluginNodeRegistry {
  register(definition: NodeDefinition): void;
}

/**
 * Host-owned activation scope for one plugin instance.
 *
 * Registry writes are host-tracked automatically. Any additional resource
 * created during activation must contribute a disposer through `onDispose`.
 * The host unwinds cleanup in reverse registration order, including partial
 * activation failures.
 */
export interface PluginContext {
  readonly config?: JsonValue;
  readonly nodes: PluginNodeRegistry;
  onDispose(disposer: PluginDisposer): void;
}

/**
 * Public plugin lifecycle contract.
 *
 * Loading/importing a module is the host's responsibility. Once loaded, the
 * host validates the manifest, calls `activate`, tracks all registrations and
 * disposers through the context, and later disposes the activation scope.
 */
export interface HarnessPlugin {
  readonly manifest: PluginManifest;
  activate(context: PluginContext): void | Promise<void>;
}
