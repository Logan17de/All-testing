/**
 * Graph JSON v1 as the editor authors it.
 *
 * These types mirror the part of Graph JSON v1 the editor reads and writes,
 * instead of pulling the compiler package into the browser bundle. The runtime
 * compiler stays the authority: every document is shape-checked there before it
 * is stored, so drift here surfaces as a diagnostic rather than an accepted graph.
 */

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface JsonSchemaObject {
  readonly type?: string | readonly string[];
  readonly enum?: readonly JsonValue[];
  readonly properties?: { readonly [key: string]: JsonSchema };
  readonly required?: readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

export type JsonSchema = JsonSchemaObject | boolean;

export interface PortManifest {
  readonly schema: JsonSchema;
  readonly required?: boolean;
  readonly multiple?: boolean;
  readonly secret?: boolean;
}

export interface NodeManifestView {
  readonly type: string;
  readonly version: string;
  readonly title: string;
  readonly description?: string;
  readonly inputs: { readonly [port: string]: PortManifest };
  readonly outputs: { readonly [port: string]: PortManifest };
  readonly configSchema: JsonSchema;
  readonly behavior: {
    readonly primitiveFamily: string;
    readonly effect: string;
    readonly idempotency: string;
    readonly recovery: string;
    readonly requiredCapabilities: readonly string[];
  };
}

export interface PaletteEntry {
  readonly manifest: NodeManifestView;
  readonly pluginId: string;
  readonly isolated: boolean;
}

export type GraphBinding =
  | { readonly kind: "literal"; readonly port: string; readonly value: JsonValue }
  | { readonly kind: "graph-input"; readonly port: string; readonly input: string }
  | { readonly kind: "secret"; readonly port: string; readonly secretRef: string };

export interface GraphNode {
  readonly id: string;
  readonly type: string;
  readonly version: string;
  readonly config: { readonly [key: string]: JsonValue };
  readonly bindings?: readonly GraphBinding[];
}

export interface GraphEndpoint {
  readonly nodeId: string;
  readonly port: string;
}

export interface GraphDataEdge {
  readonly id: string;
  readonly kind: "data";
  readonly from: GraphEndpoint;
  readonly to: GraphEndpoint;
}

export interface GraphControlEdge {
  readonly id: string;
  readonly kind: "control";
  readonly from: { readonly nodeId: string; readonly port?: string };
  readonly to: { readonly nodeId: string; readonly port?: string };
}

export type GraphEdge = GraphDataEdge | GraphControlEdge;

export interface EditorPoint {
  readonly x: number;
  readonly y: number;
}

export interface GraphPolicies {
  readonly maxNodeExecutions?: number;
  readonly maxParallelism?: number;
  readonly maxWallTimeMs?: number;
  readonly capabilities?: {
    readonly required?: readonly string[];
    readonly optional?: readonly string[];
    readonly deny?: readonly string[];
  };
}

export interface GraphInput {
  readonly id: string;
  readonly schema: JsonSchema;
  readonly required?: boolean;
  readonly default?: JsonValue;
}

export interface GraphOutput {
  readonly id: string;
  readonly schema: JsonSchema;
  readonly source: GraphEndpoint;
}

export interface GraphEntrypoint {
  readonly id: string;
  readonly nodeId: string;
  readonly port?: string;
}

export interface GraphDocument {
  readonly schemaVersion: 1;
  readonly graphId: string;
  readonly revisionId: string;
  readonly metadata?: { readonly title?: string; readonly description?: string };
  readonly inputs: readonly GraphInput[];
  readonly outputs: readonly GraphOutput[];
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly entrypoints: readonly GraphEntrypoint[];
  readonly policies?: GraphPolicies;
  readonly options?: { readonly defaultEntrypoint?: string };
  readonly editor?: {
    readonly nodes?: { readonly [nodeId: string]: { readonly position?: EditorPoint } };
  };
}

export interface EditorDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly stage: string;
  readonly path?: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly port?: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Identifier-safe fragment for derived entrypoint and output ids. */
function identifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}

