import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import {
  RunControlEdges,
  type ControlEdgeRuntimeStatus,
  type RunControlEdgesSnapshot,
} from "./control-edge-state.js";
import { RunJoinActivation } from "./join-activation.js";
import type { RunOpStatus } from "./op-status.js";
import { RunReadiness } from "./run-readiness.js";
import { RunRouterActivation, type RouterBranchSelection } from "./router-activation.js";

/** Routers and joins are scheduler-owned control ops a run resolves itself. */
export function isStructuredControlOp(op: ExecutionIrOpV1): boolean {
  return op.control?.kind === "router" || op.control?.kind === "join";
}

export function hasStructuredControl(ir: ExecutionIrV1): boolean {
  return ir.ops.some(isStructuredControlOp);
}

/** Committed control truth needed to resume a run with routers or joins. */
export interface StructuredControlRestore {
  readonly controlEdges: readonly ControlEdgeRuntimeStatus[];
  readonly routerSelections: readonly RouterBranchSelection[];
}

export interface StructuredControlSnapshot {
  readonly controlEdges: RunControlEdgesSnapshot;
  readonly routerSelections: readonly RouterBranchSelection[];
}

/**
 * Router, join and skip semantics over one run's readiness.
 *
 * The live scheduler and durable hosts share this class, so a branch taken, a
 * join released or a path skipped is decided by the same code whether it happens
 * in memory or inside a commit.
 */
export class RunStructuredControl {
  private readonly ir: ExecutionIrV1;
  private readonly readiness: RunReadiness;
  private readonly controlEdges: RunControlEdges;
  private readonly routers: RunRouterActivation;
  private readonly joins: RunJoinActivation;

  constructor(ir: ExecutionIrV1, readiness: RunReadiness, restored?: StructuredControlRestore) {
    this.ir = ir;
    this.readiness = readiness;
    this.controlEdges = new RunControlEdges(ir);
    if (restored !== undefined) this.controlEdges.restore(restored.controlEdges);
    this.routers = new RunRouterActivation(ir, readiness, this.controlEdges);
    this.joins = new RunJoinActivation(ir, readiness, this.controlEdges);
    for (const selection of restored?.routerSelections ?? []) {
      this.routers.restoreSelection(selection.routerOp, selection.branch);
    }
  }

  /** Complete a dequeued router on its chosen branch, then settle the consequences. */
  activateReservedRouter(op: number, branch: string): void {
    this.routers.activateReservedRouter(op, branch);
    this.settle();
  }

  /** Complete a dequeued join whose gate is met, then settle the consequences. */
  completeReservedJoin(op: number): void {
    this.joins.completeReservedJoin(op);
    this.settle();
  }

  /** Release everything a completed ordinary op was holding back. */
  releaseCompletedOp(op: number, withheld: ReadonlySet<number> = new Set()): void {
    // A completed ordinary op is on the live path, so its outgoing control edges
    // finish with it. A join decides for itself when its control lanes are
    // satisfied, so those particular dependencies are left to reconciliation.
    const joinLanes = new Set<number>();
    for (const edgeIndex of this.controlEdges.getOutgoingEdgeIndexes(op)) {
      if (this.controlEdges.getState(edgeIndex).status === "unresolved") {
        this.controlEdges.activate(edgeIndex);
      }
      if (this.controlEdges.getState(edgeIndex).status === "active") {
        this.controlEdges.complete(edgeIndex);
      }
      const target = this.controlEdges.getEdge(edgeIndex).to.op;
      if (this.ir.ops[target]?.control?.kind === "join") joinLanes.add(target);
    }
    for (const targetOp of this.readiness.getDependents(op)) {
      if (!joinLanes.has(targetOp) && !withheld.has(targetOp)) {
        this.readiness.releaseDependency(op, targetOp);
      }
    }
    this.settle();
  }

