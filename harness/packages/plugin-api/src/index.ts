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

/**
 * Static identity/display metadata for one versioned node type.
 *
 * Schemas, behavior metadata, effects, recovery policy, execution mode, and
 * capabilities are layered onto this manifest by the next contract steps.
 */
export interface NodeManifest {
  readonly type: NodeType;
  readonly version: Version;
  readonly title: string;
  readonly description?: string;
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
 * structures rather than directly executable operations. Later manifest
 * behavior metadata tells the compiler/runtime which shapes are valid.
 */
export interface NodeDefinition {
  readonly manifest: NodeManifest;
  readonly execute?: NodeExecutor;
}
