import type {
  NodeManifest,
  NodePortName,
  NodeStructuredControlContract,
} from "@zet-harness/plugin-api";

import type { GraphJsonV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

export type GraphStructuredControlDiagnosticCode =
  | "GRAPH_STRUCTURED_CONTROL_PREREQUISITE_FAILED"
  | "GRAPH_CONTROL_CONTRACT_INVALID"
  | "GRAPH_CONTROL_CONTRACT_BEHAVIOR_INVALID"
  | "GRAPH_CONTROL_PORT_REQUIRED"
  | "GRAPH_CONTROL_PORT_UNKNOWN"
  | "GRAPH_CONTROL_PORT_UNEXPECTED";

export interface GraphStructuredControlDiagnostic {
  readonly code: GraphStructuredControlDiagnosticCode;
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly entrypointId?: string;
  readonly port?: string;
  readonly direction?: "input" | "output";
}

export interface GraphStructuredControlResult {
  readonly valid: boolean;
  readonly diagnostics: readonly GraphStructuredControlDiagnostic[];
}

interface ResolvedControlPorts {
  readonly inputs: readonly NodePortName[];
  readonly outputs: readonly NodePortName[];
}

function resolveControlPorts(contract: NodeStructuredControlContract): ResolvedControlPorts {
  switch (contract.kind) {
    case "router":
      return { inputs: [contract.entry], outputs: contract.branches };
    case "join":
      return { inputs: contract.inputs, outputs: [contract.output] };
    case "loop":
      return {
        inputs: [contract.entry, contract.continue],
        outputs: [contract.body, contract.exit],
      };
    case "human-interrupt":
      return { inputs: [contract.entry], outputs: contract.outcomes };
    case "subgraph":
      return { inputs: [contract.entry], outputs: contract.exits };
  }
}

function hasValidControlContractShape(contract: NodeStructuredControlContract): boolean {
  const { inputs, outputs } = resolveControlPorts(contract);
  const names = [...inputs, ...outputs];

  if (inputs.length === 0 || outputs.length === 0) {
    return false;
  }

  if (names.some((name) => name.trim().length === 0)) {
    return false;
  }

  return new Set(names).size === names.length;
}

function hasValidBehavior(manifest: NodeManifest): boolean {
  if (manifest.control === undefined) {
    return true;
  }

  return manifest.control.kind === "human-interrupt"
    ? manifest.behavior.primitiveFamily === "interrupt"
    : manifest.behavior.primitiveFamily === "control";
}

function addPortDiagnostic(
  diagnostics: GraphStructuredControlDiagnostic[],
  options: {
    readonly manifest: NodeManifest;
    readonly nodeId: string;
    readonly port: string | undefined;
    readonly direction: "input" | "output";
    readonly edgeId?: string;
    readonly entrypointId?: string;
  },
): void {
  const { manifest, nodeId, port, direction, edgeId, entrypointId } = options;
  const contract = manifest.control;
  const location = {
    ...(edgeId === undefined ? {} : { edgeId }),
    ...(entrypointId === undefined ? {} : { entrypointId }),
  };

  if (contract === undefined) {
    if (port !== undefined) {
      diagnostics.push({
        code: "GRAPH_CONTROL_PORT_UNEXPECTED",
        message: `Node '${nodeId}' has no structured control contract, so named ${direction} control port '${port}' is not meaningful.`,
        nodeId,
        ...location,
        port,
        direction,
      });
    }
    return;
  }

  if (port === undefined) {
    diagnostics.push({
      code: "GRAPH_CONTROL_PORT_REQUIRED",
      message: `Structured ${contract.kind} node '${nodeId}' requires an explicit ${direction} control port.`,
      nodeId,
      ...location,
      direction,
    });
    return;
  }

  const controlPorts = resolveControlPorts(contract);
  const allowed = direction === "input" ? controlPorts.inputs : controlPorts.outputs;

  if (!allowed.includes(port)) {
    diagnostics.push({
      code: "GRAPH_CONTROL_PORT_UNKNOWN",
      message: `Control port '${port}' is not a declared ${direction} port of structured ${contract.kind} node '${nodeId}'.`,
      nodeId,
      ...location,
      port,
      direction,
    });
  }
}

/**
 * Run the narrow 2.11 structured-control contract stage.
 *
 * This pass gives named control ports an explicit compiler-readable meaning.
 * Structured nodes declare one static manifest contract: router, join, loop,
 * human-interrupt, or subgraph. Ordinary nodes may still use unported control
 * edges for simple ordering/activation, but arbitrary named ports are rejected.
 *
 * This is reservation/validation only. It does not select router branches,
 * implement joins, execute loops, suspend for humans, invoke subgraphs, or lower
 * any of those constructs into IR. 2.10 continues to reject all graph SCCs,
 * including graphs containing a node with a `loop` contract.
 */
export function checkGraphJsonV1StructuredControl(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): GraphStructuredControlResult {
  const manifests = new Map<string, NodeManifest>();
  const diagnostics: GraphStructuredControlDiagnostic[] = [];

  for (const node of graph.nodes) {
    const manifest = resolver.getManifest(node.type, node.version);
    if (manifest === undefined) {
      diagnostics.push({
        code: "GRAPH_STRUCTURED_CONTROL_PREREQUISITE_FAILED",
        message: `Node '${node.id}' must resolve before 2.11 structured-control validation.`,
        nodeId: node.id,
      });
      continue;
    }

    manifests.set(node.id, manifest);

    if (manifest.control !== undefined && !hasValidControlContractShape(manifest.control)) {
      diagnostics.push({
        code: "GRAPH_CONTROL_CONTRACT_INVALID",
        message: `Structured ${manifest.control.kind} contract on node '${node.id}' must declare non-empty, unique control port names in both directions.`,
        nodeId: node.id,
      });
    }

    if (!hasValidBehavior(manifest)) {
      diagnostics.push({
        code: "GRAPH_CONTROL_CONTRACT_BEHAVIOR_INVALID",
        message:
          manifest.control?.kind === "human-interrupt"
            ? `Human-interrupt node '${node.id}' must use primitiveFamily 'interrupt'.`
            : `Structured control node '${node.id}' must use primitiveFamily 'control'.`,
        nodeId: node.id,
      });
    }
  }

  if (
    diagnostics.some(
      (diagnostic) => diagnostic.code === "GRAPH_STRUCTURED_CONTROL_PREREQUISITE_FAILED",
    )
  ) {
    return { valid: false, diagnostics };
  }

  for (const edge of graph.edges) {
    if (edge.kind !== "control") {
      continue;
    }

    const sourceManifest = manifests.get(edge.from.nodeId);
    const targetManifest = manifests.get(edge.to.nodeId);

    if (sourceManifest === undefined || targetManifest === undefined) {
      diagnostics.push({
        code: "GRAPH_STRUCTURED_CONTROL_PREREQUISITE_FAILED",
        message: `Control edge '${edge.id}' references an unresolved node; 2.6-2.10 must succeed before 2.11.`,
        edgeId: edge.id,
      });
      continue;
    }

    addPortDiagnostic(diagnostics, {
      manifest: sourceManifest,
      nodeId: edge.from.nodeId,
      port: edge.from.port,
      direction: "output",
      edgeId: edge.id,
    });
    addPortDiagnostic(diagnostics, {
      manifest: targetManifest,
      nodeId: edge.to.nodeId,
      port: edge.to.port,
      direction: "input",
      edgeId: edge.id,
    });
  }

  for (const entrypoint of graph.entrypoints) {
    const manifest = manifests.get(entrypoint.nodeId);
    if (manifest === undefined) {
      diagnostics.push({
        code: "GRAPH_STRUCTURED_CONTROL_PREREQUISITE_FAILED",
        message: `Entrypoint '${entrypoint.id}' references an unresolved node; 2.6-2.10 must succeed before 2.11.`,
        nodeId: entrypoint.nodeId,
        entrypointId: entrypoint.id,
      });
      continue;
    }

    addPortDiagnostic(diagnostics, {
      manifest,
      nodeId: entrypoint.nodeId,
      port: entrypoint.port,
      direction: "input",
      entrypointId: entrypoint.id,
    });
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

/** Boolean convenience wrapper for the separate 2.11 structured-control stage. */
export function validateGraphJsonV1StructuredControl(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): boolean {
  return checkGraphJsonV1StructuredControl(graph, resolver).valid;
}
