import type { ExecutionIrJoinControlV1, ExecutionIrV1 } from "@zet-harness/graph";

import type { ControlEdgeRuntimeStatus, RunControlEdges } from "./control-edge-state.js";
import type { RunReadiness } from "./run-readiness.js";

export interface JoinReconciliation {
  readonly joinOp: number;
  readonly ready: boolean;
  readonly newlyReady: boolean;
  readonly unresolvedInputEdges: readonly number[];
  readonly activeInputEdges: readonly number[];
  readonly completedInputEdges: readonly number[];
  readonly skippedInputEdges: readonly number[];
  readonly propagatedSkippedOps: readonly number[];
}

export interface JoinCompletion {
  readonly joinOp: number;
  readonly activatedTargets: readonly number[];
  readonly newlyReadyTargets: readonly number[];
}

export type AllActiveJoinReconciliation = JoinReconciliation;
export type AllActiveJoinCompletion = JoinCompletion;

interface JoinInputLanePlan {
  readonly port: string;
  readonly edges: readonly number[];
}

interface JoinPlan {
  readonly control: ExecutionIrJoinControlV1;
  readonly incomingEdges: readonly number[];
  readonly incomingSources: readonly number[];
  readonly incomingLanes: readonly JoinInputLanePlan[];
  readonly outgoingEdges: readonly number[];
  readonly outgoingTargets: readonly number[];
}

type ThresholdLaneStatus = "completed" | "possible" | "skipped";

function assertOpIndex(op: number, opCount: number): void {
  if (!Number.isSafeInteger(op) || op < 0 || op >= opCount) {
    throw new RangeError(`Join op index ${String(op)} is outside [0, ${String(opCount)}).`);
  }
}

function frozenNumbers(items: Iterable<number>): readonly number[] {
  return Object.freeze([...new Set(items)].sort((left, right) => left - right));
}

function getJoinControl(ir: ExecutionIrV1, joinOp: number): ExecutionIrJoinControlV1 {
  assertOpIndex(joinOp, ir.ops.length);
  const operation = ir.ops[joinOp];
  if (operation === undefined || operation.control?.kind !== "join") {
    throw new TypeError(`Run op ${String(joinOp)} is not a join.`);
  }
  return operation.control;
}

function getThreshold(control: ExecutionIrJoinControlV1): number | undefined {
  switch (control.mode) {
    case "all-active":
      return undefined;
    case "any":
      return 1;
    case "quorum":
      return control.quorum;
  }
}

/**
 * Activation-aware runtime semantics for all supported join policies.
 *
 * `all-active` preserves 3.7 semantics: every candidate incoming control edge
 * must become terminal, completed inputs participate, and skipped inputs do not
 * block the join.
 *
 * `any` and `quorum` count distinct declared input lanes, not raw edge count.
 * A lane is completed when any edge targeting that lane completed. A lane remains
 * possible while it has an unresolved/active edge and no completed edge. Duplicate
 * edges into one lane can therefore never manufacture extra quorum votes.
 *
 * Threshold joins may release while other lanes are still active/unresolved. 3.8
 * deliberately does not cancel those losing branches; run cancellation belongs to
 * 3.9. If the remaining possible lanes cannot reach the threshold, the pending join
 * is skipped and that inactive result propagates downstream instead of deadlocking.
 */
