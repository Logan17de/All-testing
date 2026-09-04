import type { GraphJsonV1 } from "./graph-json-v1.js";

export type GraphAcyclicityDiagnosticCode =
  | "GRAPH_ACYCLICITY_PREREQUISITE_FAILED"
  | "GRAPH_CYCLE_DETECTED";

export interface GraphAcyclicityDiagnostic {
  readonly code: GraphAcyclicityDiagnosticCode;
  readonly message: string;
  readonly nodeIds?: readonly string[];
  readonly edgeIds?: readonly string[];
}

export interface GraphAcyclicityResult {
  readonly valid: boolean;
  readonly diagnostics: readonly GraphAcyclicityDiagnostic[];
}

function buildAdjacency(graph: GraphJsonV1): {
  readonly forward: ReadonlyMap<string, readonly string[]>;
  readonly reverse: ReadonlyMap<string, readonly string[]>;
} {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();

  for (const node of graph.nodes) {
    forward.set(node.id, []);
    reverse.set(node.id, []);
  }

  for (const edge of graph.edges) {
    forward.get(edge.from.nodeId)?.push(edge.to.nodeId);
    reverse.get(edge.to.nodeId)?.push(edge.from.nodeId);
  }

  return { forward, reverse };
}

function collectFinishOrder(
  graph: GraphJsonV1,
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[] {
  const visited = new Set<string>();
  const finishOrder: string[] = [];

  for (const node of graph.nodes) {
    if (visited.has(node.id)) {
      continue;
    }

    const stack: Array<{ readonly nodeId: string; readonly expanded: boolean }> = [
      { nodeId: node.id, expanded: false },
    ];

    while (stack.length > 0) {
      const current = stack.pop()!;

      if (current.expanded) {
        finishOrder.push(current.nodeId);
        continue;
      }

      if (visited.has(current.nodeId)) {
        continue;
      }

      visited.add(current.nodeId);
      stack.push({ nodeId: current.nodeId, expanded: true });

      const neighbors = adjacency.get(current.nodeId) ?? [];
      for (let index = neighbors.length - 1; index >= 0; index -= 1) {
        const neighbor = neighbors[index]!;
        if (!visited.has(neighbor)) {
          stack.push({ nodeId: neighbor, expanded: false });
        }
      }
    }
  }

  return finishOrder;
}

function collectStronglyConnectedComponents(
  graph: GraphJsonV1,
  forward: ReadonlyMap<string, readonly string[]>,
  reverse: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const finishOrder = collectFinishOrder(graph, forward);
  const assigned = new Set<string>();
  const components: string[][] = [];

  for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
    const startNodeId = finishOrder[index]!;
    if (assigned.has(startNodeId)) {
      continue;
    }

    const component: string[] = [];
    const stack = [startNodeId];
    assigned.add(startNodeId);

    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      component.push(nodeId);

      const neighbors = reverse.get(nodeId) ?? [];
      for (let neighborIndex = neighbors.length - 1; neighborIndex >= 0; neighborIndex -= 1) {
        const neighbor = neighbors[neighborIndex]!;
        if (!assigned.has(neighbor)) {
          assigned.add(neighbor);
          stack.push(neighbor);
        }
      }
    }

    components.push(component);
  }

  return components;
}

/**
 * Run the narrow 2.10 acyclicity stage.
 *
 * Every data edge and control edge is a directed executable dependency here.
 * Any strongly connected component containing more than one node is rejected,
 * as is a one-node component containing a self-loop. No control-port name,
 * node family, or future loop marker grants an exception in the initial v1
 * executable graph. Structured control contracts and bounded loop execution
 * belong to later items and must not be inferred here.
 *
 * Callers should run 2.6-2.9 first. Missing node references are reported only
 * as prerequisite failures rather than duplicating earlier semantic checks.
 */
export function checkGraphJsonV1Acyclicity(graph: GraphJsonV1): GraphAcyclicityResult {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const prerequisiteDiagnostics: GraphAcyclicityDiagnostic[] = [];

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from.nodeId) || !nodeIds.has(edge.to.nodeId)) {
      prerequisiteDiagnostics.push({
        code: "GRAPH_ACYCLICITY_PREREQUISITE_FAILED",
        message: `Edge '${edge.id}' references a missing node; 2.6-2.9 must succeed before 2.10.`,
        edgeIds: [edge.id],
      });
    }
  }

  if (prerequisiteDiagnostics.length > 0) {
    return { valid: false, diagnostics: prerequisiteDiagnostics };
  }

  const { forward, reverse } = buildAdjacency(graph);
  const components = collectStronglyConnectedComponents(graph, forward, reverse);
  const nodeOrder = new Map(graph.nodes.map((node, index) => [node.id, index] as const));
  const diagnostics: GraphAcyclicityDiagnostic[] = [];

  const cyclicComponents = components
    .filter((component) => {
      if (component.length > 1) {
        return true;
      }

      const nodeId = component[0]!;
      return graph.edges.some(
        (edge) => edge.from.nodeId === nodeId && edge.to.nodeId === nodeId,
      );
    })
    .map((component) =>
      [...component].sort((left, right) => nodeOrder.get(left)! - nodeOrder.get(right)!),
    )
    .sort((left, right) => nodeOrder.get(left[0]!)! - nodeOrder.get(right[0]!)!);

  for (const component of cyclicComponents) {
    const componentSet = new Set(component);
    const edgeIds = graph.edges
      .filter(
        (edge) => componentSet.has(edge.from.nodeId) && componentSet.has(edge.to.nodeId),
      )
      .map((edge) => edge.id);

    diagnostics.push({
      code: "GRAPH_CYCLE_DETECTED",
      message: `Executable graph cycle detected across node(s): ${component.join(", ")}. Arbitrary cycles are not executable in Harness v1.`,
      nodeIds: component,
      edgeIds,
    });
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

/** Boolean convenience wrapper for the separate 2.10 acyclicity stage. */
export function validateGraphJsonV1Acyclicity(graph: GraphJsonV1): boolean {
  return checkGraphJsonV1Acyclicity(graph).valid;
}
