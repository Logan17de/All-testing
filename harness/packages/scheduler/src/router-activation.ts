import type { ExecutionIrRouterControlV1, ExecutionIrV1 } from "@zet-harness/graph";

import { RunReadiness } from "./run-readiness.js";

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
 * Run-local router selection over the already-lowered IR control edges.
 *
 * 3.5 deliberately records only one selected branch per router. It does not yet
 * create runtime state for individual control edges; unresolved/active/skipped/
 * completed edge state is owned by 3.6. The selected branch therefore releases
 * only the exact router→target dependency pairs wired from that named output.
 */
export class RunRouterActivation {
  private readonly branchTargets = new Map<number, ReadonlyMap<string, readonly number[]>>();
  private readonly selections = new Map<number, string>();

  constructor(
    private readonly ir: ExecutionIrV1,
    private readonly readiness: RunReadiness,
  ) {
    if (readiness.opCount !== ir.ops.length) {
      throw new TypeError("Router activation readiness does not match the Execution IR op count.");
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

      const targetsByBranch = new Map<string, Set<number>>();
      for (const branch of operation.control.branches) {
        targetsByBranch.set(branch, new Set<number>());
      }

      for (const edge of ir.controlEdges) {
        if (edge.from.op !== routerOp) {
          continue;
        }

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

        targetsByBranch.get(branch)?.add(edge.to.op);
      }

      this.branchTargets.set(
        routerOp,
        new Map(
          [...targetsByBranch.entries()].map(([branch, targets]) => [branch, frozenNumbers(targets)]),
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
   * Complete one dequeued scheduler-owned router and activate exactly one branch.
   *
   * The caller owns branch choice. This keeps routing policy/value inspection out
   * of the scheduler until runtime adapters can supply that decision. Unknown or
   * repeated selections fail before any dependency counter can be released twice.
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

    const activatedTargets = this.branchTargets.get(routerOp)?.get(branch) ?? Object.freeze([]);

    // The router is a scheduler-owned control op: it consumes no executor or
    // concurrency permit. Its run-local lifecycle still follows ready→running→completed.
    this.readiness.startReservedReadyOp(routerOp);
    this.readiness.completeRunningOp(routerOp);
    this.selections.set(routerOp, branch);

    const newlyReadyTargets: number[] = [];
    for (const targetOp of activatedTargets) {
      if (this.readiness.releaseDependency(routerOp, targetOp)) {
        newlyReadyTargets.push(targetOp);
      }
    }

    return Object.freeze({
      routerOp,
      branch,
      activatedTargets,
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
