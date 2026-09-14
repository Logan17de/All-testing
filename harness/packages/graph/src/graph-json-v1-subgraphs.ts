import type { JsonValue } from "@zet-harness/plugin-api";

import type {
  GraphDataEdgeV1,
  GraphEdgeV1,
  GraphEntrypointV1,
  GraphInputBindingV1,
  GraphJsonV1,
  GraphNodeV1,
  GraphOutputPortV1,
} from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

/** Config keys naming the saved graph revision a subgraph node runs. */
export const GRAPH_SUBGRAPH_GRAPH_ID_CONFIG_KEY = "graphId" as const;
export const GRAPH_SUBGRAPH_REVISION_ID_CONFIG_KEY = "revisionId" as const;
/** Separates a subgraph node's id from the ids of the nodes it expands into. */
export const GRAPH_SUBGRAPH_SEPARATOR = "/" as const;
/** How many subgraphs may nest inside one another. */
export const GRAPH_SUBGRAPH_MAX_DEPTH = 8;

export type GraphSubgraphDiagnosticCode =
  | "GRAPH_SUBGRAPH_REFERENCE_INVALID"
  | "GRAPH_SUBGRAPH_NOT_FOUND"
  | "GRAPH_SUBGRAPH_RECURSION"
  | "GRAPH_SUBGRAPH_TOO_DEEP"
  | "GRAPH_SUBGRAPH_PORT_UNKNOWN"
  | "GRAPH_SUBGRAPH_INPUT_UNBOUND";

export interface GraphSubgraphDiagnostic {
  readonly code: GraphSubgraphDiagnosticCode;
  readonly message: string;
  readonly nodeId: string;
  readonly edgeId?: string;
  readonly port?: string;
}

/** Looks up a saved graph by its immutable graph id and revision id. */
export interface GraphSourceResolver {
  getGraph(graphId: string, revisionId: string): GraphJsonV1 | undefined;
}

export interface GraphSubgraphReference {
  readonly graphId: string;
  readonly revisionId: string;
}

export interface GraphSubgraphExpansionResult {
  readonly valid: boolean;
  /** The graph with every subgraph node replaced by the nodes of the graph it names. */
  readonly graph: GraphJsonV1;
  readonly diagnostics: readonly GraphSubgraphDiagnostic[];
  /** Saved graph revisions the expansion used, in first-use order. */
  readonly references: readonly GraphSubgraphReference[];
}

const union = (...lists: readonly (readonly string[] | undefined)[]): string[] => [
  ...new Set(lists.flatMap((list) => list ?? [])),
];

/**
 * Expand subgraph nodes at compile time (8.4).
 *
 * A subgraph node is any node whose manifest declares a `subgraph` control
 * contract. Its `config.graphId` and `config.revisionId` pin one saved graph
 * revision, which is spliced into the parent before validation: its nodes and
 * edges are namespaced under the subgraph node's id, and the parent's wiring is
 * rewritten onto them.
 *
 * - A data edge or binding into the subgraph node's port `x` feeds the saved
 *   graph's input `x`; an unfed input falls back to its default.
 * - A data edge out of the subgraph node's port `y` reads the saved graph's
 *   output `y`.
 * - Anything that runs before the subgraph node now runs before the saved
 *   graph's start nodes, and anything after it waits for all of its final nodes.
 * - An entrypoint on the subgraph node starts the saved graph's start nodes.
 *
 * Recursion is refused: a saved graph may not appear inside itself, at any
 * revision, and nesting is capped at `GRAPH_SUBGRAPH_MAX_DEPTH`. Expansion is a
 * pure function of pinned revisions, so compiling the same parent twice yields
 * the same expanded graph and the same identity.
 */
