import type { DatabaseSync } from "node:sqlite";

import type { ExecutionIrV1 } from "@zet-harness/graph";

import { RuntimeGraphError } from "./runtime-graphs.js";
import {
  DURABLE_ROUTER_SELECTION_EVENT_TYPE,
  reconstructExecutionFrontier,
} from "./runtime-recovery.js";

export type ReplayStepKind = "attempt" | "router" | "loop" | "approval" | "recovery" | "run";

/** One recorded thing that happened in a run, in journal order. */
export interface ReplayStep {
  /** 1-based position among the replayed steps. */
  readonly sequence: number;
  readonly eventId: number;
  readonly occurredAtMs: number;
  readonly kind: ReplayStepKind;
  readonly nodeId: string | null;
  readonly opIndex: number | null;
  readonly iteration: number | null;
  readonly attempt: number | null;
  /**
   * `completed` or `failed` for an attempt, the chosen branch for a router,
   * `entered`, `continue` or `exit` for a loop, `requested`, `approved` or
   * `rejected` for an approval, and the outcome of a run.
   */
  readonly outcome: string;
  /**
   * For an attempt, its derived `inputs` and recorded `outputs` and `usage`, or its
   * `error`; for a loop exit, its `reason`; otherwise the recorded payload.
   */
  readonly detail: unknown;
}

export type ReplayIssueCode =
  | "ATTEMPT_RECORD_MISSING"
  | "ATTEMPT_STATUS_MISMATCH"
  | "ATTEMPT_NOT_JOURNALED"
  | "INPUT_UNAVAILABLE"
  | "RUN_STATUS_MISMATCH";

/** A way the journal and the stored records disagree. */
export interface ReplayIssue {
  readonly code: ReplayIssueCode;
  readonly message: string;
  readonly eventId: number | null;
}

export interface RecordedRunReplay {
  readonly runId: string;
  readonly graphId: string;
  readonly revisionId: string;
  readonly status: string;
  readonly steps: readonly ReplayStep[];
  /** True when the journal and the attempt records tell one consistent story. */
  readonly consistent: boolean;
  readonly issues: readonly ReplayIssue[];
}

interface AttemptRow {
  readonly opIndex: number;
  readonly iteration: number;
  readonly attempt: number;
  readonly status: string;
  readonly outputs: string | null;
  readonly error: string | null;
  readonly usage: string | null;
}

interface EventRow {
  readonly eventId: number;
  readonly eventType: string;
  readonly opIndex: number | null;
  readonly iteration: number | null;
  readonly attempt: number | null;
  readonly occurredAtMs: number;
  readonly payload: string;
}

const RUN_OUTCOME_EVENTS: ReadonlyMap<string, string> = new Map([
  ["harness.run.completed", "completed"],
  ["harness.run.failed", "failed"],
  ["harness.run.cancelled", "cancelled"],
]);

function parse(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/** Output ports and their values; inline references are unwrapped, anything else kept as stored. */
function outputValues(refs: unknown): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [port, ref] of Object.entries(record(refs) ?? {})) {
    const reference = record(ref);
    values[port] = reference?.["kind"] === "inline" ? reference["value"] : ref;
  }
  return values;
}

const attemptKey = (op: number, iteration: number, attempt: number): string =>
  `${String(op)}:${String(iteration)}:${String(attempt)}`;

/**
 * Replay a run from its durable records (9.1).
 *
 * This is read-only and invokes nothing: no node executor, model, tool or person is
 * called, and nothing is written. It walks the run's journal in order and, for every
 * attempt, re-derives the inputs the node received from literals, compiled graph input
 * defaults and the outputs recorded upstream at that moment, exactly as the dispatcher
 * resolves them, including same-iteration values inside a loop body. It pairs each
 * attempt with its recorded outputs, usage or error, and adds router branches, loop
 * decisions and why a loop ended, approvals, recovery outcomes and the run's end.
 *
 * It also checks that the journal and the stored records agree: every finished attempt
 * is journaled and every journaled attempt is stored with the same status, every input
 * had a recorded value, and the journal ends the run with the status the run has. Any
 * disagreement is reported as an issue rather than thrown, so a damaged run can still
 * be inspected. Values pass through `redact` before they are returned.
 */
