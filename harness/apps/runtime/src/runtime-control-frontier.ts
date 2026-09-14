import type { StructuredControlDelta, StructuredControlFrontier } from "@zet-harness/scheduler";

import type {
  RecoveredControlEdgeFrontier,
  RecoveredExecutionFrontier,
  RecoveredOpFrontier,
} from "./runtime-recovery.js";

/** The committed frontier in the shape the shared control reducer reads. */
export function controlFrontierOf(frontier: RecoveredExecutionFrontier): StructuredControlFrontier {
  return {
    ops: frontier.ops,
    readyQueue: frontier.readyQueue.map((entry) => entry.opIndex),
    controlEdges: frontier.controlEdges.map((edge) => edge.status),
    routerSelections: frontier.routerSelections.map((selection) => ({
      routerOp: selection.routerOpIndex,
      branch: selection.branch,
    })),
  };
}

/**
 * Frontier op and edge states after one committed control transition.
 *
 * Newly ready ops take fresh ready orders after every order already committed,
 * in the order the scheduler queued them. The transition's own op keeps its
 * attempt accounting; callers record how that op finished.
 */
export function applyControlDelta(
  frontier: RecoveredExecutionFrontier,
  delta: StructuredControlDelta,
): {
  readonly ops: readonly RecoveredOpFrontier[];
  readonly controlEdges: readonly RecoveredControlEdgeFrontier[];
} {
  let order = frontier.ops.reduce((max, op) => Math.max(max, op.readyOrder ?? -1), -1) + 1;
  const readyOrder = new Map(delta.newlyReady.map((op) => [op, order++] as const));
  const opChanges = new Map(delta.ops.map((change) => [change.op, change] as const));
  const ops = frontier.ops.map((state): RecoveredOpFrontier => {
    const change = opChanges.get(state.opIndex);
    if (change === undefined) return state;
    return {
      ...state,
      status: change.status,
      remainingDependencies: change.remainingDependencies,
      readyOrder:
        change.status === "ready" ? (readyOrder.get(state.opIndex) ?? state.readyOrder) : null,
      retryNotBeforeMs: change.status === "retry-wait" ? state.retryNotBeforeMs : null,
    };
  });

  const edgeChanges = new Map(delta.controlEdges.map((change) => [change.edge, change] as const));
  const controlEdges = frontier.controlEdges.map((edge): RecoveredControlEdgeFrontier => {
    const change = edgeChanges.get(edge.edgeIndex);
    if (change === undefined || change.status === "unresolved") return edge;
    return { ...edge, status: change.status };
  });

  return { ops, controlEdges };
}
