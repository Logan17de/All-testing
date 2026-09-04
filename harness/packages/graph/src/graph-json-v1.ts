import type {
  CapabilityId,
  JsonObject,
  JsonSchema,
  JsonValue,
  NodeType,
  Version,
} from "@zet-harness/plugin-api";

/** Public source-format version for the first Zet Harness graph language. */
export const GRAPH_JSON_VERSION = 1 as const;

export type GraphJsonVersion = typeof GRAPH_JSON_VERSION;

export type GraphId = string;
export type GraphRevisionId = string;
export type GraphNodeId = string;
export type GraphPortId = string;
export type GraphEdgeId = string;
export type GraphEntrypointId = string;

/** Human-facing metadata. It does not define scheduler control flow. */
export interface GraphMetadataV1 {
  readonly title?: string;
  readonly description?: string;
  readonly labels?: readonly string[];
}

/** Public input exposed by the graph as a callable workflow boundary. */
export interface GraphInputPortV1 {
  readonly id: GraphPortId;
  readonly schema: JsonSchema;
  readonly required?: boolean;
  readonly default?: JsonValue;
}

/** Reference to one output port on a graph node. */
export interface GraphNodeOutputRefV1 {
  readonly nodeId: GraphNodeId;
  readonly port: GraphPortId;
}

/** Public output exposed by the graph. */
export interface GraphOutputPortV1 {
  readonly id: GraphPortId;
  readonly schema: JsonSchema;
  readonly source: GraphNodeOutputRefV1;
}

/** Literal JSON supplied directly to one node input port. */
export interface GraphLiteralBindingV1 {
  readonly kind: "literal";
  readonly port: GraphPortId;
  readonly value: JsonValue;
}

/** Value forwarded from one public graph input into one node input port. */
export interface GraphInputPortBindingV1 {
  readonly kind: "graph-input";
  readonly port: GraphPortId;
  readonly input: GraphPortId;
}

/**
 * Opaque secret reference supplied to one node input port.
 *
 * The graph stores only the reference. Secret providers/resolution are defined
 * later by the runtime security layer; secret material must not live here.
 */
export interface GraphSecretBindingV1 {
  readonly kind: "secret";
  readonly port: GraphPortId;
  readonly secretRef: string;
}

/**
 * Non-edge bindings for node inputs.
 *
 * Node-to-node values are represented only by `GraphDataEdgeV1` so one source
 * document never has two competing ways to express the same dependency.
 */
export type GraphInputBindingV1 =
  GraphLiteralBindingV1 | GraphInputPortBindingV1 | GraphSecretBindingV1;

/** One pinned node invocation in the source graph. */
export interface GraphNodeV1 {
  readonly id: GraphNodeId;
  readonly type: NodeType;
  readonly version: Version;
  readonly config: JsonObject;
  readonly bindings?: readonly GraphInputBindingV1[];
}

/** Data endpoint. Ports refer to semantic node input/output ports, never UI handles. */
export interface GraphDataEndpointV1 {
  readonly nodeId: GraphNodeId;
  readonly port: GraphPortId;
}

/** Moves a value from one node output port to one node input port. */
export interface GraphDataEdgeV1 {
  readonly id: GraphEdgeId;
  readonly kind: "data";
  readonly from: GraphDataEndpointV1;
  readonly to: GraphDataEndpointV1;
}

/**
 * Control endpoint used only for scheduling dependencies/routes.
 *
 * `port` is an optional named control exit/entry such as a future router branch
 * or join lane. Structured control-node semantics are frozen in later items.
 */
export interface GraphControlEndpointV1 {
  readonly nodeId: GraphNodeId;
  readonly port?: string;
}

/** Determines scheduling/control flow and carries no data value. */
export interface GraphControlEdgeV1 {
  readonly id: GraphEdgeId;
  readonly kind: "control";
  readonly from: GraphControlEndpointV1;
  readonly to: GraphControlEndpointV1;
}

export type GraphEdgeV1 = GraphDataEdgeV1 | GraphControlEdgeV1;

/** Named starting point into the graph. */
export interface GraphEntrypointV1 {
  readonly id: GraphEntrypointId;
  readonly nodeId: GraphNodeId;
  readonly port?: string;
}

/** Graph-local capability policy. The host/runtime may always impose stricter policy. */
export interface GraphCapabilityPolicyV1 {
  readonly allow?: readonly CapabilityId[];
  readonly deny?: readonly CapabilityId[];
}

/** Hard execution limits carried with the source graph. */
export interface GraphPoliciesV1 {
  readonly maxNodeExecutions?: number;
  readonly maxParallelism?: number;
  readonly maxWallTimeMs?: number;
  readonly capabilities?: GraphCapabilityPolicyV1;
}

/** Small execution-source options that are not hard safety limits. */
export interface GraphOptionsV1 {
  readonly defaultEntrypoint?: GraphEntrypointId;
}

export interface GraphEditorPointV1 {
  readonly x: number;
  readonly y: number;
}

export interface GraphEditorViewportV1 extends GraphEditorPointV1 {
  readonly zoom: number;
}

export interface GraphEditorNodeStateV1 {
  readonly position: GraphEditorPointV1;
  readonly collapsed?: boolean;
}

export interface GraphEditorAnnotationV1 {
  readonly id: string;
  readonly text: string;
  readonly position: GraphEditorPointV1;
}

/**
 * Semantically inert authoring metadata.
 *
 * Compiler normalization must discard this entire bucket before producing the
 * immutable execution representation. React Flow objects must never be stored
 * directly in this public contract.
 */
export interface GraphEditorMetadataV1 {
  readonly viewport?: GraphEditorViewportV1;
  readonly nodes?: Readonly<Record<GraphNodeId, GraphEditorNodeStateV1>>;
  readonly annotations?: readonly GraphEditorAnnotationV1[];
  readonly data?: JsonObject;
}

/**
 * Canonical portable source document for Zet Harness Graph JSON v1.
 *
 * This is source code, not runtime state. Validation, normalization, hashing,
 * compilation, and execution semantics are implemented by later Phase 2 items.
 */
export interface GraphJsonV1 {
  readonly schemaVersion: GraphJsonVersion;
  readonly graphId: GraphId;
  readonly revisionId: GraphRevisionId;
  readonly metadata?: GraphMetadataV1;
  readonly inputs: readonly GraphInputPortV1[];
  readonly outputs: readonly GraphOutputPortV1[];
  readonly nodes: readonly GraphNodeV1[];
  readonly edges: readonly GraphEdgeV1[];
  readonly entrypoints: readonly GraphEntrypointV1[];
  readonly policies?: GraphPoliciesV1;
  readonly options?: GraphOptionsV1;
  readonly editor?: GraphEditorMetadataV1;
}
