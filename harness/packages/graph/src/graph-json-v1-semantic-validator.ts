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

function hasOwnPort(ports: Readonly<Record<string, unknown>>, port: string): boolean {
  return Object.prototype.hasOwnProperty.call(ports, port);
}

function addInputSource(
  counts: Map<string, Map<string, number>>,
  nodeId: string,
  port: string,
): void {
  let nodeCounts = counts.get(nodeId);
  if (nodeCounts === undefined) {
    nodeCounts = new Map<string, number>();
    counts.set(nodeId, nodeCounts);
  }

  nodeCounts.set(port, (nodeCounts.get(port) ?? 0) + 1);
}

/**
 * Validate the currently frozen Graph JSON v1 Harness semantics.
 *
 * Items 2.6-2.7 own only:
 * - unique IDs inside each semantic namespace;
 * - exact node `type@version` resolution against the supplied manifest registry;
 * - static graph reference and data-port existence;
 * - non-edge binding target/reference existence; and
 * - required/single-vs-multiple input cardinality across bindings and data edges.
 *
 * IDs are intentionally not globally unique across different namespaces. For
 * example, a graph input and a node may both be named `prompt` without conflict.
 *
 * Port schema compatibility, structured control-port meaning, reachability,
 * cycles, capability policy, secret-only enforcement, and structured diagnostics
 * belong to later passes.
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

  const manifestsByNodeId = new Map<string, NodeManifest>();

  for (const node of graph.nodes) {
    const manifest = resolver.getManifest(node.type, node.version);
    if (manifest === undefined) {
      return false;
    }
    manifestsByNodeId.set(node.id, manifest);
  }

  const graphInputIds = new Set(graph.inputs.map((input) => input.id));
  const entrypointIds = new Set(graph.entrypoints.map((entrypoint) => entrypoint.id));
  const inputSourceCounts = new Map<string, Map<string, number>>();

  for (const output of graph.outputs) {
    const manifest = manifestsByNodeId.get(output.source.nodeId);
    if (manifest === undefined || !hasOwnPort(manifest.outputs, output.source.port)) {
      return false;
    }
  }

  for (const node of graph.nodes) {
    const manifest = manifestsByNodeId.get(node.id)!;

    for (const binding of node.bindings ?? []) {
      if (!hasOwnPort(manifest.inputs, binding.port)) {
        return false;
      }

      if (binding.kind === "graph-input" && !graphInputIds.has(binding.input)) {
        return false;
      }

      addInputSource(inputSourceCounts, node.id, binding.port);
    }
  }

  for (const edge of graph.edges) {
    const sourceManifest = manifestsByNodeId.get(edge.from.nodeId);
    const targetManifest = manifestsByNodeId.get(edge.to.nodeId);

    if (sourceManifest === undefined || targetManifest === undefined) {
      return false;
    }

    if (edge.kind === "control") {
      continue;
    }

    if (
      !hasOwnPort(sourceManifest.outputs, edge.from.port) ||
      !hasOwnPort(targetManifest.inputs, edge.to.port)
    ) {
      return false;
    }

    addInputSource(inputSourceCounts, edge.to.nodeId, edge.to.port);
  }

  for (const entrypoint of graph.entrypoints) {
    if (!manifestsByNodeId.has(entrypoint.nodeId)) {
      return false;
    }
  }

  if (
    graph.options?.defaultEntrypoint !== undefined &&
    !entrypointIds.has(graph.options.defaultEntrypoint)
  ) {
    return false;
  }

  for (const [nodeId, manifest] of manifestsByNodeId) {
    const nodeCounts = inputSourceCounts.get(nodeId);

    for (const [portName, port] of Object.entries(manifest.inputs)) {
      const sourceCount = nodeCounts?.get(portName) ?? 0;

      if (port.required === true && sourceCount === 0) {
        return false;
      }

      if (port.multiple !== true && sourceCount > 1) {
        return false;
      }
    }
  }

  return true;
}