  /**
   * Bring joins and inactive paths up to date after a control decision.
   *
   * An ordinary op is skipped when every control edge from one of its sources
   * was skipped, or when a source that feeds it data was skipped: either way it
   * can never run. Joins are reconciled against the same edge state, and both
   * repeat until nothing changes, so a skip cascades through the whole path.
   */
  settle(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (let op = 0; op < this.ir.ops.length; op += 1) {
        if (this.readiness.getOpState(op).status !== "pending") continue;
        const operation = this.ir.ops[op]!;

        if (operation.control?.kind === "join") {
          const reconciliation = this.joins.reconcileJoin(op);
          if (reconciliation.newlyReady || reconciliation.propagatedSkippedOps.length > 0) {
            changed = true;
          }
          continue;
        }

        const edgesBySource = new Map<number, number[]>();
        for (const edgeIndex of this.controlEdges.getIncomingEdgeIndexes(op)) {
          const source = this.controlEdges.getEdge(edgeIndex).from.op;
          edgesBySource.set(source, [...(edgesBySource.get(source) ?? []), edgeIndex]);
        }
        const controlStarved = [...edgesBySource.values()].some((edges) =>
          edges.every((edgeIndex) => this.controlEdges.getState(edgeIndex).status === "skipped"),
        );
        const dataStarved = operation.dependencies.some(
          (source) =>
            !edgesBySource.has(source) && this.readiness.getOpState(source).status === "skipped",
        );
        if (!controlStarved && !dataStarved) continue;

        this.readiness.skipPendingOp(op);
        for (const edgeIndex of this.controlEdges.getOutgoingEdgeIndexes(op)) {
          if (this.controlEdges.getState(edgeIndex).status === "unresolved") {
            this.controlEdges.skip(edgeIndex);
          }
        }
        changed = true;
      }
    }
  }

  /**
   * A loop op starts an iteration: control edges inside its body, and those
   * returning to it, start over, and its body edges become live.
   */
  beginLoopIteration(loopOp: number, region: ReadonlySet<number>, bodyPort: string): void {
    const reset: number[] = [];
    const bodyEdges: number[] = [];
    for (let edge = 0; edge < this.controlEdges.edgeCount; edge += 1) {
      const { from, to } = this.controlEdges.getEdge(edge);
      const fromBodyPort = from.op === loopOp && from.port === bodyPort;
      if (fromBodyPort) bodyEdges.push(edge);
      if (fromBodyPort || (region.has(from.op) && (region.has(to.op) || to.op === loopOp))) {
        reset.push(edge);
      }
    }
    this.controlEdges.resetForIteration(reset);
    for (const edge of bodyEdges) this.controlEdges.activate(edge);
  }

  /** A loop op completed: its body edges finish, and its other outgoing edges go live and finish. */
  finishLoop(loopOp: number, bodyPort: string): void {
    for (const edge of this.controlEdges.getOutgoingEdgeIndexes(loopOp)) {
      const port = this.controlEdges.getEdge(edge).from.port;
      if (port !== bodyPort && this.controlEdges.getState(edge).status === "unresolved") {
        this.controlEdges.activate(edge);
      }
      if (this.controlEdges.getState(edge).status === "active") this.controlEdges.complete(edge);
    }
    this.settle();
  }

  snapshot(): StructuredControlSnapshot {
    return Object.freeze({
      controlEdges: this.controlEdges.snapshot(),
      routerSelections: this.routers.snapshot().selections,
    });
  }
}

export interface StructuredControlFrontierState {
  readonly opStatuses: readonly RunOpStatus[];
  readonly remainingDependencies: readonly number[];
  readonly controlEdges: readonly ControlEdgeRuntimeStatus[];
  readonly routerSelections: readonly RouterBranchSelection[];
}

/**
 * Reconstruct which predecessor relations a committed frontier has satisfied.
 *
 * In a plain DAG a dependency is released exactly when its source completes.
 * Routers and joins break that: a router releases only the branch it chose, a
 * completed join releases its outputs, and a join releases all of its control
 * lanes together once its gate is met, including lanes whose sources were
 * skipped. These rules mirror those release points; whether a join's gate was
 * met is read from its committed remaining-dependency count.
 */
export function deriveReleasedDependencies(
  ir: ExecutionIrV1,
  state: StructuredControlFrontierState,
): readonly (readonly number[])[] {
  const branchByRouter = new Map(
    state.routerSelections.map((selection) => [selection.routerOp, selection.branch] as const),
  );
  const incoming = ir.ops.map(() => new Map<number, number[]>());
  ir.controlEdges.forEach((edge, edgeIndex) => {
    const bySource = incoming[edge.to.op];
    if (bySource === undefined) {
      throw new RangeError(`Control edge ${String(edgeIndex)} targets an unavailable op.`);
    }
    bySource.set(edge.from.op, [...(bySource.get(edge.from.op) ?? []), edgeIndex]);
  });

  return Object.freeze(
    ir.ops.map((target, targetOp) => {
      const bySource = incoming[targetOp]!;
      const targetIsJoin = target.control?.kind === "join";
      const released: number[] = [];
      const gatedLanes: number[] = [];

      for (const source of target.dependencies) {
        const completed = state.opStatuses[source] === "completed";
        const sourceKind = ir.ops[source]?.control?.kind;
        const edges = bySource.get(source);

        if (edges !== undefined && sourceKind === "router") {
          const branch = branchByRouter.get(source);
          const chosen = edges.some(
            (edgeIndex) => ir.controlEdges[edgeIndex]?.from.port === branch,
          );
          if (completed && chosen) released.push(source);
          else if (targetIsJoin) gatedLanes.push(source);
          continue;
        }
        if (edges !== undefined && targetIsJoin) {
          if (sourceKind === "join" && completed) released.push(source);
          else gatedLanes.push(source);
          continue;
        }
        if (completed) released.push(source);
      }

      if (gatedLanes.length > 0) {
        const gateMet =
          state.remainingDependencies[targetOp] ===
          target.dependencies.length - released.length - gatedLanes.length;
        if (gateMet) released.push(...gatedLanes);
      }
      return Object.freeze(released.sort((left, right) => left - right));
    }),
  );
}

