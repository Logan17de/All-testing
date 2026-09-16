/**
 * Reading a recorded run back, one step at a time.
 *
 * The runtime replays a run from its own journal and attempt records (9.1): it runs
 * nothing, calls no model, tool or person, and writes nothing. This module turns that
 * answer into what the inspector shows — a sentence per step, and the state the graph
 * was in as of any step, so walking forward fills the canvas in the order it happened.
 */

export type ReplayStepKind = "attempt" | "router" | "loop" | "approval" | "recovery" | "run";

export interface ReplayStepView {
  readonly sequence: number;
  readonly eventId: number;
  readonly occurredAtMs: number;
  readonly kind: ReplayStepKind;
  readonly nodeId: string | null;
  readonly opIndex: number | null;
  readonly iteration: number | null;
  readonly attempt: number | null;
  readonly outcome: string;
  readonly detail: unknown;
}

export interface ReplayIssueView {
  readonly code: string;
  readonly message: string;
  readonly eventId: number | null;
}

export interface RunReplayView {
  readonly runId: string;
  readonly graphId: string;
  readonly revisionId: string;
  readonly status: string;
  readonly steps: readonly ReplayStepView[];
  /** True when the journal and the attempt records tell one consistent story. */
  readonly consistent: boolean;
  readonly issues: readonly ReplayIssueView[];
}

export function isRunReplayView(value: unknown): value is RunReplayView {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["runId"] === "string" &&
    typeof record["consistent"] === "boolean" &&
    Array.isArray(record["steps"]) &&
    Array.isArray(record["issues"])
  );
}

/**
 * The status of each node as of one step, so the canvas shows the run as it stood.
 *
 * A node an attempt finished for is completed or failed; a loop is running while it
 * goes round and completed once it leaves; a node waiting for a person is waiting.
 * Nodes that have not acted yet are simply absent, which is how the editor draws a
 * node nothing has happened to.
 */
export function replayNodeStatuses(
  steps: readonly ReplayStepView[],
  through: number,
): ReadonlyMap<string, string> {
  const statuses = new Map<string, string>();
  for (const step of steps.slice(0, through + 1)) {
    const nodeId = step.nodeId;
    if (nodeId === null) continue;
    switch (step.kind) {
      case "attempt":
        statuses.set(nodeId, step.outcome === "failed" ? "failed" : "completed");
        break;
      case "loop":
        statuses.set(nodeId, step.outcome === "exit" ? "completed" : "running");
        break;
      case "approval":
        if (step.outcome === "requested") statuses.set(nodeId, "waiting");
        break;
      case "router":
      case "recovery":
      case "run":
        break;
    }
  }
  return statuses;
}

function nameOf(step: ReplayStepView): string {
  return step.nodeId ?? (step.opIndex === null ? "the run" : `op ${String(step.opIndex)}`);
}

/** One plain sentence for a step, in the harness's own words. */
export function describeReplayStep(step: ReplayStepView): string {
  const attempt = step.attempt === null ? "" : ` on attempt ${String(step.attempt)}`;
  switch (step.kind) {
    case "attempt":
      return `${nameOf(step)} ${step.outcome}${attempt}.`;
    case "router":
      return `${nameOf(step)} chose ${step.outcome}.`;
    case "loop":
      return step.outcome === "exit"
        ? `${nameOf(step)} ended.`
        : step.outcome === "entered"
          ? `${nameOf(step)} started.`
          : `${nameOf(step)} went round again.`;
    case "approval":
      return step.outcome === "requested"
        ? `${nameOf(step)} asked a person.`
        : `A person ${step.outcome} ${nameOf(step)}.`;
    case "recovery":
      return `${nameOf(step)} recovered: ${step.outcome}.`;
    case "run":
      return `The run ${step.outcome}.`;
  }
}