export function expandGraphJsonV1Subgraphs(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
  sources: GraphSourceResolver,
): GraphSubgraphExpansionResult {
  const diagnostics: GraphSubgraphDiagnostic[] = [];
  const references: GraphSubgraphReference[] = [];
  const used = new Set<string>();

  const expand = (
    current: GraphJsonV1,
    chain: readonly string[],
    depth: number,
    prefix: string,
  ): GraphJsonV1 => {
    let result = current;
    for (const node of current.nodes) {
      if (resolver.getManifest(node.type, node.version)?.control?.kind !== "subgraph") continue;
      const where = `${prefix}${node.id}`;
      const graphId = node.config[GRAPH_SUBGRAPH_GRAPH_ID_CONFIG_KEY];
      const revisionId = node.config[GRAPH_SUBGRAPH_REVISION_ID_CONFIG_KEY];
      if (
        typeof graphId !== "string" ||
        graphId.length === 0 ||
        typeof revisionId !== "string" ||
        revisionId.length === 0
      ) {
        diagnostics.push({
          code: "GRAPH_SUBGRAPH_REFERENCE_INVALID",
          message: `Subgraph node '${where}' needs config.graphId and config.revisionId naming a saved graph revision.`,
          nodeId: where,
        });
        continue;
      }
      if (chain.includes(graphId)) {
        diagnostics.push({
          code: "GRAPH_SUBGRAPH_RECURSION",
          message: `Subgraph node '${where}' runs graph '${graphId}', which already contains it; recursive subgraphs are not supported.`,
          nodeId: where,
        });
        continue;
      }
      if (depth + 1 > GRAPH_SUBGRAPH_MAX_DEPTH) {
        diagnostics.push({
          code: "GRAPH_SUBGRAPH_TOO_DEEP",
          message: `Subgraph node '${where}' nests deeper than ${String(GRAPH_SUBGRAPH_MAX_DEPTH)} subgraphs.`,
          nodeId: where,
        });
        continue;
      }
      const saved = sources.getGraph(graphId, revisionId);
      if (saved === undefined) {
        diagnostics.push({
          code: "GRAPH_SUBGRAPH_NOT_FOUND",
          message: `Subgraph node '${where}' names graph '${graphId}' revision '${revisionId}', which is not saved.`,
          nodeId: where,
        });
        continue;
      }
      const key = `${graphId}@${revisionId}`;
      if (!used.has(key)) {
        used.add(key);
        references.push(Object.freeze({ graphId, revisionId }));
      }
      const child = expand(
        saved,
        [...chain, graphId],
        depth + 1,
        `${where}${GRAPH_SUBGRAPH_SEPARATOR}`,
      );
      result = splice(result, node, child, where, diagnostics);
    }
    return result;
  };

  const expanded = expand(graph, [graph.graphId], 0, "");
  return Object.freeze({
    valid: diagnostics.length === 0,
    graph: expanded,
    diagnostics: Object.freeze(diagnostics),
    references: Object.freeze(references),
  });
}