export type StructuredControlAction =
  | { readonly kind: "complete"; readonly op: number }
  | { readonly kind: "select-branch"; readonly op: number; readonly branch: string }
  | { readonly kind: "complete-join"; readonly op: number };

/** One committed frontier, in the shape durable hosts already reconstruct. */
export interface StructuredControlFrontier {
  readonly ops: readonly { readonly status: string; readonly remainingDependencies: number }[];
  /** Ready op indexes in committed ready order. */
  readonly readyQueue: readonly number[];
  readonly controlEdges: readonly ControlEdgeRuntimeStatus[];
  readonly routerSelections: readonly RouterBranchSelection[];
}

export interface StructuredControlDelta {
  /** Ops whose status or remaining dependency count changed, by op index. */
  readonly ops: readonly {
    readonly op: number;
    readonly status: RunOpStatus;
    readonly remainingDependencies: number;
  }[];
  /** Ops that became ready, in the order the scheduler queued them. */
  readonly newlyReady: readonly number[];
  readonly controlEdges: readonly {
    readonly edge: number;
    readonly status: ControlEdgeRuntimeStatus;
  }[];
}

const CONTROL_PASSIVE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "ready",
  "completed",
  "skipped",
  "waiting",
  "retry-wait",
]);

/**
 * Apply one completion, branch choice or join completion to a committed frontier.
 *
 * Durable hosts call this inside the commit that records the transition, so the
 * readiness, skip and edge consequences land atomically with it and match what
 * the live scheduler computes for the same step.
 */
export function reduceStructuredControlFrontier(
  ir: ExecutionIrV1,
  frontier: StructuredControlFrontier,
  action: StructuredControlAction,
): StructuredControlDelta {
  const subject = frontier.ops[action.op];
  if (subject === undefined) {
    throw new RangeError(`Structured control op ${String(action.op)} is unavailable.`);
  }
  const allowed = action.kind === "complete" ? ["running", "waiting"] : ["ready"];
  if (!allowed.includes(subject.status)) {
    throw new TypeError(
      `Control transition '${action.kind}' conflicts with op ${String(action.op)} in '${subject.status}'.`,
    );
  }

  // Work in flight elsewhere is untouched by these transitions. It is presented
  // as retry-wait: unfinished, and holding no dependency of its own.
  const statuses = frontier.ops.map((state, op): RunOpStatus => {
    if (op === action.op) return "ready";
    if (state.status === "running" || state.status === "failed") return "retry-wait";
    if (!CONTROL_PASSIVE_STATUSES.has(state.status)) {
      throw new TypeError(
        `Op ${String(op)} in '${state.status}' cannot take part in a control transition.`,
      );
    }
    return state.status as RunOpStatus;
  });
  const remainingDependencies = frontier.ops.map((state) => state.remainingDependencies);
  const readiness = new RunReadiness(
    ir,
    {
      ops: statuses.map((status, op) => ({ op, status })),
      remainingDependencies,
      readyQueue: [action.op, ...frontier.readyQueue.filter((op) => op !== action.op)],
    },
    {
      releasedDependencies: deriveReleasedDependencies(ir, {
        opStatuses: frontier.ops.map((state, op) =>
          op === action.op ? "ready" : (state.status as RunOpStatus),
        ),
        remainingDependencies,
        controlEdges: frontier.controlEdges,
        routerSelections: frontier.routerSelections,
      }),
    },
  );
  const control = new RunStructuredControl(ir, readiness, {
    controlEdges: frontier.controlEdges,
    routerSelections: frontier.routerSelections,
  });
  const readyBefore = new Set(readiness.getReadyQueue());

  readiness.dequeueReadyOp();
  switch (action.kind) {
    case "complete":
      readiness.startReservedReadyOp(action.op);
      readiness.completeRunningOp(action.op);
      control.releaseCompletedOp(action.op);
      break;
    case "select-branch":
      control.activateReservedRouter(action.op, action.branch);
      break;
    case "complete-join":
      control.completeReservedJoin(action.op);
      break;
  }

  const after = readiness.snapshot();
  const ops = after.ops.flatMap((state, op) => {
    const remaining = after.remainingDependencies[op]!;
    const statusChanged = op === action.op || state.status !== statuses[op];
    if (!statusChanged && remaining === remainingDependencies[op]) return [];
    return [
      Object.freeze({
        op,
        status: statusChanged ? state.status : (frontier.ops[op]!.status as RunOpStatus),
        remainingDependencies: remaining,
      }),
    ];
  });
  const edgesAfter = control.snapshot().controlEdges.edges;
  const controlEdges = edgesAfter.flatMap((state) =>
    state.status === frontier.controlEdges[state.edge]
      ? []
      : [Object.freeze({ edge: state.edge, status: state.status })],
  );

  return Object.freeze({
    ops: Object.freeze(ops),
    newlyReady: Object.freeze(after.readyQueue.filter((op) => !readyBefore.has(op))),
    controlEdges: Object.freeze(controlEdges),
  });
}
