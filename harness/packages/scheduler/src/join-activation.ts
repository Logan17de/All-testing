import type { ExecutionIrJoinControlV1, ExecutionIrV1 } from "@zet-harness/graph";

import type { ControlEdgeRuntimeStatus, RunControlEdges } from "./control-edge-state.js";
import type { RunReadiness } from "./run-readiness.js";

export interface AllActiveJoinReconciliation {
  readonly joinOp: number;
  readonly ready: boolean;
  readonly newlyReady: boolean;
  readonly unresolvedInputEdges: readonly number[];
  readonly activeInputEdges: readonly number[];
  readonly completedInputEdges: readonly number[];
  readonly skippedInputEdges: readonly number[];
  readonly propagatedSkippedOps: readonly number[];
}

export interface AllActiveJoinCompletion {
  readonly joinOp: number;
  readonly activatedTargets: readonly number[];
  readonly newlyReadyTargets: readonly number[];
}

interface AllActiveJoinPlan {
  readonly incomingEdges: readonly number[];
  readonly incomingSources: readonly number[];
  readonly outgoingEdges: readonly number[];
  readonly outgoingTargets: readonly number[];
}

function assertOpIndex(op: number, opCount: number): void {
  if (!Number.isSafeInteger(op) || op < 0 || op >= opCount) {
    throw new RangeError(`Join op index ${String(op)} is outside [0, ${String(opCount)}).`);
  }
}

function frozenNumbers(items: Iterable<number>): readonly number[] {
  return Object.freeze([...items].sort((left, right) => left - right));
}

function getJoinControl(ir: ExecutionIrV1, joinOp: number): ExecutionIrJoinControlV1 {
  assertOpIndex(joinOp, ir.ops.length);
  const operation = ir.ops[joinOp];
  if (operation === undefined || operation.control?.kind !== "join") {
    throw new TypeError(`Run op ${String(joinOp)} is not a join.`);
  }
  return operation.control;
}

/**
 * Activation-aware runtime semantics for the initial `all-active` join mode.
 *
 * A join remains blocked while any candidate incoming control edge is unresolved
 * or active. Once every candidate edge is terminal, completed inputs participate
 * and skipped inputs are ignored. The join's deduplicated IR predecessor relation
 * is then released once per source op. This preserves the compact dependency
 * counter without treating an unselected router branch as unfinished forever.
 *
 * Reconciliation also propagates definitive skipped control paths through ordinary
 * unstarted ops. For a deduplicated source->target dependency, a target is inactive
 * only when every control edge from that same source op to the target is skipped.
 * This avoids incorrectly skipping a target that has multiple alternative router
 * edges from one predecessor and at least one selected edge.
 *
 * `any` and quorum semantics are deliberately absent until 3.8.
 */
export class RunAllActiveJoinActivation {
  private readonly joinPlans = new Map<number, AllActiveJoinPlan>();

