import type { ExecutionIrLoopControlV1, ExecutionIrV1 } from "@zet-harness/graph";

import type { RunReadiness } from "./run-readiness.js";

/** One loop op and the body ops it runs once per iteration. */
export interface RunLoopPlan {
  readonly op: number;
  readonly control: ExecutionIrLoopControlV1;
  readonly region: ReadonlySet<number>;
  /** Body ops that wait on the loop op itself; each iteration starts by releasing them. */
  readonly bodyTargets: readonly number[];
}

const NOTHING: ReadonlySet<number> = new Set();

/**
 * Correct released predecessor sets for loops in a committed frontier.
 *
 * Two relations differ from "released once the source completed": a body op's
 * dependency on its loop op is released as soon as the loop is running, and a
 * dependency of work outside the body on a body op is released only once the
 * loop has completed, whatever the body op's own status says.
 */
export function applyLoopReleaseRules(
  ir: ExecutionIrV1,
  plans: readonly RunLoopPlan[],
  opStatuses: readonly string[],
  released: readonly (readonly number[])[],
): readonly (readonly number[])[] {
  const sets = released.map((sources) => new Set(sources));
  for (const plan of plans) {
    const loopStatus = opStatuses[plan.op];
    const loopEntered = loopStatus === "running" || loopStatus === "completed";
    ir.ops.forEach((target, targetOp) => {
      if (targetOp === plan.op) return;
      const set = sets[targetOp]!;
      for (const source of target.dependencies) {
        if (plan.region.has(targetOp) && source === plan.op) {
          if (loopEntered) set.add(source);
          else set.delete(source);
        } else if (!plan.region.has(targetOp) && plan.region.has(source)) {
          if (loopStatus === "completed" && opStatuses[source] === "completed") set.add(source);
          else set.delete(source);
        }
      }
    });
  }
  return Object.freeze(
    sets.map((set) => Object.freeze([...set].sort((left, right) => left - right))),
  );
}

export function isLoopOp(ir: ExecutionIrV1, op: number): boolean {
  return ir.ops[op]?.control?.kind === "loop";
}

/**
 * The loops a plan contains, checked against what the scheduler can iterate.
 *
 * Bodies may not contain routers, joins, loops or human gates yet: re-running
 * those per iteration needs per-iteration control state that lands later.
 */
export function loopPlansOf(ir: ExecutionIrV1): readonly RunLoopPlan[] {
  const plans: RunLoopPlan[] = [];
  const owner = new Map<number, number>();

  ir.ops.forEach((operation, op) => {
    const control = operation.control;
    if (control?.kind !== "loop") return;

    const region = new Set(control.region);
    for (const member of region) {
      const body = ir.ops[member];
      if (body === undefined) {
        throw new RangeError(`Loop op ${String(op)} body op ${String(member)} is unavailable.`);
      }
      if (body.control !== undefined || body.behavior.primitiveFamily === "interrupt") {
        throw new TypeError(
          `Loop op ${String(op)} body contains op ${String(member)} (${body.control?.kind ?? "human gate"}); routers, joins, loops and human gates inside a loop body are not supported yet.`,
        );
      }
      if (owner.has(member)) {
        throw new TypeError(`Op ${String(member)} belongs to more than one loop body.`);
      }
      owner.set(member, op);
    }

    const bodyTargets = [...region]
      .filter((member) => ir.ops[member]!.dependencies.includes(op))
      .sort((left, right) => left - right);
    if (bodyTargets.length === 0) {
      throw new TypeError(`Loop op ${String(op)} has no body op that waits on it.`);
    }
    plans.push(Object.freeze({ op, control, region, bodyTargets: Object.freeze(bodyTargets) }));
  });

  return Object.freeze(plans);
}

/**
 * Iteration bookkeeping for a run's loops.
 *
 * A loop op starts running when it is dequeued and stays running while its body
 * iterates, so nothing after the loop can start early. Each finished iteration
 * either re-arms the body (its ops return to pending, waiting only on each other)
 * or completes the loop op, which is when work after it, including readers of the
 * last iteration's values, is released.
 */
export class RunLoopControl {
  private readonly readiness: RunReadiness;
  private readonly plans: ReadonlyMap<number, RunLoopPlan>;
  private readonly ownerOf: ReadonlyMap<number, number>;
  private readonly iterations: number[];