export function replayRecordedRun(
  connection: DatabaseSync,
  runId: string,
  redact: (value: unknown) => unknown = (value) => value,
): RecordedRunReplay {
  const run = connection
    .prepare(
      `SELECT r.status AS status, g.graph_id AS graphId, g.revision_id AS revisionId
       FROM runs AS r JOIN graph_sources AS g ON g.document_hash = r.document_hash
       WHERE r.run_id = ?`,
    )
    .get(runId) as
    { readonly status: string; readonly graphId: string; readonly revisionId: string } | undefined;
  if (run === undefined) {
    throw new RuntimeGraphError("RUN_NOT_FOUND", "No run exists with this id.", 404);
  }

  const ir = reconstructExecutionFrontier(connection, runId)
    .executionIr as unknown as ExecutionIrV1;
  const nodeOf = (op: number | null): string | null =>
    op === null ? null : (ir.ops[op]?.sourceNodeId ?? `op-${String(op)}`);
  const loopOf = new Map<number, number>();
  ir.ops.forEach((operation, index) => {
    if (operation.control?.kind === "loop") {
      for (const member of operation.control.region) loopOf.set(member, index);
    }
  });

  const attempts = new Map<string, AttemptRow>();
  for (const row of connection
    .prepare(
      `SELECT op_index AS opIndex, iteration, attempt, status, output_refs_json AS outputs,
        error_json AS error, usage_json AS usage
       FROM node_attempts WHERE run_id = ?`,
    )
    .all(runId) as unknown as AttemptRow[]) {
    attempts.set(attemptKey(row.opIndex, row.iteration, row.attempt), row);
  }
  const events = connection
    .prepare(
      `SELECT event_id AS eventId, event_type AS eventType, op_index AS opIndex, iteration,
        attempt, occurred_at_ms AS occurredAtMs, payload_json AS payload
       FROM durable_events WHERE run_id = ? ORDER BY event_id`,
    )
    .all(runId) as unknown as EventRow[];

  const steps: ReplayStep[] = [];
  const issues: ReplayIssue[] = [];
  const journaled = new Set<string>();
  const latestOutputs = new Map<number, Record<string, unknown>>();
  const iterationOutputs = new Map<string, Record<string, unknown>>();
  const startedInputs = new Map<string, Record<string, unknown>>();

  const remember = (op: number, iteration: number, outputs: Record<string, unknown>): void => {
    latestOutputs.set(op, outputs);
    iterationOutputs.set(`${String(op)}:${String(iteration)}`, outputs);
  };

  const inputsFor = (op: number, iteration: number, eventId: number): Record<string, unknown> => {
    const inputs: Record<string, unknown> = {};
    for (const binding of ir.ops[op]?.inputs ?? []) {
      const source = binding.source;
      switch (source.kind) {
        case "literal":
          inputs[binding.port] = source.value;
          break;
        case "graph-input":
          inputs[binding.port] = ir.graphInputs[source.input]?.default ?? null;
          break;
        case "secret":
          // Secret material never enters the journal or a replay.
          inputs[binding.port] = { secretRef: source.secretRef };
          break;
        case "op-output": {
          const body = loopOf.get(op);
          const sameBody = body !== undefined && body === loopOf.get(source.op);
          const outputs = sameBody
            ? iterationOutputs.get(`${String(source.op)}:${String(iteration)}`)
            : latestOutputs.get(source.op);
          if (outputs === undefined || !(source.port in outputs)) {
            issues.push({
              code: "INPUT_UNAVAILABLE",
              message: `Input '${binding.port}' of '${nodeOf(op) ?? ""}' reads '${nodeOf(source.op) ?? ""}.${source.port}', which had no recorded output at that point.`,
              eventId,
            });
          } else {
            inputs[binding.port] = outputs[source.port];
          }
          break;
        }
      }
    }
    return inputs;
  };

  const push = (event: EventRow, kind: ReplayStepKind, outcome: string, detail: unknown): void => {
    steps.push(
      Object.freeze({
        sequence: steps.length + 1,
        eventId: event.eventId,
        occurredAtMs: event.occurredAtMs,
        kind,
        nodeId: nodeOf(event.opIndex),
        opIndex: event.opIndex,
        iteration: event.iteration,
        attempt: event.attempt,
        outcome,
        detail: redact(detail),
      }),
    );
  };

  let journalOutcome: string | undefined;
  for (const event of events) {
    const payload = record(parse(event.payload));
    const op = event.opIndex;
    const iteration = event.iteration ?? 0;
    switch (event.eventType) {
      case "harness.attempt.started": {
        if (op !== null && event.attempt !== null) {
          startedInputs.set(
            attemptKey(op, iteration, event.attempt),
            inputsFor(op, iteration, event.eventId),
          );
        }
        break;
      }
      case "harness.attempt.completed":
      case "harness.attempt.failed": {
        if (op === null) break;
        const completed = event.eventType === "harness.attempt.completed";
        const key = event.attempt === null ? undefined : attemptKey(op, iteration, event.attempt);
        const row = key === undefined ? undefined : attempts.get(key);
        if (key !== undefined) {
          journaled.add(key);
          if (row === undefined) {
            issues.push({
              code: "ATTEMPT_RECORD_MISSING",
              message: `The journal ${completed ? "completes" : "fails"} attempt ${key} of '${nodeOf(op) ?? ""}', but no attempt is stored.`,
              eventId: event.eventId,
            });
          } else if (row.status !== (completed ? "completed" : "failed")) {
            issues.push({
              code: "ATTEMPT_STATUS_MISMATCH",
              message: `The journal ${completed ? "completes" : "fails"} attempt ${key} of '${nodeOf(op) ?? ""}', but it is stored as ${row.status}.`,
              eventId: event.eventId,
            });
          }
        }
        const inputs = key === undefined ? {} : (startedInputs.get(key) ?? {});
        if (completed) {
          const outputs = outputValues(parse(row?.outputs ?? null));
          remember(op, iteration, outputs);
          push(event, "attempt", "completed", {
            inputs,
            outputs,
            usage: parse(row?.usage ?? null),
          });
        } else {
          push(event, "attempt", "failed", { inputs, error: payload ?? parse(row?.error ?? null) });
        }
        break;
      }
      case DURABLE_ROUTER_SELECTION_EVENT_TYPE: {
        const branch = payload?.["branch"];
        push(event, "router", typeof branch === "string" ? branch : "unknown", payload);
        break;
      }
      case "harness.loop.entered":
        push(event, "loop", "entered", {});
        break;
      case "harness.loop.advanced": {
        const decision = payload?.["decision"];
        const reason = payload?.["reason"];
        push(
          event,
          "loop",
          typeof decision === "string" ? decision : "unknown",
          reason === undefined ? {} : { reason },
        );
        break;
      }
      case "harness.approval.requested":
        push(event, "approval", "requested", payload);
        break;
      case "harness.approval.resolved": {
        const decisionValue = payload?.["decision"];
        const decision = typeof decisionValue === "string" ? decisionValue : "unknown";
        let detail: unknown = payload;
        if (decision === "approved" && op !== null) {
          // An approved human step is stored as a completed attempt holding the response.
          const key = attemptKey(op, 0, 1);
          const row = attempts.get(key);
          if (row === undefined) {
            issues.push({
              code: "ATTEMPT_RECORD_MISSING",
              message: `Approval of '${nodeOf(op) ?? ""}' has no stored response attempt.`,
              eventId: event.eventId,
            });
          } else {
            journaled.add(key);
            const outputs = outputValues(parse(row.outputs));
            remember(op, 0, outputs);
            detail = { ...(payload ?? {}), outputs };
          }
        }
        push(event, "approval", decision, detail);
        break;
      }
      case "harness.effect.recovery-outcome": {
        const outcome = payload?.["outcome"];
        push(event, "recovery", typeof outcome === "string" ? outcome : "recorded", payload);
        break;
      }
      case "harness.run.budget-exceeded":
        push(event, "run", "budget-exceeded", payload);
        break;
      default: {
        const outcome = RUN_OUTCOME_EVENTS.get(event.eventType);
        if (outcome !== undefined) {
          journalOutcome = outcome;
          push(event, "run", outcome, payload ?? {});
        }
      }
    }
  }

  for (const [key, row] of attempts) {
    if ((row.status === "completed" || row.status === "failed") && !journaled.has(key)) {
      issues.push({
        code: "ATTEMPT_NOT_JOURNALED",
        message: `Attempt ${key} of '${nodeOf(row.opIndex) ?? ""}' is stored as ${row.status}, but the journal never records it.`,
        eventId: null,
      });
    }
  }
  if (journalOutcome !== undefined && journalOutcome !== run.status) {
    issues.push({
      code: "RUN_STATUS_MISMATCH",
      message: `The journal ends the run as ${journalOutcome}, but the run is stored as ${run.status}.`,
      eventId: null,
    });
  } else if (
    journalOutcome === undefined &&
    (run.status === "completed" || run.status === "failed")
  ) {
    issues.push({
      code: "RUN_STATUS_MISMATCH",
      message: `The run is stored as ${run.status}, but its journal never ends it.`,
      eventId: null,
    });
  }

  return Object.freeze({
    runId,
    graphId: run.graphId,
    revisionId: run.revisionId,
    status: run.status,
    steps: Object.freeze(steps),
    consistent: issues.length === 0,
    issues: Object.freeze(issues.map((issue) => Object.freeze(issue))),
  });
}
