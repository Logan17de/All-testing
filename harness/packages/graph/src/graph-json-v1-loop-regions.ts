import type { NodeLoopControlContract } from "@zet-harness/plugin-api";

import type { GraphEdgeV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

export type GraphLoopRegionDiagnosticCode =
  | "GRAPH_LOOP_REGION_INCOMPLETE"
  | "GRAPH_LOOP_BACK_EDGE_INVALID"
  | "GRAPH_LOOP_REGION_ESCAPE"
  | "GRAPH_LOOP_REGION_NESTED"
  | "GRAPH_LOOP_REGION_ENTRYPOINT";

export interface GraphLoopRegionDiagnostic {
  readonly code: GraphLoopRegionDiagnosticCode;
  readonly message: string;
  readonly nodeId: string;
  readonly edgeId?: string;
  readonly entrypointId?: string;
  readonly nodeIds?: readonly string[];
}

/** The parts of a graph region analysis reads; Graph JSON and canonical semantics both fit. */
export interface GraphLoopRegionSource {
  readonly nodes: readonly {
    readonly id: string;
    readonly type: string;
    readonly version: string;
  }[];
  readonly edges: readonly GraphEdgeV1[];
  readonly entrypoints: readonly { readonly id: string; readonly nodeId: string }[];
}

export interface GraphLoopRegion {
  readonly loopNodeId: string;
  readonly control: NodeLoopControlContract;
  /** Nodes that run once per iteration, in graph node order. */
  readonly regionNodeIds: readonly string[];
  /**
   * Edges from the body back into the loop node, in graph edge order. They wake the
   * loop and carry values into it, but never make the loop wait on its own body.
   */
  readonly backEdgeIds: readonly string[];
}

export interface GraphLoopRegionResult {
  readonly regions: readonly GraphLoopRegion[];
  readonly diagnostics: readonly GraphLoopRegionDiagnostic[];
}

/**
 * Find the body region of every structured loop node.
 *
 * A loop's body is everything reachable from control edges leaving its `body`
 * port, without passing back through the loop node and without entering work
 * that follows its `exit` port. The body closes the cycle through the loop's
 * `continue` port, and may also feed data inputs of the loop node.
 *
 * Rules enforced here, each with its own diagnostic:
 * - a loop needs at least one body edge and one continue edge;
 * - only body nodes may re-enter the loop, and only through `continue` or a data input;
 * - a body node may not reach work outside the loop, except that work after the
 *   loop exits may read a body value (the last iteration's) over a data edge;
 * - loops may not nest yet, and no entrypoint may start inside a body.
 *
 * Whether any other cycle remains is still decided by 2.10 acyclicity, which
 * ignores exactly the valid back edges returned here.
 */
export function findGraphJsonV1LoopRegions(
  graph: GraphLoopRegionSource,
  resolver: NodeManifestResolver,
): GraphLoopRegionResult {
  const loops = graph.nodes.flatMap((node) => {
    const control = resolver.getManifest(node.type, node.version)?.control;
    return control?.kind === "loop" ? [{ nodeId: node.id, control }] : [];
  });
  if (loops.length === 0) {
    return { regions: Object.freeze([]), diagnostics: Object.freeze([]) };
  }

  const nodeOrder = new Map(graph.nodes.map((node, index) => [node.id, index] as const));
  const outgoing = new Map<string, GraphEdgeV1[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.from.nodeId, [...(outgoing.get(edge.from.nodeId) ?? []), edge]);
  }
  const closure = (starts: readonly string[], blocked: ReadonlySet<string>): Set<string> => {
    const seen = new Set<string>();
    const stack = [...starts];
    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      if (seen.has(nodeId) || blocked.has(nodeId)) continue;
      seen.add(nodeId);
      for (const edge of outgoing.get(nodeId) ?? []) stack.push(edge.to.nodeId);
    }
    return seen;
  };
  const inNodeOrder = (ids: Iterable<string>): string[] =>
    [...ids].sort((left, right) => (nodeOrder.get(left) ?? 0) - (nodeOrder.get(right) ?? 0));

  const loopNodeIds = new Set(loops.map((loop) => loop.nodeId));
  const regions: GraphLoopRegion[] = [];
  const diagnostics: GraphLoopRegionDiagnostic[] = [];

  for (const { nodeId: loopNodeId, control } of loops) {
    const fromLoop = outgoing.get(loopNodeId) ?? [];
    const intoLoop = graph.edges.filter((edge) => edge.to.nodeId === loopNodeId);
    const bodyEdges = fromLoop.filter(
      (edge) => edge.kind === "control" && edge.from.port === control.body,
    );
    const exitEdges = fromLoop.filter(
      (edge) => edge.kind === "control" && edge.from.port === control.exit,
    );
    const continueEdges = intoLoop.filter(
      (edge) => edge.kind === "control" && edge.to.port === control.continue,
    );

    if (bodyEdges.length === 0 || continueEdges.length === 0) {
      diagnostics.push({
        code: "GRAPH_LOOP_REGION_INCOMPLETE",
        message: `Loop node '${loopNodeId}' needs a control edge out of its '${control.body}' port and one back into its '${control.continue}' port.`,
        nodeId: loopNodeId,
      });
      regions.push(
        Object.freeze({
          loopNodeId,
          control,
          regionNodeIds: Object.freeze([]),
          backEdgeIds: Object.freeze([]),
        }),
      );
      continue;
    }

    const after = closure(
      exitEdges.map((edge) => edge.to.nodeId),
      new Set([loopNodeId]),
    );
    const region = closure(
      bodyEdges.map((edge) => edge.to.nodeId),
      new Set([loopNodeId, ...after]),
    );

    for (const edge of bodyEdges) {
      if (!region.has(edge.to.nodeId)) {
        diagnostics.push({
          code: "GRAPH_LOOP_REGION_ESCAPE",
          message: `Body edge '${edge.id}' of loop node '${loopNodeId}' leads to work that runs after the loop exits.`,
          nodeId: loopNodeId,
          edgeId: edge.id,
        });
      }
    }

    const backEdgeIds: string[] = [];
    for (const edge of intoLoop) {
      const reentersContinue = edge.kind === "control" && edge.to.port === control.continue;
      if (region.has(edge.from.nodeId)) {
        if (reentersContinue || edge.kind === "data") {
          backEdgeIds.push(edge.id);
        } else {
          diagnostics.push({
            code: "GRAPH_LOOP_BACK_EDGE_INVALID",
            message: `Edge '${edge.id}' re-enters loop node '${loopNodeId}' from its body; a body may only return through the '${control.continue}' port or a data input.`,
            nodeId: loopNodeId,
            edgeId: edge.id,
          });
        }
      } else if (reentersContinue) {
        diagnostics.push({
          code: "GRAPH_LOOP_BACK_EDGE_INVALID",
          message: `Edge '${edge.id}' reaches the '${control.continue}' port of loop node '${loopNodeId}' from outside its body.`,
          nodeId: loopNodeId,
          edgeId: edge.id,
        });
      }
    }

    for (const regionNodeId of inNodeOrder(region)) {
      for (const edge of outgoing.get(regionNodeId) ?? []) {
        const target = edge.to.nodeId;
        if (target === loopNodeId || region.has(target)) continue;
        if (edge.kind === "data" && after.has(target)) continue;
        diagnostics.push({
          code: "GRAPH_LOOP_REGION_ESCAPE",
          message: `Edge '${edge.id}' leaves the body of loop node '${loopNodeId}' for '${target}'. Work outside a loop may only read a body value, over a data edge, after the loop exits.`,
          nodeId: regionNodeId,
          edgeId: edge.id,
          nodeIds: [loopNodeId],
        });
      }
      if (loopNodeIds.has(regionNodeId)) {
        diagnostics.push({
          code: "GRAPH_LOOP_REGION_NESTED",
          message: `Loop node '${regionNodeId}' sits inside the body of loop node '${loopNodeId}'; nested loops are not supported yet.`,
          nodeId: regionNodeId,
          nodeIds: [loopNodeId],
        });
      }
    }

    for (const entrypoint of graph.entrypoints) {
      if (region.has(entrypoint.nodeId)) {
        diagnostics.push({
          code: "GRAPH_LOOP_REGION_ENTRYPOINT",
          message: `Entrypoint '${entrypoint.id}' starts inside the body of loop node '${loopNodeId}'.`,
          nodeId: entrypoint.nodeId,
          entrypointId: entrypoint.id,
          nodeIds: [loopNodeId],
        });
      }
    }

    regions.push(
      Object.freeze({
        loopNodeId,
        control,
        regionNodeIds: Object.freeze(inNodeOrder(region)),
        backEdgeIds: Object.freeze(backEdgeIds),
      }),
    );
  }

  return { regions: Object.freeze(regions), diagnostics: Object.freeze(diagnostics) };
}