  constructor(
    private readonly ir: ExecutionIrV1,
    private readonly readiness: RunReadiness,
    private readonly controlEdges: RunControlEdges,
  ) {
    if (readiness.opCount !== ir.ops.length) {
      throw new TypeError("Join activation readiness does not match the Execution IR op count.");
    }
    if (!controlEdges.isForIr(ir)) {
      throw new TypeError(
        "Join activation control-edge state does not belong to this Execution IR.",
      );
    }

    ir.ops.forEach((operation, joinOp) => {
      if (operation.control?.kind !== "join") {
        return;
      }
      if (operation.control.mode !== "all-active") {
        throw new TypeError(
          `Join op ${String(joinOp)} uses unsupported mode '${String(operation.control.mode)}'.`,
        );
      }
      if (operation.behavior.executionMode !== "none") {
        throw new TypeError(
          `Join op ${String(joinOp)} must be scheduler-owned with executionMode 'none'.`,
        );
      }

      const incomingEdges = controlEdges.getIncomingEdgeIndexes(joinOp);
      const incomingSources = new Set<number>();
      for (const edgeIndex of incomingEdges) {
        const edge = controlEdges.getEdge(edgeIndex);
        const port = edge.to.port;
        if (port === undefined || !operation.control.inputs.includes(port)) {
          throw new TypeError(
            `Join op ${String(joinOp)} has an incoming control edge without a declared input port.`,
          );
        }
        if (!operation.dependencies.includes(edge.from.op)) {
          throw new TypeError(
            `Join control edge ${String(edge.from.op)} -> ${String(joinOp)} is missing its IR dependency.`,
          );
        }
        incomingSources.add(edge.from.op);
      }

      const outgoingEdges = controlEdges.getOutgoingEdgeIndexes(joinOp);
      const outgoingTargets = new Set<number>();
      for (const edgeIndex of outgoingEdges) {
        const edge = controlEdges.getEdge(edgeIndex);
        if (edge.from.port !== operation.control.output) {
          throw new TypeError(
            `Join op ${String(joinOp)} has an outgoing control edge without declared output port '${operation.control.output}'.`,
          );
        }
        const targetOperation = ir.ops[edge.to.op];
        if (targetOperation === undefined || !targetOperation.dependencies.includes(joinOp)) {
          throw new TypeError(
            `Join control edge ${String(joinOp)} -> ${String(edge.to.op)} is missing its IR dependency.`,
          );
        }
        outgoingTargets.add(edge.to.op);
      }

      this.joinPlans.set(
        joinOp,
        Object.freeze({
          incomingEdges: frozenNumbers(incomingEdges),
          incomingSources: frozenNumbers(incomingSources),
          outgoingEdges: frozenNumbers(outgoingEdges),
          outgoingTargets: frozenNumbers(outgoingTargets),
        }),
      );
    });
  }

  /** Reconcile one all-active join against current control-edge participation state. */
  reconcileJoin(joinOp: number): AllActiveJoinReconciliation {
    getJoinControl(this.ir, joinOp);
    const plan = this.getPlan(joinOp);
    const propagatedSkippedOps = this.propagateDefinitiveSkips();
    const edgeBuckets: Record<ControlEdgeRuntimeStatus, number[]> = {
      unresolved: [],
      active: [],
      skipped: [],
      completed: [],
    };

    for (const edgeIndex of plan.incomingEdges) {
      edgeBuckets[this.controlEdges.getState(edgeIndex).status].push(edgeIndex);
    }

    const controlGateSatisfied =
      edgeBuckets.unresolved.length === 0 && edgeBuckets.active.length === 0;
    let newlyReady = false;

    if (controlGateSatisfied) {
      for (const sourceOp of plan.incomingSources) {
        if (
          !this.readiness.isDependencyReleased(sourceOp, joinOp) &&
          this.readiness.releaseDependency(sourceOp, joinOp)
        ) {
          newlyReady = true;
        }
      }
    }

    return Object.freeze({
      joinOp,
      ready: controlGateSatisfied && this.readiness.getOpState(joinOp).status === "ready",
      newlyReady,
      unresolvedInputEdges: frozenNumbers(edgeBuckets.unresolved),
      activeInputEdges: frozenNumbers(edgeBuckets.active),
      completedInputEdges: frozenNumbers(edgeBuckets.completed),
      skippedInputEdges: frozenNumbers(edgeBuckets.skipped),
      propagatedSkippedOps,
    });
  }

