/**
 * What changed between two revisions of a graph.
 *
 * The compiler already answers whether two revisions *mean* the same thing: the
 * semantic hash covers the executable projection and the document hash covers the
 * whole document, so moving a node on the canvas changes the document and not the
 * semantics. This says what changed in terms a person recognises — this node was
 * added, that one's version moved, this edge is gone — so the hashes have an
 * explanation beside them.
 *
 * It compares documents, not plans: nothing here compiles, resolves or runs.
 */
import { stringifyCanonicalJsonV1 } from "./graph-json-v1-canonical.js";
import type { GraphEdgeV1, GraphJsonV1, GraphNodeV1, GraphSemanticsV1 } from "./graph-json-v1.js";

/** What kind of change a node saw. A node can see several at once. */
export type GraphNodeChangeKind = "version" | "type" | "config" | "bindings";

export interface GraphNodeChange {
  readonly nodeId: string;
  readonly changes: readonly GraphNodeChangeKind[];
  readonly before: { readonly type: string; readonly version: string };
  readonly after: { readonly type: string; readonly version: string };
}

export interface GraphEdgeSummary {
  readonly id: string;
  readonly kind: "data" | "control";
  /** `from → to`, as the editor would read it. */
  readonly label: string;
}

export interface GraphJsonDiffV1 {
  readonly graphId: string;
  readonly from: string;
  readonly to: string;
  /** True when the two revisions would compile to the same plan. */
  readonly sameSemantics: boolean;
  /** True when nothing at all changed, including editor metadata. */
  readonly identical: boolean;
  readonly nodesAdded: readonly GraphNodeV1[];
  readonly nodesRemoved: readonly GraphNodeV1[];
  readonly nodesChanged: readonly GraphNodeChange[];
  readonly edgesAdded: readonly GraphEdgeSummary[];
  readonly edgesRemoved: readonly GraphEdgeSummary[];
  /** Parts of the document that changed as a whole, such as `policies`. */
  readonly sectionsChanged: readonly string[];
  /** One line a person can read, which is what most of the UI needs. */
  readonly summary: string;
}

function canonical(value: unknown): string {
  return stringifyCanonicalJsonV1((value ?? null) as never);
}

function endpointLabel(endpoint: unknown): string {
  if (typeof endpoint !== "object" || endpoint === null) return "?";
  const record = endpoint as { readonly nodeId?: unknown; readonly port?: unknown };
  const node = typeof record.nodeId === "string" ? record.nodeId : "?";
  return typeof record.port === "string" ? `${node}.${record.port}` : node;
}

function edgeSummary(edge: GraphEdgeV1): GraphEdgeSummary {
  const record = edge as unknown as {
    readonly id: string;
    readonly kind: "data" | "control";
    readonly from: unknown;
    readonly to: unknown;
  };
  return Object.freeze({
    id: record.id,
    kind: record.kind,
    label: `${endpointLabel(record.from)} → ${endpointLabel(record.to)}`,
  });
}

function nodeChanges(before: GraphNodeV1, after: GraphNodeV1): readonly GraphNodeChangeKind[] {
  const changes: GraphNodeChangeKind[] = [];
  if (before.type !== after.type) changes.push("type");
  if (before.version !== after.version) changes.push("version");
  if (canonical(before.config) !== canonical(after.config)) changes.push("config");
  if (canonical(before.bindings ?? []) !== canonical(after.bindings ?? []))
    changes.push("bindings");
  return Object.freeze(changes);
}

/** The executable projection, which is what the semantic hash covers. */
function semantics(graph: GraphJsonV1): GraphSemanticsV1 {
  return {
    schemaVersion: graph.schemaVersion,
    inputs: graph.inputs,
    outputs: graph.outputs,
    nodes: graph.nodes,
    edges: graph.edges,
    entrypoints: graph.entrypoints,
    ...(graph.policies === undefined ? {} : { policies: graph.policies }),
    ...(graph.options === undefined ? {} : { options: graph.options }),
  };
}

