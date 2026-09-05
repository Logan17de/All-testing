export const RUN_OP_STATUSES = [
  "pending",
  "ready",
  "running",
  "completed",
  "skipped",
  "waiting",
  "retry-wait",
  "failed",
  "cancelled",
] as const;

export type RunOpStatus = (typeof RUN_OP_STATUSES)[number];

export const RUN_OP_TERMINAL_STATUSES = [
  "completed",
  "skipped",
  "failed",
  "cancelled",
] as const satisfies readonly RunOpStatus[];

const RUN_OP_TRANSITIONS = {
  pending: ["ready", "skipped", "cancelled"],
  ready: ["running", "skipped", "cancelled"],
  running: ["completed", "skipped", "waiting", "retry-wait", "failed", "cancelled"],
  completed: [],
  skipped: [],
  waiting: ["ready", "cancelled"],
  "retry-wait": ["ready", "cancelled"],
  failed: [],
  cancelled: [],
} as const satisfies Readonly<Record<RunOpStatus, readonly RunOpStatus[]>>;

export interface RunOpState {
  /** Zero-based Execution IR op index. */
  readonly op: number;
  readonly status: RunOpStatus;
}

function assertOpIndex(op: number): void {
  if (!Number.isSafeInteger(op) || op < 0) {
    throw new RangeError("Run op index must be a non-negative safe integer.");
  }
}

export function createRunOpState(op: number): RunOpState {
  assertOpIndex(op);
  return Object.freeze({ op, status: "pending" });
}

export function isTerminalRunOpStatus(status: RunOpStatus): boolean {
  return (RUN_OP_TERMINAL_STATUSES as readonly RunOpStatus[]).includes(status);
}

export function canTransitionRunOpStatus(from: RunOpStatus, to: RunOpStatus): boolean {
  return (RUN_OP_TRANSITIONS[from] as readonly RunOpStatus[]).includes(to);
}

export function getAllowedRunOpTransitions(status: RunOpStatus): readonly RunOpStatus[] {
  return RUN_OP_TRANSITIONS[status];
}

/**
 * Apply one legal run-local state transition without mutating the previous state.
 *
 * 3.1 owns only the state vocabulary and transition invariants. Readiness,
 * dependency accounting, branch activation, retry timers, cancellation signals,
 * and executor dispatch are later Phase-3 items that decide when to request a
 * legal transition.
 */
export function transitionRunOpState(state: RunOpState, next: RunOpStatus): RunOpState {
  assertOpIndex(state.op);

  if (!canTransitionRunOpStatus(state.status, next)) {
    throw new TypeError(`Illegal run op status transition '${state.status}' -> '${next}'.`);
  }

  return Object.freeze({ op: state.op, status: next });
}
