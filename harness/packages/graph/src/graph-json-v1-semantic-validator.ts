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

export type GraphSemanticDiagnosticCode =
  | "GRAPH_SEMANTIC_DUPLICATE_ID"
  | "GRAPH_NODE_MANIFEST_UNRESOLVED"
  | "GRAPH_REFERENCE_UNRESOLVED"
  | "GRAPH_PORT_UNKNOWN"
  | "GRAPH_INPUT_REQUIRED"
  | "GRAPH_INPUT_CARDINALITY_EXCEEDED";

export interface GraphSemanticDiagnostic {
  readonly code: GraphSemanticDiagnosticCode;
  readonly message: string;
  readonly path: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly entrypointId?: string;
  readonly graphPortId?: string;
  readonly port?: string;
}

export interface GraphSemanticValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly GraphSemanticDiagnostic[];
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

function collectDuplicateIds(
  values: readonly { readonly id: string }[],
  namespace: "inputs" | "outputs" | "nodes" | "edges" | "entrypoints",
  diagnostics: GraphSemanticDiagnostic[],
): void {
  const seen = new Map<string, number>();

  values.forEach((value, index) => {
    const firstIndex = seen.get(value.id);
    if (firstIndex === undefined) {
      seen.set(value.id, index);
      return;
    }

    diagnostics.push({
      code: "GRAPH_SEMANTIC_DUPLICATE_ID",
      message: `Duplicate ${namespace} id '${value.id}' was already declared at index ${firstIndex}.`,
      path: `/${namespace}/${index}/id`,
      ...(namespace === "nodes" ? { nodeId: value.id } : {}),
      ...(namespace === "edges" ? { edgeId: value.id } : {}),
      ...(namespace === "entrypoints" ? { entrypointId: value.id } : {}),
      ...(namespace === "inputs" || namespace === "outputs" ? { graphPortId: value.id } : {}),
    });
  });
}

/**
 * Return structured diagnostics for the frozen 2.6-2.7 semantic stage.
 *
 * This pass owns only ID uniqueness, exact node resolution, static graph/port
 * references, non-edge binding references, and input cardinality. It remains
 * read-only and does not absorb compatibility, control, topology, policy, or
 * secret-only rules from later stages.
 */
