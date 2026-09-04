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

/**
 * Dependency-free public JSON Schema document shape.
 *
 * JSON Schema permits an object schema or the boolean schemas `true`/`false`.
 * The exact dialect/version is frozen with Graph JSON in Phase 2; this type is
 * intentionally structural so plugins do not depend on a validator package.
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

/**
 * Host-owned activation scope for one plugin instance.
 *
 * Every registration/resource created during activation must contribute a
 * disposer through `onDispose`. The host later unwinds those callbacks in
 * reverse registration order, including partial activation failures.
 */
export interface PluginContext {
  readonly config?: JsonValue;
  onDispose(disposer: PluginDisposer): void;
}

/**
 * Public plugin lifecycle contract.
 *
 * Loading/importing a module is the host's responsibility. Once loaded, the
 * host validates the manifest, calls `activate`, tracks all disposers registered
 * through the context, and later disposes the activation scope.
 */
export interface HarnessPlugin {
  readonly manifest: PluginManifest;
  activate(context: PluginContext): void | Promise<void>;
}

/** Stable globally-namespaced node type, for example `builtin.transform.json`. */
export type NodeType = string;

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
export type NodeIdempotency =
  | "not-applicable"
  | "idempotent"
  | "idempotency-key"
  | "unknown";

/** Crash/restart strategy available to the future durable runtime. */
export type NodeRecoveryPolicy =
  | "not-applicable"
  | "rerun"
  | "reuse"
  | "reconcile"
  | "manual";

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
 * Schemas and behavior metadata are always present so the compiler/editor can
 * inspect the node contract without executing its implementation.
 */
export interface NodeManifest {
  readonly type: NodeType;
  readonly version: Version;
  readonly title: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly configSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly behavior: NodeBehavior;
}

/** JSON-safe values supplied to one node execution. */
export interface NodeExecutionRequest {
  readonly inputs: JsonObject;
  readonly config: JsonObject;
}

/** JSON-safe result produced by one node execution. */
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