  /**
   * Complete one dequeued scheduler-owned join after successful all-active reconciliation.
   * Outgoing join edges are activated/completed atomically in memory before their
   * deduplicated join->target readiness dependencies are released.
   */
  completeReservedJoin(joinOp: number): AllActiveJoinCompletion {
    getJoinControl(this.ir, joinOp);
    const plan = this.getPlan(joinOp);

    if (!this.readiness.isReadyOpReserved(joinOp)) {
      throw new TypeError(`Join op ${String(joinOp)} is not a dequeued ready reservation.`);
    }
    if (this.readiness.getOpState(joinOp).status !== "ready") {
      throw new TypeError(`Join op ${String(joinOp)} is not ready for completion.`);
    }

    for (const edgeIndex of plan.incomingEdges) {
      const status = this.controlEdges.getState(edgeIndex).status;
      if (status === "unresolved" || status === "active") {
        throw new TypeError(
          `Join op ${String(joinOp)} cannot complete while input edge ${String(edgeIndex)} is '${status}'.`,
        );
      }
    }
    for (const edgeIndex of plan.outgoingEdges) {
      const status = this.controlEdges.getState(edgeIndex).status;
      if (status !== "unresolved") {
        throw new TypeError(
          `Join op ${String(joinOp)} cannot resolve output edge ${String(edgeIndex)} from '${status}'.`,
        );
      }
    }
    for (const targetOp of plan.outgoingTargets) {
      if (this.readiness.isDependencyReleased(joinOp, targetOp)) {
        throw new TypeError(
          `Join dependency ${String(joinOp)} -> ${String(targetOp)} was already released before join completion.`,
        );
      }
    }

    for (const edgeIndex of plan.outgoingEdges) {
      this.controlEdges.activate(edgeIndex);
    }

    this.readiness.startReservedReadyOp(joinOp);
    this.readiness.completeRunningOp(joinOp);

    for (const edgeIndex of plan.outgoingEdges) {
      this.controlEdges.complete(edgeIndex);
    }

    const newlyReadyTargets: number[] = [];
    for (const targetOp of plan.outgoingTargets) {
      if (this.readiness.releaseDependency(joinOp, targetOp)) {
        newlyReadyTargets.push(targetOp);
      }
    }

    return Object.freeze({
      joinOp,
      activatedTargets: plan.outgoingTargets,
      newlyReadyTargets: Object.freeze(newlyReadyTargets),
    });
  }

  private getPlan(joinOp: number): AllActiveJoinPlan {
    const plan = this.joinPlans.get(joinOp);
    if (plan === undefined) {
      throw new TypeError(`Join op ${String(joinOp)} has no all-active runtime plan.`);
    }
    return plan;
  }

  /**
   * Resolve control-inactive ordinary paths to a fixed point so downstream joins
   * observe `skipped`, not permanently `unresolved`, edges.
   */
  private propagateDefinitiveSkips(): readonly number[] {
    const skippedOps: number[] = [];
    let changed = true;

    while (changed) {
      changed = false;

      for (let op = 0; op < this.ir.ops.length; op += 1) {
        const operation = this.ir.ops[op];
        if (operation === undefined || operation.control?.kind === "join") {
          continue;
        }

        const status = this.readiness.getOpState(op).status;
        if (status !== "pending" && status !== "ready") {
          continue;
        }

        const incomingEdges = this.controlEdges.getIncomingEdgeIndexes(op);
        if (incomingEdges.length === 0) {
          continue;
        }

        const incomingBySource = new Map<number, number[]>();
        for (const edgeIndex of incomingEdges) {
          const sourceOp = this.controlEdges.getEdge(edgeIndex).from.op;
          if (!operation.dependencies.includes(sourceOp)) {
            throw new TypeError(
              `Control edge ${String(sourceOp)} -> ${String(op)} is missing its IR dependency.`,
            );
          }
          const group = incomingBySource.get(sourceOp);
          if (group === undefined) {
            incomingBySource.set(sourceOp, [edgeIndex]);
          } else {
            group.push(edgeIndex);
          }
        }

        const hasDefinitivelySkippedSource = [...incomingBySource.values()].some((edgeIndexes) =>
          edgeIndexes.every(
            (edgeIndex) => this.controlEdges.getState(edgeIndex).status === "skipped",
          ),
        );
        if (!hasDefinitivelySkippedSource) {
          continue;
        }

        if (status !== "pending") {
          throw new TypeError(
            `Run op ${String(op)} became ready before its inactive control predecessor was resolved.`,
          );
        }

        const outgoingEdges = this.controlEdges.getOutgoingEdgeIndexes(op);
        for (const edgeIndex of outgoingEdges) {
          const edgeStatus = this.controlEdges.getState(edgeIndex).status;
          if (edgeStatus === "active" || edgeStatus === "completed") {
            throw new TypeError(
              `Run op ${String(op)} cannot become skipped after output edge ${String(edgeIndex)} became '${edgeStatus}'.`,
            );
          }
        }

        this.readiness.skipPendingOp(op);
        for (const edgeIndex of outgoingEdges) {
          if (this.controlEdges.getState(edgeIndex).status === "unresolved") {
            this.controlEdges.skip(edgeIndex);
          }
        }

        skippedOps.push(op);
        changed = true;
      }
    }

    return frozenNumbers(skippedOps);
  }
}