export function checkGraphJsonV1Semantics(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): GraphSemanticValidationResult {
  const diagnostics: GraphSemanticDiagnostic[] = [];

  collectDuplicateIds(graph.inputs, "inputs", diagnostics);
  collectDuplicateIds(graph.outputs, "outputs", diagnostics);
  collectDuplicateIds(graph.nodes, "nodes", diagnostics);
  collectDuplicateIds(graph.edges, "edges", diagnostics);
  collectDuplicateIds(graph.entrypoints, "entrypoints", diagnostics);

  const manifestsByNodeId = new Map<string, NodeManifest>();
  const nodeIndexById = new Map<string, number>();

  graph.nodes.forEach((node, index) => {
    if (!nodeIndexById.has(node.id)) {
      nodeIndexById.set(node.id, index);
    }

    const manifest = resolver.getManifest(node.type, node.version);
    if (manifest === undefined) {
      diagnostics.push({
        code: "GRAPH_NODE_MANIFEST_UNRESOLVED",
        message: `Node '${node.id}' does not resolve exact manifest '${node.type}@${node.version}'.`,
        path: `/nodes/${index}`,
        nodeId: node.id,
      });
      return;
    }

    if (!manifestsByNodeId.has(node.id)) {
      manifestsByNodeId.set(node.id, manifest);
    }
  });

  const graphInputIds = new Set(graph.inputs.map((input) => input.id));
  const entrypointIds = new Set(graph.entrypoints.map((entrypoint) => entrypoint.id));
  const inputSourceCounts = new Map<string, Map<string, number>>();

  graph.outputs.forEach((output, index) => {
    const manifest = manifestsByNodeId.get(output.source.nodeId);
    if (manifest === undefined) {
      diagnostics.push({
        code: "GRAPH_REFERENCE_UNRESOLVED",
        message: `Graph output '${output.id}' references unknown node '${output.source.nodeId}'.`,
        path: `/outputs/${index}/source/nodeId`,
        nodeId: output.source.nodeId,
        graphPortId: output.id,
      });
      return;
    }

    if (!hasOwnPort(manifest.outputs, output.source.port)) {
      diagnostics.push({
        code: "GRAPH_PORT_UNKNOWN",
        message: `Graph output '${output.id}' references unknown output port '${output.source.port}' on node '${output.source.nodeId}'.`,
        path: `/outputs/${index}/source/port`,
        nodeId: output.source.nodeId,
        graphPortId: output.id,
        port: output.source.port,
      });
    }
  });

  graph.nodes.forEach((node, nodeIndex) => {
    const manifest = manifestsByNodeId.get(node.id);

    (node.bindings ?? []).forEach((binding, bindingIndex) => {
      if (manifest === undefined) {
        return;
      }

      if (!hasOwnPort(manifest.inputs, binding.port)) {
        diagnostics.push({
          code: "GRAPH_PORT_UNKNOWN",
          message: `Binding on node '${node.id}' targets unknown input port '${binding.port}'.`,
          path: `/nodes/${nodeIndex}/bindings/${bindingIndex}/port`,
          nodeId: node.id,
          port: binding.port,
        });
        return;
      }

      addInputSource(inputSourceCounts, node.id, binding.port);

      if (binding.kind === "graph-input" && !graphInputIds.has(binding.input)) {
        diagnostics.push({
          code: "GRAPH_REFERENCE_UNRESOLVED",
          message: `Binding on node '${node.id}.${binding.port}' references unknown graph input '${binding.input}'.`,
          path: `/nodes/${nodeIndex}/bindings/${bindingIndex}/input`,
          nodeId: node.id,
          graphPortId: binding.input,
          port: binding.port,
        });
      }
    });
  });

  graph.edges.forEach((edge, edgeIndex) => {
    const sourceManifest = manifestsByNodeId.get(edge.from.nodeId);
    const targetManifest = manifestsByNodeId.get(edge.to.nodeId);

    if (sourceManifest === undefined) {
      diagnostics.push({
        code: "GRAPH_REFERENCE_UNRESOLVED",
        message: `Edge '${edge.id}' references unknown source node '${edge.from.nodeId}'.`,
        path: `/edges/${edgeIndex}/from/nodeId`,
        edgeId: edge.id,
        nodeId: edge.from.nodeId,
      });
    }

    if (targetManifest === undefined) {
      diagnostics.push({
        code: "GRAPH_REFERENCE_UNRESOLVED",
        message: `Edge '${edge.id}' references unknown target node '${edge.to.nodeId}'.`,
        path: `/edges/${edgeIndex}/to/nodeId`,
        edgeId: edge.id,
        nodeId: edge.to.nodeId,
      });
    }

    if (edge.kind === "control") {
      return;
    }

    if (sourceManifest !== undefined && !hasOwnPort(sourceManifest.outputs, edge.from.port)) {
      diagnostics.push({
        code: "GRAPH_PORT_UNKNOWN",
        message: `Data edge '${edge.id}' references unknown source output port '${edge.from.port}'.`,
        path: `/edges/${edgeIndex}/from/port`,
        edgeId: edge.id,
        nodeId: edge.from.nodeId,
        port: edge.from.port,
      });
    }

    if (targetManifest !== undefined) {
      if (!hasOwnPort(targetManifest.inputs, edge.to.port)) {
        diagnostics.push({
          code: "GRAPH_PORT_UNKNOWN",
          message: `Data edge '${edge.id}' references unknown target input port '${edge.to.port}'.`,
          path: `/edges/${edgeIndex}/to/port`,
          edgeId: edge.id,
          nodeId: edge.to.nodeId,
          port: edge.to.port,
        });
      } else {
        addInputSource(inputSourceCounts, edge.to.nodeId, edge.to.port);
      }
    }
  });

  graph.entrypoints.forEach((entrypoint, index) => {
    if (!manifestsByNodeId.has(entrypoint.nodeId)) {
      diagnostics.push({
        code: "GRAPH_REFERENCE_UNRESOLVED",
        message: `Entrypoint '${entrypoint.id}' references unknown node '${entrypoint.nodeId}'.`,
        path: `/entrypoints/${index}/nodeId`,
        entrypointId: entrypoint.id,
        nodeId: entrypoint.nodeId,
      });
    }
  });

  if (
    graph.options?.defaultEntrypoint !== undefined &&
    !entrypointIds.has(graph.options.defaultEntrypoint)
  ) {
    diagnostics.push({
      code: "GRAPH_REFERENCE_UNRESOLVED",
      message: `Default entrypoint '${graph.options.defaultEntrypoint}' does not exist.`,
      path: "/options/defaultEntrypoint",
      entrypointId: graph.options.defaultEntrypoint,
    });
  }

  for (const [nodeId, manifest] of manifestsByNodeId) {
    const nodeIndex = nodeIndexById.get(nodeId);
    if (nodeIndex === undefined) {
      continue;
    }

    const nodeCounts = inputSourceCounts.get(nodeId);

    for (const [portName, port] of Object.entries(manifest.inputs)) {
      const sourceCount = nodeCounts?.get(portName) ?? 0;

      if (port.required === true && sourceCount === 0) {
        diagnostics.push({
          code: "GRAPH_INPUT_REQUIRED",
          message: `Node '${nodeId}' required input '${portName}' has no source.`,
          path: `/nodes/${nodeIndex}`,
          nodeId,
          port: portName,
        });
      }

      if (port.multiple !== true && sourceCount > 1) {
        diagnostics.push({
          code: "GRAPH_INPUT_CARDINALITY_EXCEEDED",
          message: `Node '${nodeId}' input '${portName}' accepts one source but has ${sourceCount}.`,
          path: `/nodes/${nodeIndex}`,
          nodeId,
          port: portName,
        });
      }
    }
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

/**
 * Validate the currently frozen Graph JSON v1 Harness semantics.
 *
 * This boolean API is preserved for existing callers; 2.16 adds the structured
 * `checkGraphJsonV1Semantics` result without changing 2.6-2.7 meaning.
 */
export function validateGraphJsonV1Semantics(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): boolean {
  return checkGraphJsonV1Semantics(graph, resolver).valid;
}