export class RunJoinActivation {
  private readonly joinPlans = new Map<number, JoinPlan>();

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
      if (operation.behavior.executionMode !== "none") {
        throw new TypeError(
          `Join op ${String(joinOp)} must be scheduler-owned with executionMode 'none'.`,
        );
      }
      if (
        operation.control.inputs.length === 0 ||
        new Set(operation.control.inputs).size !== operation.control.inputs.length
      ) {
        throw new TypeError(`Join op ${String(joinOp)} must declare unique input lanes.`);
      }
      if (
        operation.control.mode === "quorum" &&
        (!Number.isSafeInteger(operation.control.quorum) ||
          operation.control.quorum < 1 ||
          operation.control.quorum > operation.control.inputs.length)
      ) {
        throw new TypeError(`Join op ${String(joinOp)} has an invalid quorum.`);
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

      const incomingLanes = operation.control.inputs.map((port) =>
        Object.freeze({
          port,
          edges: frozenNumbers(controlEdges.getIncomingEdgeIndexesForPort(joinOp, port)),
        }),
      );

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
          control: operation.control,
          incomingEdges: frozenNumbers(incomingEdges),
          incomingSources: frozenNumbers(incomingSources),
          incomingLanes: Object.freeze(incomingLanes),
          outgoingEdges: frozenNumbers(outgoingEdges),
          outgoingTargets: frozenNumbers(outgoingTargets),
        }),
      );
    });
  }

  /** Reconcile one join against current control-edge participation state. */
  reconcileJoin(joinOp: number): JoinReconciliation {
    getJoinControl(this.ir, joinOp);
    const plan = this.getPlan(joinOp);
    const propagatedSkippedOps = [...this.propagateDefinitiveSkips()];
    const edgeBuckets = this.bucketInputEdges(plan);
    let newlyReady = false;
    let controlGateSatisfied = false;

    if (plan.control.mode === "all-active") {
      controlGateSatisfied =
        edgeBuckets.unresolved.length === 0 && edgeBuckets.active.length === 0;
      if (controlGateSatisfied) {
        newlyReady = this.releaseIncomingSources(joinOp, plan);
      }
    } else {
      const threshold = getThreshold(plan.control);
      if (threshold === undefined) {
        throw new TypeError(`Join op ${String(joinOp)} has no threshold.`);
      }

      const laneStatuses = plan.incomingLanes.map((lane) => this.getThresholdLaneStatus(lane));
      const completedLaneCount = laneStatuses.filter((status) => status === "completed").length;
      const possibleLaneCount = laneStatuses.filter((status) => status === "possible").length;
      controlGateSatisfied = completedLaneCount >= threshold;

      if (controlGateSatisfied) {
        newlyReady = this.releaseIncomingSources(joinOp, plan);
      } else if (completedLaneCount + possibleLaneCount < threshold) {
        propagatedSkippedOps.push(...this.skipImpossibleJoin(joinOp, plan));
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
      propagatedSkippedOps: frozenNumbers(propagatedSkippedOps),
    });
  }

  /**
   * Complete one dequeued scheduler-owned join after its policy has been satisfied.
   * Outgoing join edges are activated/completed atomically in memory before their
   * deduplicated join->target readiness dependencies are released.
   */
  completeReservedJoin(joinOp: number): JoinCompletion {
    const control = getJoinControl(this.ir, joinOp);
    const plan = this.getPlan(joinOp);

    if (!this.readiness.isReadyOpReserved(joinOp)) {
      throw new TypeError(`Join op ${String(joinOp)} is not a dequeued ready reservation.`);
    }
    if (this.readiness.getOpState(joinOp).status !== "ready") {
      throw new TypeError(`Join op ${String(joinOp)} is not ready for completion.`);
    }

    if (control.mode === "all-active") {
      for (const edgeIndex of plan.incomingEdges) {
        const status = this.controlEdges.getState(edgeIndex).status;
        if (status === "unresolved" || status === "active") {
          throw new TypeError(
            `Join op ${String(joinOp)} cannot complete while input edge ${String(edgeIndex)} is '${status}'.`,
          );
        }
      }
    } else {
      const threshold = getThreshold(control);
      const completedLaneCount = plan.incomingLanes.filter(
        (lane) => this.getThresholdLaneStatus(lane) === "completed",
      ).length;
      if (threshold === undefined || completedLaneCount < threshold) {
        throw new TypeError(`Join op ${String(joinOp)} cannot complete before its threshold is met.`);
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

  private getPlan(joinOp: number): JoinPlan {
    const plan = this.joinPlans.get(joinOp);
    if (plan === undefined) {
      throw new TypeError(`Join op ${String(joinOp)} has no runtime plan.`);
    }
    return plan;
  }

  private bucketInputEdges(
    plan: JoinPlan,
  ): Readonly<Record<ControlEdgeRuntimeStatus, number[]>> {
    const buckets: Record<ControlEdgeRuntimeStatus, number[]> = {
      unresolved: [],
      active: [],
      skipped: [],
      completed: [],
    };

    for (const edgeIndex of plan.incomingEdges) {
      buckets[this.controlEdges.getState(edgeIndex).status].push(edgeIndex);
    }
    return buckets;
  }

  private getThresholdLaneStatus(lane: JoinInputLanePlan): ThresholdLaneStatus {
    const statuses = lane.edges.map((edgeIndex) => this.controlEdges.getState(edgeIndex).status);
    if (statuses.includes("completed")) {
      return "completed";
    }
    if (statuses.includes("unresolved") || statuses.includes("active")) {
      return "possible";
    }
    return "skipped";
  }

  private releaseIncomingSources(joinOp: number, plan: JoinPlan): boolean {
    let newlyReady = false;
    for (const sourceOp of plan.incomingSources) {
      if (
        !this.readiness.isDependencyReleased(sourceOp, joinOp) &&
        this.readiness.releaseDependency(sourceOp, joinOp)
      ) {
        newlyReady = true;
      }
    }
    return newlyReady;
  }

  private skipImpossibleJoin(joinOp: number, plan: JoinPlan): readonly number[] {
    const state = this.readiness.getOpState(joinOp).status;
    if (state === "skipped") {
      return this.propagateDefinitiveSkips();
    }
    if (state !== "pending") {
      throw new TypeError(
        `Join op ${String(joinOp)} became '${state}' before its threshold impossibility was resolved.`,
      );
    }

    for (const edgeIndex of plan.outgoingEdges) {
      const status = this.controlEdges.getState(edgeIndex).status;
      if (status === "active" || status === "completed") {
        throw new TypeError(
          `Join op ${String(joinOp)} cannot become skipped after output edge ${String(edgeIndex)} became '${status}'.`,
        );
      }
    }

    this.readiness.skipPendingOp(joinOp);
    for (const edgeIndex of plan.outgoingEdges) {
      if (this.controlEdges.getState(edgeIndex).status === "unresolved") {
        this.controlEdges.skip(edgeIndex);
      }
    }

    return frozenNumbers([joinOp, ...this.propagateDefinitiveSkips()]);
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

/** Backward-compatible 3.7 name; it now delegates to the general join runtime. */
export { RunJoinActivation as RunAllActiveJoinActivation };
