import type { NodeManifest } from "@zet-harness/plugin-api";

import type { GraphJsonV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

export type GraphSecretBindingDiagnosticCode =
  "GRAPH_SECRET_BINDING_PREREQUISITE_FAILED" | "GRAPH_SECRET_REFERENCE_REQUIRED";

export type GraphSecretBindingSourceKind = "literal" | "graph-input" | "data-edge";

export interface GraphSecretBindingDiagnostic {
  readonly code: GraphSecretBindingDiagnosticCode;
  readonly message: string;
  readonly nodeId: string;
  readonly port?: string;
  readonly sourceKind?: GraphSecretBindingSourceKind;
  readonly edgeId?: string;
}

export interface GraphSecretBindingResult {
  readonly valid: boolean;
  readonly diagnostics: readonly GraphSecretBindingDiagnostic[];
}

function hasOwnPort(ports: Readonly<Record<string, unknown>>, port: string): boolean {
  return Object.prototype.hasOwnProperty.call(ports, port);
}

function isSecretOnlyInput(manifest: NodeManifest, port: string): boolean {
  return hasOwnPort(manifest.inputs, port) && manifest.inputs[port]?.secret === true;
}

/**
 * Run the narrow 2.15 secret-only input binding stage.
 *
 * A manifest input marked `secret: true` may receive only an opaque `secret`
 * binding. Literal values, public graph-input forwarding, and node data edges
 * are rejected for that port. This pass never inspects values to guess whether
 * something "looks secret", never resolves a secret reference, and never emits
 * literal values or secret references in diagnostics.
 *
 * This stage is fail-closed only for declared secret-only destinations; it does
 * not broaden scope by classifying ordinary input values as secret material.
 * Required-input/cardinality checks remain owned by 2.7. Secret provider
 * existence, authorization, and resolution remain runtime security concerns.
 */
export function checkGraphJsonV1SecretBindings(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): GraphSecretBindingResult {
  const diagnostics: GraphSecretBindingDiagnostic[] = [];
  const manifestsByNodeId = new Map<string, NodeManifest>();

  for (const node of graph.nodes) {
    const manifest = resolver.getManifest(node.type, node.version);

    if (manifest === undefined) {
      diagnostics.push({
        code: "GRAPH_SECRET_BINDING_PREREQUISITE_FAILED",
        message: `Node '${node.id}' must resolve before 2.15 secret-only binding validation.`,
        nodeId: node.id,
      });
      continue;
    }

    manifestsByNodeId.set(node.id, manifest);

    for (const binding of node.bindings ?? []) {
      if (!isSecretOnlyInput(manifest, binding.port) || binding.kind === "secret") {
        continue;
      }

      const sourceKind: GraphSecretBindingSourceKind = binding.kind;
      diagnostics.push({
        code: "GRAPH_SECRET_REFERENCE_REQUIRED",
        message: `Node '${node.id}' input '${binding.port}' is secret-only and must use an opaque secret reference rather than a ${sourceKind} source.`,
        nodeId: node.id,
        port: binding.port,
        sourceKind,
      });
    }
  }

  for (const edge of graph.edges) {
    if (edge.kind !== "data") {
      continue;
    }

    const targetManifest = manifestsByNodeId.get(edge.to.nodeId);
    if (targetManifest === undefined || !isSecretOnlyInput(targetManifest, edge.to.port)) {
      continue;
    }

    diagnostics.push({
      code: "GRAPH_SECRET_REFERENCE_REQUIRED",
      message: `Node '${edge.to.nodeId}' input '${edge.to.port}' is secret-only and cannot receive a node data edge; use an opaque secret reference binding.`,
      nodeId: edge.to.nodeId,
      port: edge.to.port,
      sourceKind: "data-edge",
      edgeId: edge.id,
    });
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

/** Boolean convenience wrapper for the separate 2.15 secret-binding stage. */
export function validateGraphJsonV1SecretBindings(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): boolean {
  return checkGraphJsonV1SecretBindings(graph, resolver).valid;
}