function countPhrase(count: number, one: string, many: string): string | undefined {
  if (count === 0) return undefined;
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** Compare two revisions of one graph. */
export function diffGraphJsonV1(before: GraphJsonV1, after: GraphJsonV1): GraphJsonDiffV1 {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map(
    before.edges.map((edge) => [(edge as unknown as { readonly id: string }).id, edge]),
  );
  const afterEdges = new Map(
    after.edges.map((edge) => [(edge as unknown as { readonly id: string }).id, edge]),
  );

  const nodesAdded = [...afterNodes.values()].filter((node) => !beforeNodes.has(node.id));
  const nodesRemoved = [...beforeNodes.values()].filter((node) => !afterNodes.has(node.id));
  const nodesChanged: GraphNodeChange[] = [];
  for (const [id, beforeNode] of beforeNodes) {
    const afterNode = afterNodes.get(id);
    if (afterNode === undefined) continue;
    const changes = nodeChanges(beforeNode, afterNode);
    if (changes.length === 0) continue;
    nodesChanged.push(
      Object.freeze({
        nodeId: id,
        changes,
        before: Object.freeze({ type: beforeNode.type, version: beforeNode.version }),
        after: Object.freeze({ type: afterNode.type, version: afterNode.version }),
      }),
    );
  }

  const edgesAdded = [...afterEdges.entries()]
    .filter(([id]) => !beforeEdges.has(id))
    .map(([, edge]) => edgeSummary(edge));
  const edgesRemoved = [...beforeEdges.entries()]
    .filter(([id]) => !afterEdges.has(id))
    .map(([, edge]) => edgeSummary(edge));
  // An edge kept its id but was rewired: that is a change to the edges as a whole.
  const edgesRewired = [...beforeEdges.entries()].some(([id, edge]) => {
    const other = afterEdges.get(id);
    return other !== undefined && canonical(edge) !== canonical(other);
  });

  const sectionsChanged: string[] = [];
  for (const section of ["inputs", "outputs", "entrypoints", "policies", "options"] as const) {
    if (canonical(before[section]) !== canonical(after[section])) sectionsChanged.push(section);
  }
  if (edgesRewired) sectionsChanged.push("edges");
  if (canonical(before.editor) !== canonical(after.editor)) sectionsChanged.push("editor");
  if (canonical(before.metadata) !== canonical(after.metadata)) sectionsChanged.push("metadata");

  const sameSemantics = canonical(semantics(before)) === canonical(semantics(after));
  const identical =
    sameSemantics &&
    canonical(before.editor) === canonical(after.editor) &&
    canonical(before.metadata) === canonical(after.metadata);

  const parts = [
    countPhrase(nodesAdded.length, "node added", "nodes added"),
    countPhrase(nodesRemoved.length, "node removed", "nodes removed"),
    countPhrase(nodesChanged.length, "node changed", "nodes changed"),
    countPhrase(edgesAdded.length, "edge added", "edges added"),
    countPhrase(edgesRemoved.length, "edge removed", "edges removed"),
  ].filter((part): part is string => part !== undefined);
  // Only the canvas moved: say that plainly rather than listing a section name.
  const onlyPresentation =
    sameSemantics &&
    parts.length === 0 &&
    sectionsChanged.every((section) => section === "editor" || section === "metadata");
  const sections = sectionsChanged.filter((section) => section !== "edges");
  if (sections.length > 0 && !onlyPresentation) parts.push(`${sections.join(", ")} changed`);

  const summary = identical
    ? "No changes."
    : onlyPresentation
      ? "Only editor details changed."
      : parts.length === 0
        ? "The graph changed."
        : `${parts.join(", ")}.${sameSemantics ? " The graph still runs the same way." : ""}`;

  return Object.freeze({
    graphId: after.graphId,
    from: before.revisionId,
    to: after.revisionId,
    sameSemantics,
    identical,
    nodesAdded: Object.freeze(nodesAdded),
    nodesRemoved: Object.freeze(nodesRemoved),
    nodesChanged: Object.freeze(nodesChanged),
    edgesAdded: Object.freeze(edgesAdded),
    edgesRemoved: Object.freeze(edgesRemoved),
    sectionsChanged: Object.freeze(sectionsChanged),
    summary,
  });
}
