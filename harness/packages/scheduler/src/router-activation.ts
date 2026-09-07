import type { ExecutionIrRouterControlV1, ExecutionIrV1 } from "@zet-harness/graph";

import type { RunControlEdges } from "./control-edge-state.js";
import type { RunReadiness } from "./run-readiness.js";

export interface RouterBranchActivation {
  readonly routerOp: number;
  readonly branch: string;
  readonly activatedTargets: readonly number[];
  readonly newlyReadyTargets: readonly number[];
}

export interface RouterActivationSnapshot {
  readonly selections: readonly RouterBranchSelection[];
}

export interface RouterBranchSelection {
  readonly routerOp: number;
  readonly branch: string;
}

interface RouterBranchPlan {
  readonly edges: readonly number[];
  readonly targets: readonly number[];
}

function assertOpIndex(op: number, opCount: number): void {
  if (!Number.isSafeInteger(op) || op < 0 || op >= opCount) {
    throw new RangeError(`Router op index ${String(op)} is outside [0, ${String(opCount)}).`);
  }
}

function frozenNumbers(items: Iterable<number>): readonly number[] {
  return Object.freeze([...items].sort((left, right) => left - right));
}

function getRouterControl(ir: ExecutionIrV1, routerOp: number): ExecutionIrRouterControlV1 {
  assertOpIndex(routerOp, ir.ops.length);
  const operation = ir.ops[routerOp];
  if (operation === undefined || operation.control?.kind !== "router") {
    throw new TypeError(`Run op ${String(routerOp)} is not a router.`);
  }
  return operation.control;
}

/**
 * Run-local router selection over explicit 3.6 control-edge runtime state.
 *
 * A selected router output marks only its declared edges active; every other
 * outgoing router edge becomes skipped. Because the scheduler-owned router then
 * completes immediately, selected active edges also become completed before their
 * deduplicated router→target readiness dependencies are released. 3.7 can build
 * activation-aware joins over these stable skipped/completed outcomes.
 */
export class RunRouterActivation {
  private readonly branchPlans = new Map<number, ReadonlyMap<string, RouterBranchPlan>>();
  private readonly selections = new Map<number, string>();

  constructor(
    private readonly ir: ExecutionIrV1,
    private readonly readiness: RunReadiness,
    private readonly controlEdges: RunControlEdges,
  ) {
    if (readiness.opCount !== ir.ops.length) {
      throw new TypeError("Router activation readiness does not match the Execution IR op count.");
    }
    if (!controlEdges.isForIr(ir)) {
      throw new TypeError("Router activation control-edge state does not belong to this Execution IR.");
    }

    ir.ops.forEach((operation, routerOp) => {
      if (operation.control?.kind !== "router") {
        return;
      }
      if (operation.behavior.executionMode !== "none") {
        throw new TypeError(
          `Router op ${String(routerOp)} must be scheduler-owned with executionMode 'none'.`,
        );
      }

      const edgeIndexesByBranch = new Map<string, number[]>();
      const targetsByBranch = new Map<string, Set<number>>();
      for (const branch of operation.control.branches) {
        edgeIndexesByBranch.set(branch, []);
        targetsByBranch.set(branch, new Set<number>());
      }

      for (const edgeIndex of controlEdges.getOutgoingEdgeIndexes(routerOp)) {
        const edge = controlEdges.getEdge(edgeIndex);
        const branch = edge.from.port;
        if (branch === undefined || !targetsByBranch.has(branch)) {
          throw new TypeError(
            `Router op ${String(routerOp)} has an outgoing control edge without a declared branch port.`,
          );
        }

        const targetOperation = ir.ops[edge.to.op];
        if (targetOperation === undefined || !targetOperation.dependencies.includes(routerOp)) {
          throw new TypeError(
            `Router control edge ${String(routerOp)} -> ${String(edge.to.op)} is missing its IR dependency.`,
          );
        }

        edgeIndexesByBranch.get(branch)?.push(edgeIndex);
        targetsByBranch.get(branch)?.add(edge.to.op);
      }

      this.branchPlans.set(
        routerOp,
        new Map(
          operation.control.branches.map((branch) => [
            branch,
            Object.freeze({
              edges: frozenNumbers(edgeIndexesByBranch.get(branch) ?? []),
              targets: frozenNumbers(targetsByBranch.get(branch) ?? []),
            }),
          ]),
        ),
      );
    });
  }

