import type { NodeManifest } from "@zet-harness/plugin-api";

import type { GraphJsonV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

export type GraphLivenessDiagnosticCode =
  | "GRAPH_LIVENESS_PREREQUISITE_FAILED"
  | "GRAPH_NODE_UNREACHABLE"
  | "GRAPH_OUTPUT_UNREACHABLE"
  | "GRAPH_DATA_SOURCE_IMPOSSIBLE"
  | "GRAPH_OUTPUT_SOURCE_IMPOSSIBLE"
  | "GRAPH_INPUT_SOURCE_IMPOSSIBLE";

export interface GraphLivenessDiagnostic {
  readonly code: GraphLivenessDiagnosticCode;
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly port?: string;
  readonly graphPortId?: string;
}

export interface GraphLivenessResult {
  readonly valid: boolean;
  readonly reachableNodeIds: readonly string[];
  readonly diagnostics: readonly GraphLivenessDiagnostic[];
}

function resolveManifests(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): Map<string, NodeManifest> | undefined {
  const manifests = new Map<string, NodeManifest>();

  for (const node of graph.nodes) {
    const manifest = resolver.getManifest(node.type, node.version);
    if (manifest === undefined) {
      return undefined;
    }
    manifests.set(node.id, manifest);
  }

  return manifests;
}

function collectReachableNodeIds(graph: GraphJsonV1): Set<string> {
  const adjacency = new Map<string, string[]>();

  for (const node of graph.nodes) {
    adjacency.set(node.id, []);
  }

  for (const edge of graph.edges) {
    adjacency.get(edge.from.nodeId)?.push(edge.to.nodeId);
  }

  const reachable = new Set<string>();
  const queue: string[] = [];

  for (const entrypoint of graph.entrypoints) {
    if (!reachable.has(entrypoint.nodeId)) {
      reachable.add(entrypoint.nodeId);
      queue.push(entrypoint.nodeId);
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]!;

    for (const targetNodeId of adjacency.get(nodeId) ?? []) {
      if (!reachable.has(targetNodeId)) {
        reachable.add(targetNodeId);
        queue.push(targetNodeId);
      }
    }
  }

  return reachable;
}

/**
 * Run the narrow 2.9 reachability/liveness stage.
 *
 * Reachability is deliberately *potential* reachability only: every data or
 * control edge contributes a directed path from `from.nodeId` to `to.nodeId`.
 * Named control ports and branch satisfiability are not interpreted here; those
 * belong to the structured-control work in 2.11. Cycles are tolerated by this
 * traversal and are rejected separately by 2.10.
 *
 * This stage also rejects live value flows whose source schema is literally
 * `false`. 2.8 may correctly classify `false -> any target` as mathematically
 * type-compatible, but a live data edge/public output cannot receive a JSON
 * value from an impossible source. Keeping that check here preserves the 2.8
 * compatibility boundary.
 *
 * Callers should run 2.6-2.7 semantic validation first. Missing references are
 * reported only as prerequisite failures here rather than reimplementing those
 * earlier passes.
 */
export function checkGraphJsonV1Liveness(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): GraphLivenessResult {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const graphInputs = new Map(graph.inputs.map((input) => [input.id, input] as const));
  const manifests = resolveManifests(graph, resolver);
  const prerequisiteDiagnostics: GraphLivenessDiagnostic[] = [];

  if (manifests === undefined) {
    return {
      valid: false,
      reachableNodeIds: [],
      diagnostics: [
        {
          code: "GRAPH_LIVENESS_PREREQUISITE_FAILED",
          message: "Liveness validation requires every node type/version to resolve first.",
        },
      ],
    };
  }

  for (const entrypoint of graph.entrypoints) {
    if (!nodeIds.has(entrypoint.nodeId)) {
      prerequisiteDiagnostics.push({
        code: "GRAPH_LIVENESS_PREREQUISITE_FAILED",
        message: `Entrypoint '${entrypoint.id}' references missing node '${entrypoint.nodeId}'; 2.6-2.7 must succeed before 2.9.`,
        nodeId: entrypoint.nodeId,
      });
    }
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from.nodeId) || !nodeIds.has(edge.to.nodeId)) {
      prerequisiteDiagnostics.push({
        code: "GRAPH_LIVENESS_PREREQUISITE_FAILED",
        message: `Edge '${edge.id}' references a missing node; 2.6-2.7 must succeed before 2.9.`,
        edgeId: edge.id,
      });
    }
  }

  if (prerequisiteDiagnostics.length > 0) {
    return {
      valid: false,
      reachableNodeIds: [],
      diagnostics: prerequisiteDiagnostics,
    };
  }

  const reachable = collectReachableNodeIds(graph);
  const diagnostics: GraphLivenessDiagnostic[] = [];

  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) {
      diagnostics.push({
        code: "GRAPH_NODE_UNREACHABLE",
        message: `Node '${node.id}' is not potentially reachable from any graph entrypoint.`,
        nodeId: node.id,
      });
    }
  }

  for (const output of graph.outputs) {
    if (!reachable.has(output.source.nodeId)) {
      diagnostics.push({
        code: "GRAPH_OUTPUT_UNREACHABLE",
        message: `Graph output '${output.id}' is produced by unreachable node '${output.source.nodeId}'.`,
        nodeId: output.source.nodeId,
        port: output.source.port,
        graphPortId: output.id,
      });
      continue;
    }

    const sourcePort = manifests.get(output.source.nodeId)?.outputs[output.source.port];
    if (sourcePort === undefined) {
      diagnostics.push({
        code: "GRAPH_LIVENESS_PREREQUISITE_FAILED",
        message: `Graph output '${output.id}' references an unresolved source port; 2.6-2.7 must succeed before 2.9.`,
        nodeId: output.source.nodeId,
        port: output.source.port,
        graphPortId: output.id,
      });
    } else if (sourcePort.schema === false) {
      diagnostics.push({
        code: "GRAPH_OUTPUT_SOURCE_IMPOSSIBLE",
        message: `Graph output '${output.id}' depends on impossible source '${output.source.nodeId}.${output.source.port}' whose schema is false.`,
        nodeId: output.source.nodeId,
        port: output.source.port,
        graphPortId: output.id,
      });
    }
  }

  for (const edge of graph.edges) {
    if (edge.kind !== "data" || !reachable.has(edge.from.nodeId)) {
      continue;
    }

    const sourcePort = manifests.get(edge.from.nodeId)?.outputs[edge.from.port];
    if (sourcePort === undefined) {
      diagnostics.push({
        code: "GRAPH_LIVENESS_PREREQUISITE_FAILED",
        message: `Data edge '${edge.id}' references an unresolved source port; 2.6-2.7 must succeed before 2.9.`,
        nodeId: edge.from.nodeId,
        edgeId: edge.id,
        port: edge.from.port,
      });
    } else if (sourcePort.schema === false) {
      diagnostics.push({
        code: "GRAPH_DATA_SOURCE_IMPOSSIBLE",
        message: `Data edge '${edge.id}' depends on impossible source '${edge.from.nodeId}.${edge.from.port}' whose schema is false.`,
        nodeId: edge.from.nodeId,
        edgeId: edge.id,
        port: edge.from.port,
      });
    }
  }

  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) {
      continue;
    }

    for (const binding of node.bindings ?? []) {
      if (binding.kind !== "graph-input") {
        continue;
      }

      const graphInput = graphInputs.get(binding.input);
      if (graphInput === undefined) {
        diagnostics.push({
          code: "GRAPH_LIVENESS_PREREQUISITE_FAILED",
          message: `Graph-input binding '${binding.input}' -> '${node.id}.${binding.port}' is unresolved; 2.6-2.7 must succeed before 2.9.`,
          nodeId: node.id,
          port: binding.port,
          graphPortId: binding.input,
        });
      } else if (graphInput.schema === false) {
        diagnostics.push({
          code: "GRAPH_INPUT_SOURCE_IMPOSSIBLE",
          message: `Reachable node '${node.id}' depends on graph input '${binding.input}' whose schema is false.`,
          nodeId: node.id,
          port: binding.port,
          graphPortId: binding.input,
        });
      }
    }
  }

  return {
    valid: diagnostics.length === 0,
    reachableNodeIds: graph.nodes.filter((node) => reachable.has(node.id)).map((node) => node.id),
    diagnostics,
  };
}

/** Boolean convenience wrapper for the separate 2.9 liveness stage. */
export function validateGraphJsonV1Liveness(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): boolean {
  return checkGraphJsonV1Liveness(graph, resolver).valid;
}