  constructor(
    ir: ExecutionIrV1,
    readiness: RunReadiness,
    plans: readonly RunLoopPlan[],
    restoredIterations?: readonly number[],
  ) {
    this.readiness = readiness;
    this.plans = new Map(plans.map((plan) => [plan.op, plan] as const));
    const owners = new Map<number, number>();
    for (const plan of plans) for (const member of plan.region) owners.set(member, plan.op);
    this.ownerOf = owners;
    if (restoredIterations !== undefined && restoredIterations.length !== ir.ops.length) {
      throw new TypeError("Restored loop iterations must cover the exact op domain.");
    }
    this.iterations = ir.ops.map((_, op) => {
      const iteration = restoredIterations?.[op] ?? 0;
      if (!Number.isSafeInteger(iteration) || iteration < 0) {
        throw new TypeError(`Restored iteration for op ${String(op)} is invalid.`);
      }
      return iteration;
    });
  }

  planFor(loopOp: number): RunLoopPlan | undefined {
    return this.plans.get(loopOp);
  }

  /** The loop op whose body contains `op`, if any. */
  loopOf(op: number): number | undefined {
    return this.ownerOf.get(op);
  }

  /** Current iteration of a loop op or of a body op; zero for everything else. */
  iterationOf(op: number): number {
    return this.iterations[op] ?? 0;
  }

  /** A dequeued loop op starts running, and its first iteration starts. */
  enter(loopOp: number): RunLoopPlan {
    const plan = this.require(loopOp);
    this.readiness.startReservedReadyOp(loopOp);
    this.iterations[loopOp] = 0;
    for (const target of plan.bodyTargets) this.readiness.releaseDependency(loopOp, target);
    return plan;
  }

  /** Dependents a finished body op must not release yet: everything outside its body. */
  withheldDependents(op: number): ReadonlySet<number> {
    const loopOp = this.ownerOf.get(op);
    if (loopOp === undefined) return NOTHING;
    const region = this.require(loopOp).region;
    return new Set(this.readiness.getDependents(op).filter((target) => !region.has(target)));
  }

  /** True once every body op of a running loop has finished the current iteration. */
  iterationFinished(loopOp: number): boolean {
    const plan = this.require(loopOp);
    if (this.readiness.getOpState(loopOp).status !== "running") return false;
    return [...plan.region].every((member) => {
      const status = this.readiness.getOpState(member).status;
      return status === "completed" || status === "skipped";
    });
  }

  /** Start the next iteration; returns its number. */
  rearm(loopOp: number, ir: ExecutionIrV1): number {
    const plan = this.require(loopOp);
    const next = (this.iterations[loopOp] ?? 0) + 1;
    this.iterations[loopOp] = next;
    for (const member of [...plan.region].sort((left, right) => left - right)) {
      const outside = ir.ops[member]!.dependencies.filter((source) => !plan.region.has(source));
      this.readiness.rearmOp(member, outside);
      this.iterations[member] = next;
    }
    return next;
  }

  /** Leave a loop: it completes, and work after it is released. */
  exit(loopOp: number): void {
    const plan = this.require(loopOp);
    this.readiness.completeRunningOp(loopOp);
    const release = (source: number): void => {
      for (const target of this.readiness.getDependents(source)) {
        if (plan.region.has(target) || target === loopOp) continue;
        if (!this.readiness.isDependencyReleased(source, target)) {
          this.readiness.releaseDependency(source, target);
        }
      }
    };
    release(loopOp);
    for (const member of plan.region) {
      if (this.readiness.getOpState(member).status === "completed") release(member);
    }
  }

  /** Loops whose body finished an iteration that has not been decided yet. */
  undecidedLoops(): readonly number[] {
    return [...this.plans.keys()].filter((loopOp) => this.iterationFinished(loopOp));
  }

  snapshot(): readonly number[] {
    return Object.freeze([...this.iterations]);
  }

  private require(loopOp: number): RunLoopPlan {
    const plan = this.plans.get(loopOp);
    if (plan === undefined) throw new TypeError(`Run op ${String(loopOp)} is not a loop.`);
    return plan;
  }
}