  hasSelectedBranch(routerOp: number): boolean {
    getRouterControl(this.ir, routerOp);
    return this.selections.has(routerOp);
  }

  getSelectedBranch(routerOp: number): string | undefined {
    getRouterControl(this.ir, routerOp);
    return this.selections.get(routerOp);
  }

  /**
   * Complete one dequeued scheduler-owned router and resolve every outgoing edge.
   *
   * The caller owns branch choice. Unknown/repeated selection, already-resolved
   * edge state, or already-released dependency fails before this method mutates
   * the router lifecycle or control-edge state.
   */
  activateReservedRouter(routerOp: number, branch: string): RouterBranchActivation {
    const control = getRouterControl(this.ir, routerOp);
    if (!control.branches.includes(branch)) {
      throw new TypeError(
        `Router op ${String(routerOp)} cannot select undeclared branch '${branch}'.`,
      );
    }
    if (this.selections.has(routerOp)) {
      throw new TypeError(`Router op ${String(routerOp)} already selected a branch.`);
    }
    if (!this.readiness.isReadyOpReserved(routerOp)) {
      throw new TypeError(`Router op ${String(routerOp)} is not a dequeued ready reservation.`);
    }
    if (this.readiness.getOpState(routerOp).status !== "ready") {
      throw new TypeError(`Router op ${String(routerOp)} is not ready for activation.`);
    }

    const branchPlan = this.branchPlans.get(routerOp)?.get(branch);
    if (branchPlan === undefined) {
      throw new TypeError(`Router op ${String(routerOp)} has no runtime plan for branch '${branch}'.`);
    }

    const outgoingEdges = this.controlEdges.getOutgoingEdgeIndexes(routerOp);
    for (const edgeIndex of outgoingEdges) {
      const state = this.controlEdges.getState(edgeIndex);
      if (state.status !== "unresolved") {
        throw new TypeError(
          `Router op ${String(routerOp)} cannot resolve control edge ${String(edgeIndex)} from '${state.status}'.`,
        );
      }
    }
    for (const targetOp of branchPlan.targets) {
      if (this.readiness.isDependencyReleased(routerOp, targetOp)) {
        throw new TypeError(
          `Router dependency ${String(routerOp)} -> ${String(targetOp)} was already released before branch selection.`,
        );
      }
    }

    const selectedEdges = new Set(branchPlan.edges);
    for (const edgeIndex of outgoingEdges) {
      if (selectedEdges.has(edgeIndex)) {
        this.controlEdges.activate(edgeIndex);
      } else {
        this.controlEdges.skip(edgeIndex);
      }
    }

    // Scheduler-owned router: no executor/concurrency permit. Its source-side
    // control obligation completes immediately after the branch decision.
    this.readiness.startReservedReadyOp(routerOp);
    this.readiness.completeRunningOp(routerOp);
    for (const edgeIndex of branchPlan.edges) {
      this.controlEdges.complete(edgeIndex);
    }

    const newlyReadyTargets: number[] = [];
    for (const targetOp of branchPlan.targets) {
      if (this.readiness.releaseDependency(routerOp, targetOp)) {
        newlyReadyTargets.push(targetOp);
      }
    }
    this.selections.set(routerOp, branch);

    return Object.freeze({
      routerOp,
      branch,
      activatedTargets: branchPlan.targets,
      newlyReadyTargets: Object.freeze(newlyReadyTargets),
    });
  }

  snapshot(): RouterActivationSnapshot {
    const selections = [...this.selections.entries()]
      .sort(([left], [right]) => left - right)
      .map(([routerOp, branch]) => Object.freeze({ routerOp, branch }));

    return Object.freeze({ selections: Object.freeze(selections) });
  }
}
