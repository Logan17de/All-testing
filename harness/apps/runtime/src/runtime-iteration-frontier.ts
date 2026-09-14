import { loopPlansOf } from "@zet-harness/scheduler";
import type { ExecutionIrV1 } from "@zet-harness/graph";

import type { RecoveredExecutionFrontier, RecoveredOpFrontier } from "./runtime-recovery.js";

/**
 * The frontier as the scheduler sees it: one state per op, at its latest iteration.
 *
 * Recovery keeps every (op, iteration) state it has seen. Earlier iterations of a
 * loop body are history; only the newest one can still change.
 */
export function currentOps(frontier: RecoveredExecutionFrontier): readonly RecoveredOpFrontier[] {
  const latest: RecoveredOpFrontier[] = [];
  for (const state of frontier.ops) {
    const seen = latest[state.opIndex];
    if (seen === undefined || state.iteration > seen.iteration) latest[state.opIndex] = state;
  }
  const count = (frontier.executionIr as unknown as ExecutionIrV1).ops.length;
  for (let op = 0; op < count; op += 1) {
    if (latest[op] === undefined) {
      throw new TypeError(`Recovered frontier has no state for op ${String(op)}.`);
    }
  }
  return Object.freeze(latest);
}

/**
 * The current iteration of every op. A loop op's iteration is its body's, since the
 * loop op itself is recorded once while its body moves through iterations.
 */
export function currentIterations(frontier: RecoveredExecutionFrontier): readonly number[] {
  const ir = frontier.executionIr as unknown as ExecutionIrV1;
  const iterations = currentOps(frontier).map((state) => state.iteration);
  if (!ir.ops.some((op) => op.control?.kind === "loop")) return Object.freeze(iterations);
  for (const plan of loopPlansOf(ir)) {
    iterations[plan.op] = Math.max(...[...plan.region].map((member) => iterations[member] ?? 0));
  }
  return Object.freeze(iterations);
}

const LOOP_BODIES = new WeakMap<ExecutionIrV1, ReadonlyMap<number, number>>();

/** The loop op whose body contains `op`, if any. */
export function loopBodyOf(ir: ExecutionIrV1, op: number): number | undefined {
  let bodies = LOOP_BODIES.get(ir);
  if (bodies === undefined) {
    const owners = new Map<number, number>();
    if (ir.ops.some((candidate) => candidate.control?.kind === "loop")) {
      for (const plan of loopPlansOf(ir)) {
        for (const member of plan.region) owners.set(member, plan.op);
      }
    }
    bodies = owners;
    LOOP_BODIES.set(ir, bodies);
  }
  return bodies.get(op);
}

/** The next ready order after every order already committed, across all iterations. */
export function nextReadyOrder(frontier: RecoveredExecutionFrontier): number {
  return frontier.ops.reduce((max, state) => Math.max(max, state.readyOrder ?? -1), -1) + 1;
}