export function emptyGraph(graphId: string): GraphDocument {
  return {
    schemaVersion: 1,
    graphId,
    revisionId: "draft",
    inputs: [],
    outputs: [],
    nodes: [],
    edges: [],
    entrypoints: [],
  };
}

export function findManifest(
  palette: readonly PaletteEntry[] | null,
  type: string,
  version: string,
): PaletteEntry | undefined {
  return palette?.find(
    (entry) => entry.manifest.type === type && entry.manifest.version === version,
  );
}

/** The first non-null JSON Schema type, or undefined for an open schema. */
export function schemaTypeOf(schema: JsonSchema | undefined): string | undefined {
  if (schema === undefined || typeof schema === "boolean") return undefined;
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return (type as readonly string[]).find((entry) => entry !== "null");
  return undefined;
}

export function nextNodeId(document: GraphDocument, type: string): string {
  const base = identifier(type.split(".").pop() ?? "node");
  const taken = new Set(document.nodes.map((node) => node.id));
  for (let index = 1; ; index += 1) {
    const candidate = `${base}-${String(index)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function newEdgeId(): string {
  return `edge-${crypto.randomUUID().slice(0, 8)}`;
}

/** Input ports of one node that an edge already feeds. */
export function fedPorts(document: GraphDocument, nodeId: string): ReadonlySet<string> {
  return new Set(
    document.edges
      .filter((edge): edge is GraphDataEdge => edge.kind === "data" && edge.to.nodeId === nodeId)
      .map((edge) => edge.to.port),
  );
}

export function literalFor(node: GraphNode, port: string): JsonValue | undefined {
  const binding = node.bindings?.find((entry) => entry.port === port);
  return binding?.kind === "literal" ? binding.value : undefined;
}

function withBindings(node: GraphNode, bindings: readonly GraphBinding[]): GraphNode {
  const base = { id: node.id, type: node.type, version: node.version, config: node.config };
  return bindings.length === 0 ? base : { ...base, bindings };
}

export function setPosition(
  document: GraphDocument,
  nodeId: string,
  point: EditorPoint,
): GraphDocument {
  const nodes = { ...(document.editor?.nodes ?? {}) };
  nodes[nodeId] = {
    ...(nodes[nodeId] ?? {}),
    position: { x: Math.round(point.x), y: Math.round(point.y) },
  };
  return { ...document, editor: { ...(document.editor ?? {}), nodes } };
}

/** Rough footprint of a node on the canvas, used only to keep new nodes from stacking. */
export const NODE_FOOTPRINT = { width: 220, height: 96 } as const;

/**
 * The nearest spot at or below `point` that no existing node covers.
 *
 * Clicking palette items drops each node at the same point, so without this a
 * second node lands exactly on top of the first and hides it.
 */
export function freePosition(document: GraphDocument, point: EditorPoint): EditorPoint {
  const taken = Object.values(document.editor?.nodes ?? {}).flatMap((layout) =>
    layout.position === undefined ? [] : [layout.position],
  );
  let candidate: EditorPoint = { x: Math.round(point.x), y: Math.round(point.y) };
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const covered = taken.some(
      (position) =>
        Math.abs(position.x - candidate.x) < NODE_FOOTPRINT.width &&
        Math.abs(position.y - candidate.y) < NODE_FOOTPRINT.height,
    );
    if (!covered) return candidate;
    candidate = { x: candidate.x + 24, y: candidate.y + NODE_FOOTPRINT.height + 16 };
  }
  return candidate;
}

export function addNode(
  document: GraphDocument,
  id: string,
  type: string,
  version: string,
  position: EditorPoint,
): GraphDocument {
  return setPosition(
    { ...document, nodes: [...document.nodes, { id, type, version, config: {} }] },
    id,
    position,
  );
}

export function removeNode(document: GraphDocument, nodeId: string): GraphDocument {
  const layout = Object.fromEntries(
    Object.entries(document.editor?.nodes ?? {}).filter(([key]) => key !== nodeId),
  );
  return {
    ...document,
    nodes: document.nodes.filter((node) => node.id !== nodeId),
    edges: document.edges.filter(
      (edge) => edge.from.nodeId !== nodeId && edge.to.nodeId !== nodeId,
    ),
    editor: { ...(document.editor ?? {}), nodes: layout },
  };
}

export function removeEdge(document: GraphDocument, edgeId: string): GraphDocument {
  return { ...document, edges: document.edges.filter((edge) => edge.id !== edgeId) };
}

/**
 * Connect an output to an input.
 *
 * A port has one source, so a literal typed into the input earlier is dropped
 * the moment an edge feeds it.
 */
export function addDataEdge(
  document: GraphDocument,
  from: GraphEndpoint,
  to: GraphEndpoint,
): GraphDocument {
  const duplicate = document.edges.some(
    (edge) =>
      edge.kind === "data" &&
      edge.from.nodeId === from.nodeId &&
      edge.from.port === from.port &&
      edge.to.nodeId === to.nodeId &&
      edge.to.port === to.port,
  );
  if (duplicate) return document;

  const nodes = document.nodes.map((node) =>
    node.id === to.nodeId && node.bindings !== undefined
      ? withBindings(
          node,
          node.bindings.filter((binding) => binding.port !== to.port),
        )
      : node,
  );
  return {
    ...document,
    nodes,
    edges: [...document.edges, { id: newEdgeId(), kind: "data", from, to }],
  };
}

export function setConfigValue(
  document: GraphDocument,
  nodeId: string,
  key: string,
  value: JsonValue | undefined,
): GraphDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const config = Object.fromEntries(
        Object.entries(node.config).filter(([entry]) => entry !== key),
      );
      return { ...node, config: value === undefined ? config : { ...config, [key]: value } };
    }),
  };
}

export function setLiteral(
  document: GraphDocument,
  nodeId: string,
  port: string,
  value: JsonValue | undefined,
): GraphDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const others = (node.bindings ?? []).filter((binding) => binding.port !== port);
      return withBindings(
        node,
        value === undefined ? others : [...others, { kind: "literal", port, value }],
      );
    }),
  };
}

/** The executable parts of a document, without layout, for change detection. */
export function semanticDocument(parts: {
  readonly graphId: string;
  readonly inputs: readonly GraphInput[];
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly policies: GraphPolicies | undefined;
}): GraphDocument {
  return {
    schemaVersion: 1,
    graphId: parts.graphId,
    revisionId: "draft",
    inputs: parts.inputs,
    outputs: [],
    nodes: parts.nodes,
    edges: parts.edges,
    entrypoints: [],
    ...(parts.policies === undefined ? {} : { policies: parts.policies }),
  };
}

/**
 * Fill in the parts of Graph JSON the editor derives rather than asks for.
 *
 * Entrypoints are the nodes nothing feeds, and the graph's outputs are every
 * output port of the nodes nothing reads from. The execution bound is raised to
 * cover every node so adding a node never produces a policy error on its own.
 */
export function finalizeGraph(
  document: GraphDocument,
  palette: readonly PaletteEntry[] | null,
): GraphDocument {
  const dataEdges = document.edges.filter((edge): edge is GraphDataEdge => edge.kind === "data");
  const fed = new Set(dataEdges.map((edge) => JSON.stringify([edge.to.nodeId, edge.to.port])));
  const withIncoming = new Set(document.edges.map((edge) => edge.to.nodeId));
  const withOutgoing = new Set(document.edges.map((edge) => edge.from.nodeId));

  const roots = document.nodes.filter((node) => !withIncoming.has(node.id));
  const entrypoints = (roots.length > 0 ? roots : document.nodes.slice(0, 1)).map((node) => ({
    id: `entry_${identifier(node.id)}`,
    nodeId: node.id,
  }));

  const outputs = document.nodes
    .filter((node) => !withOutgoing.has(node.id))
    .flatMap((node) =>
      Object.entries(findManifest(palette, node.type, node.version)?.manifest.outputs ?? {}).map(
        ([port, spec]) => ({
          id: `${identifier(node.id)}_${identifier(port)}`,
          schema: spec.schema,
          source: { nodeId: node.id, port },
        }),
      ),
    );

  const nodes = document.nodes.map((node) =>
    node.bindings === undefined
      ? node
      : withBindings(
          node,
          node.bindings.filter((binding) => !fed.has(JSON.stringify([node.id, binding.port]))),
        ),
  );

  const first = entrypoints[0];
  return {
    ...document,
    nodes,
    entrypoints,
    outputs,
    policies: {
      ...(document.policies ?? {}),
      maxNodeExecutions: Math.max(
        document.policies?.maxNodeExecutions ?? 0,
        document.nodes.length,
        1,
      ),
      maxParallelism: document.policies?.maxParallelism ?? 4,
      capabilities: document.policies?.capabilities ?? { required: [], optional: [], deny: [] },
    },
    options: first === undefined ? {} : { defaultEntrypoint: first.id },
  };
}

function listOf<T>(record: Readonly<Record<string, unknown>>, key: string): readonly T[] {
  const value = record[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Accept a document from storage or an import.
 *
 * Both are untrusted as far as the editor is concerned, so nodes and edges
 * missing the fields the canvas reads are dropped rather than crashing it. The
 * compiler still judges everything that remains.
 */
export function parseGraphDocument(value: unknown): GraphDocument | undefined {
  if (!isRecord(value) || value["schemaVersion"] !== 1) return undefined;
  const graphId = value["graphId"];
  const rawNodes = value["nodes"];
  const rawEdges = value["edges"];
  if (typeof graphId !== "string" || !Array.isArray(rawNodes) || !Array.isArray(rawEdges)) {
    return undefined;
  }

  const nodes = (rawNodes as readonly unknown[]).flatMap((node): GraphNode[] => {
    if (!isRecord(node)) return [];
    const id = node["id"];
    const type = node["type"];
    const version = node["version"];
    if (typeof id !== "string" || typeof type !== "string" || typeof version !== "string")
      return [];
    const config = isRecord(node["config"])
      ? (node["config"] as { readonly [key: string]: JsonValue })
      : {};
    const bindings = Array.isArray(node["bindings"])
      ? (node["bindings"] as readonly unknown[]).filter(
          (binding): binding is GraphBinding =>
            isRecord(binding) &&
            typeof binding["port"] === "string" &&
            typeof binding["kind"] === "string",
        )
      : [];
    const base = { id, type, version, config };
    return [bindings.length === 0 ? base : { ...base, bindings }];
  });

  const endpoint = (candidate: unknown, portRequired: boolean): boolean =>
    isRecord(candidate) &&
    typeof candidate["nodeId"] === "string" &&
    (!portRequired || typeof candidate["port"] === "string");
  const edges = (rawEdges as readonly unknown[]).filter(
    (edge): edge is GraphEdge =>
      isRecord(edge) &&
      typeof edge["id"] === "string" &&
      (edge["kind"] === "data" || edge["kind"] === "control") &&
      endpoint(edge["from"], edge["kind"] === "data") &&
      endpoint(edge["to"], edge["kind"] === "data"),
  );

  const revisionId = value["revisionId"];
  const metadata = value["metadata"];
  const policies = value["policies"];
  const options = value["options"];
  const editor = value["editor"];

  return {
    schemaVersion: 1,
    graphId,
    revisionId: typeof revisionId === "string" ? revisionId : "draft",
    ...(isRecord(metadata) ? { metadata: metadata } : {}),
    inputs: listOf<GraphInput>(value, "inputs"),
    outputs: listOf<GraphOutput>(value, "outputs"),
    nodes,
    edges,
    entrypoints: listOf<GraphEntrypoint>(value, "entrypoints"),
    ...(isRecord(policies) ? { policies: policies } : {}),
    ...(isRecord(options) ? { options: options } : {}),
    ...(isRecord(editor) ? { editor: editor } : {}),
  };
}