function splice(
  parent: GraphJsonV1,
  subgraph: GraphNodeV1,
  child: GraphJsonV1,
  where: string,
  diagnostics: GraphSubgraphDiagnostic[],
): GraphJsonV1 {
  const ns = (id: string): string => `${subgraph.id}${GRAPH_SUBGRAPH_SEPARATOR}${id}`;
  const inputs = new Map(child.inputs.map((input) => [input.id, input] as const));
  const outputs = new Map(child.outputs.map((output) => [output.id, output] as const));
  const intoSubgraph = parent.edges.filter((edge) => edge.to.nodeId === subgraph.id);
  const outOfSubgraph = parent.edges.filter((edge) => edge.from.nodeId === subgraph.id);
  const unrelated = parent.edges.filter(
    (edge) => edge.to.nodeId !== subgraph.id && edge.from.nodeId !== subgraph.id,
  );

  for (const edge of intoSubgraph) {
    if (edge.kind === "data" && !inputs.has(edge.to.port)) {
      diagnostics.push({
        code: "GRAPH_SUBGRAPH_PORT_UNKNOWN",
        message: `Edge '${edge.id}' feeds '${edge.to.port}', which the graph run by '${where}' has no input for.`,
        nodeId: where,
        edgeId: edge.id,
        port: edge.to.port,
      });
    }
  }
  for (const binding of subgraph.bindings ?? []) {
    if (!inputs.has(binding.port)) {
      diagnostics.push({
        code: "GRAPH_SUBGRAPH_PORT_UNKNOWN",
        message: `Subgraph node '${where}' sets '${binding.port}', which the graph it runs has no input for.`,
        nodeId: where,
        port: binding.port,
      });
    }
  }
  for (const edge of outOfSubgraph) {
    if (edge.kind === "data" && !outputs.has(edge.from.port)) {
      diagnostics.push({
        code: "GRAPH_SUBGRAPH_PORT_UNKNOWN",
        message: `Edge '${edge.id}' reads '${edge.from.port}', which the graph run by '${where}' has no output for.`,
        nodeId: where,
        edgeId: edge.id,
        port: edge.from.port,
      });
    }
  }

  const withIncoming = new Set(child.edges.map((edge) => edge.to.nodeId));
  const withOutgoing = new Set(child.edges.map((edge) => edge.from.nodeId));
  const starts =
    child.entrypoints.length > 0
      ? [...new Set(child.entrypoints.map((entrypoint) => entrypoint.nodeId))]
      : child.nodes.filter((node) => !withIncoming.has(node.id)).map((node) => node.id);
  const finals = child.nodes.filter((node) => !withOutgoing.has(node.id)).map((node) => node.id);

  const generated: GraphEdgeV1[] = [];
  const unbound = new Set<string>();

  const nodes: GraphNodeV1[] = child.nodes.map((node) => {
    const bindings: GraphInputBindingV1[] = [];
    for (const binding of node.bindings ?? []) {
      if (binding.kind !== "graph-input") {
        bindings.push(binding);
        continue;
      }
      const inputId = binding.input;
      const feeding = intoSubgraph.filter(
        (edge): edge is GraphDataEdgeV1 => edge.kind === "data" && edge.to.port === inputId,
      );
      const set = (subgraph.bindings ?? []).filter((candidate) => candidate.port === inputId);
      for (const edge of feeding) {
        generated.push({
          id: `${edge.id}${GRAPH_SUBGRAPH_SEPARATOR}${ns(node.id)}${GRAPH_SUBGRAPH_SEPARATOR}${binding.port}`,
          kind: "data",
          from: edge.from,
          to: { nodeId: ns(node.id), port: binding.port },
        });
      }
      for (const value of set) bindings.push({ ...value, port: binding.port });
      if (feeding.length === 0 && set.length === 0) {
        const input = inputs.get(inputId);
        const fallback: JsonValue | undefined = input?.default;
        if (fallback !== undefined) {
          bindings.push({ kind: "literal", port: binding.port, value: fallback });
        } else if (input?.required === true && !unbound.has(inputId)) {
          unbound.add(inputId);
          diagnostics.push({
            code: "GRAPH_SUBGRAPH_INPUT_UNBOUND",
            message: `Subgraph node '${where}' leaves required input '${inputId}' of the graph it runs unset.`,
            nodeId: where,
            port: inputId,
          });
        }
      }
    }
    const base = { id: ns(node.id), type: node.type, version: node.version, config: node.config };
    return bindings.length === 0 ? base : { ...base, bindings };
  });

  const childEdges: GraphEdgeV1[] = child.edges.map((edge) =>
    edge.kind === "data"
      ? {
          ...edge,
          id: ns(edge.id),
          from: { ...edge.from, nodeId: ns(edge.from.nodeId) },
          to: { ...edge.to, nodeId: ns(edge.to.nodeId) },
        }
      : {
          ...edge,
          id: ns(edge.id),
          from: { ...edge.from, nodeId: ns(edge.from.nodeId) },
          to: { ...edge.to, nodeId: ns(edge.to.nodeId) },
        },
  );

  // Whatever ran before the subgraph node now runs before the saved graph starts.
  for (const edge of intoSubgraph) {
    for (const start of starts) {
      generated.push({
        id: `${edge.id}${GRAPH_SUBGRAPH_SEPARATOR}start${GRAPH_SUBGRAPH_SEPARATOR}${ns(start)}`,
        kind: "control",
        from: edge.kind === "data" ? { nodeId: edge.from.nodeId } : edge.from,
        to: { nodeId: ns(start) },
      });
    }
  }

  for (const edge of outOfSubgraph) {
    if (edge.kind === "data") {
      const output = outputs.get(edge.from.port);
      if (output !== undefined) {
        generated.push({
          ...edge,
          from: { nodeId: ns(output.source.nodeId), port: output.source.port },
        });
      }
      continue;
    }
    // Whatever ran after the subgraph node waits for every final node of the saved graph.
    for (const last of finals) {
      generated.push({
        id: `${edge.id}${GRAPH_SUBGRAPH_SEPARATOR}${ns(last)}`,
        kind: "control",
        from: { nodeId: ns(last) },
        to: edge.to,
      });
    }
  }

  const entrypoints: GraphEntrypointV1[] = parent.entrypoints.flatMap((entrypoint) => {
    if (entrypoint.nodeId !== subgraph.id) return [entrypoint];
    return starts.map((start, index) => ({
      id: index === 0 ? entrypoint.id : `${entrypoint.id}${GRAPH_SUBGRAPH_SEPARATOR}${ns(start)}`,
      nodeId: ns(start),
    }));
  });

  const graphOutputs: GraphOutputPortV1[] = parent.outputs.map((output) => {
    if (output.source.nodeId !== subgraph.id) return output;
    const inner = outputs.get(output.source.port);
    return inner === undefined
      ? output
      : {
          ...output,
          source: { nodeId: ns(inner.source.nodeId), port: inner.source.port },
        };
  });

  const parentCapabilities = parent.policies?.capabilities;
  const childCapabilities = child.policies?.capabilities;
  // The saved graph brings its own node-execution budget: the parent's covers its own nodes,
  // and the subgraph node it replaces never ran an attempt of its own.
  const parentExecutions = parent.policies?.maxNodeExecutions;
  const childExecutions = child.policies?.maxNodeExecutions;
  return {
    ...parent,
    outputs: graphOutputs,
    nodes: [...parent.nodes.filter((node) => node.id !== subgraph.id), ...nodes],
    edges: [...unrelated, ...childEdges, ...generated],
    entrypoints,
    ...(parent.policies === undefined && childCapabilities === undefined
      ? {}
      : {
          policies: {
            ...(parent.policies ?? {}),
            ...(parentExecutions !== undefined && childExecutions !== undefined
              ? { maxNodeExecutions: parentExecutions + childExecutions }
              : {}),
            capabilities: {
              required: union(parentCapabilities?.required, childCapabilities?.required),
              optional: union(parentCapabilities?.optional, childCapabilities?.optional),
              deny: union(parentCapabilities?.deny, childCapabilities?.deny),
            },
          },
        }),
  };
}
