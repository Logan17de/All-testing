import type { NodeManifest, NodeType, Version } from "@zet-harness/plugin-api";

import type { GraphJsonV1 } from "./graph-json-v1.js";

/**
 * Minimal registry-facing contract required by graph semantic validation.
 *
 * This is structural on purpose: `packages/graph` must not depend on private
 * core registry implementations. `NodeCatalog` already satisfies this shape.
 */
export interface NodeManifestResolver {
  getManifest(type: NodeType, version: Version): NodeManifest | undefined;
}

function hasUniqueIds(values: readonly { readonly id: string }[]): boolean {
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value.id)) {
      return false;
    }
    seen.add(value.id);
  }

  return true;
}

/**
 * Validate the first narrow layer of Graph JSON v1 Harness semantics.
 *
 * Item 2.6 owns only:
 * - unique IDs inside each semantic namespace; and
 * - exact node `type@version` resolution against the supplied manifest registry.
 *
 * IDs are intentionally not globally unique across different namespaces. For
 * example, a graph input and a node may both be named `prompt` without conflict.
 *
 * Port existence/cardinality, graph references, compatibility, reachability,
 * cycles, capability policy, and structured diagnostics belong to later passes.
 */
export function validateGraphJsonV1Semantics(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): boolean {
  if (
    !hasUniqueIds(graph.inputs) ||
    !hasUniqueIds(graph.outputs) ||
    !hasUniqueIds(graph.nodes) ||
    !hasUniqueIds(graph.edges) ||
    !hasUniqueIds(graph.entrypoints)
  ) {
    return false;
  }

  return graph.nodes.every((node) => resolver.getManifest(node.type, node.version) !== undefined);
}
