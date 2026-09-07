import type { ExecutionIrControlEdgeV1, ExecutionIrV1 } from "@zet-harness/graph";

export const CONTROL_EDGE_RUNTIME_STATUSES = Object.freeze([
  "unresolved",
  "active",
  "skipped",
  "completed",
] as const);

export type ControlEdgeRuntimeStatus = (typeof CONTROL_EDGE_RUNTIME_STATUSES)[number];

export interface RunControlEdgeState {
  /** Zero-based `ExecutionIrV1.controlEdges` index. */
  readonly edge: number;
  readonly status: ControlEdgeRuntimeStatus;
}

export interface RunControlEdgesSnapshot {
  readonly edges: readonly RunControlEdgeState[];
}

export const CONTROL_EDGE_RUNTIME_TRANSITIONS: Readonly<
  Record<ControlEdgeRuntimeStatus, readonly ControlEdgeRuntimeStatus[]>
> = Object.freeze({
  unresolved: Object.freeze(["active", "skipped"] as const),
  active: Object.freeze(["completed"] as const),
  skipped: Object.freeze([] as const),
  completed: Object.freeze([] as const),
});

function assertIndex(label: string, index: number, length: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new RangeError(`${label} index ${String(index)} is outside [0, ${String(length)}).`);
  }
}

function createState(edge: number): RunControlEdgeState {
  return Object.freeze({ edge, status: "unresolved" });
}

export function canTransitionControlEdgeRuntimeState(
  from: ControlEdgeRuntimeStatus,
  to: ControlEdgeRuntimeStatus,
): boolean {
  return CONTROL_EDGE_RUNTIME_TRANSITIONS[from].includes(to);
}

export function transitionControlEdgeRuntimeState(
  state: RunControlEdgeState,
  status: ControlEdgeRuntimeStatus,
): RunControlEdgeState {
  if (!canTransitionControlEdgeRuntimeState(state.status, status)) {
    throw new TypeError(
      `Control edge ${String(state.edge)} cannot transition from '${state.status}' to '${status}'.`,
    );
  }
  return Object.freeze({ edge: state.edge, status });
}

function freezeIndexLists(items: readonly number[][]): readonly (readonly number[])[] {
  return Object.freeze(items.map((indexes) => Object.freeze([...indexes])));
}

/**
 * Run-local state for immutable Execution IR control edges.
 *
 * Meaning frozen by 3.6:
 * - unresolved: the runtime has not decided whether this control edge participates;
 * - active: the edge is on the live control path and its source-side obligation is unfinished;
 * - skipped: the edge is definitively outside the live path;
 * - completed: the edge was active and its source-side obligation finished.
 *
 * Only unresolved→active|skipped and active→completed are legal. `skipped` and
 * `completed` are terminal. This layer records control truth only; 3.7 consumes
 * that truth for activation-aware joins while dependency counters stay in readiness.
 */
export class RunControlEdges {
  private readonly states: RunControlEdgeState[];
  private readonly outgoing: readonly (readonly number[])[];
  private readonly incoming: readonly (readonly number[])[];

  constructor(private readonly ir: ExecutionIrV1) {
    const outgoing = Array.from({ length: ir.ops.length }, () => [] as number[]);
    const incoming = Array.from({ length: ir.ops.length }, () => [] as number[]);

    this.states = ir.controlEdges.map((_, edge) => createState(edge));

    ir.controlEdges.forEach((edge, edgeIndex) => {
      const source = outgoing[edge.from.op];
      const target = incoming[edge.to.op];
      if (source === undefined || target === undefined) {
        throw new TypeError(`Control edge ${String(edgeIndex)} references an unavailable op.`);
      }
      source.push(edgeIndex);
      target.push(edgeIndex);
    });

    this.outgoing = freezeIndexLists(outgoing);
    this.incoming = freezeIndexLists(incoming);
  }

  get edgeCount(): number {
    return this.states.length;
  }

  get opCount(): number {
    return this.ir.ops.length;
  }

  isForIr(ir: ExecutionIrV1): boolean {
    return this.ir === ir;
  }

  getEdge(edge: number): ExecutionIrControlEdgeV1 {
    assertIndex("Control edge", edge, this.states.length);
    const value = this.ir.controlEdges[edge];
    if (value === undefined) {
      throw new RangeError(`Control edge index ${String(edge)} is unavailable.`);
    }
    return value;
  }

  getState(edge: number): RunControlEdgeState {
    assertIndex("Control edge", edge, this.states.length);
    const state = this.states[edge];
    if (state === undefined) {
      throw new RangeError(`Control edge index ${String(edge)} is unavailable.`);
    }
    return state;
  }

  getOutgoingEdgeIndexes(sourceOp: number): readonly number[] {
    assertIndex("Run op", sourceOp, this.ir.ops.length);
    const indexes = this.outgoing[sourceOp];
    if (indexes === undefined) {
      throw new RangeError(`Run op index ${String(sourceOp)} is unavailable.`);
    }
    return indexes;
  }

  getOutgoingEdgeIndexesForPort(sourceOp: number, port: string): readonly number[] {
    return Object.freeze(
      this.getOutgoingEdgeIndexes(sourceOp).filter(
        (edge) => this.ir.controlEdges[edge]?.from.port === port,
      ),
    );
  }

  getIncomingEdgeIndexes(targetOp: number): readonly number[] {
    assertIndex("Run op", targetOp, this.ir.ops.length);
    const indexes = this.incoming[targetOp];
    if (indexes === undefined) {
      throw new RangeError(`Run op index ${String(targetOp)} is unavailable.`);
    }
    return indexes;
  }

  getIncomingEdgeIndexesForPort(targetOp: number, port: string): readonly number[] {
    return Object.freeze(
      this.getIncomingEdgeIndexes(targetOp).filter(
        (edge) => this.ir.controlEdges[edge]?.to.port === port,
      ),
    );
  }

  activate(edge: number): RunControlEdgeState {
    return this.transition(edge, "active");
  }

  skip(edge: number): RunControlEdgeState {
    return this.transition(edge, "skipped");
  }

  complete(edge: number): RunControlEdgeState {
    return this.transition(edge, "completed");
  }

  snapshot(): RunControlEdgesSnapshot {
    return Object.freeze({ edges: Object.freeze([...this.states]) });
  }

  private transition(edge: number, status: ControlEdgeRuntimeStatus): RunControlEdgeState {
    const next = transitionControlEdgeRuntimeState(this.getState(edge), status);
    this.states[edge] = next;
    return next;
  }
}
