import type { DatabaseSync } from "node:sqlite";

import {
  DURABLE_EVENTS_TABLE,
  NODE_ATTEMPTS_TABLE,
  type SerializedSqliteCommitPath,
} from "@zet-harness/db";

import type { PreCrashRecoveryClassification } from "./runtime-recovery-policy.js";

export const DURABLE_EFFECT_RECOVERY_OUTCOME_EVENT_TYPE =
  "harness.effect.recovery-outcome" as const;
export const DURABLE_EFFECT_RECOVERY_OUTCOME_EVENT_SCHEMA_VERSION = 1 as const;

export type EffectRecoveryOutcomeSource = "reconciliation" | "manual-review";
export type EffectRecoveryOutcomeKind =
  | "confirmed-applied"
  | "confirmed-not-applied"
  | "inconclusive"
  | "abandoned";
export type EffectRecoveryDisposition =
  | "complete-with-recovered-output"
  | "rerun-authorized"
  | "hold-for-manual-review"
  | "fail";
export type EffectRecoveryNextAction = "hold-for-reconciliation" | EffectRecoveryDisposition;

export interface EffectRecoveryOutcomeInput {
  readonly source: EffectRecoveryOutcomeSource;
  readonly outcome: EffectRecoveryOutcomeKind;
  /** Opaque JSON describing durable references to reconciliation/review evidence. */
  readonly evidenceRefsJson: string;
  /** Required only when an applied effect can reconstruct the node output. */
  readonly outputRefsJson?: string;
  readonly occurredAtMs: number;
}

export interface DurableEffectRecoveryOutcome {
  readonly eventId: number;
  readonly source: EffectRecoveryOutcomeSource;
  readonly outcome: EffectRecoveryOutcomeKind;
  readonly disposition: EffectRecoveryDisposition;
  readonly evidenceRefsJson: string;
  readonly outputRefsJson: string | null;
  readonly occurredAtMs: number;
}

export interface AmbiguousExternalWriteRecoveryState {
  readonly runId: string;
  readonly opIndex: number;
  readonly iteration: number;
  readonly attempt: number;
  readonly logicalEffectId: string;
  readonly recoveryPolicy: "reconcile" | "manual";
  readonly nextAction: EffectRecoveryNextAction;
  readonly recoveredOutputRefsJson: string | null;
  readonly history: readonly DurableEffectRecoveryOutcome[];
}

export interface AmbiguousExternalWriteRecoveryIdentity {
  readonly runId: string;
  readonly classification: PreCrashRecoveryClassification;
}

export interface CommitAmbiguousExternalWriteRecoveryOutcomeInput
  extends AmbiguousExternalWriteRecoveryIdentity {
  readonly resolution: EffectRecoveryOutcomeInput;
}

type SqliteRow = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(row: SqliteRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Effect recovery field '${field}' must be a non-empty string.`);
  }
  return value;
}

function requireInteger(row: SqliteRow, field: string, minimum = 0): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(
      `Effect recovery field '${field}' must be a safe integer >= ${String(minimum)}.`,
    );
  }
  return value;
}

function nullableString(row: SqliteRow, field: string): string | null {
  const value = row[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Effect recovery field '${field}' must be null or a non-empty string.`);
  }
  return value;
}

function assertJsonText(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must be non-empty JSON text.`);
  }
  try {
    JSON.parse(value);
  } catch (error) {
    throw new TypeError(`${label} must be valid JSON text.`, { cause: error });
  }
}

function assertOccurredAtMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Effect recovery occurredAtMs must be a non-negative safe integer.");
  }
}

function initialAction(
  classification: PreCrashRecoveryClassification,
): "hold-for-reconciliation" | "hold-for-manual-review" {
  if (
    classification.recoveryPolicy === "reconcile" &&
    classification.action === "hold-for-reconciliation"
  ) {
    return "hold-for-reconciliation";
  }
  if (
    classification.recoveryPolicy === "manual" &&
    classification.action === "hold-for-manual-review"
  ) {
    return "hold-for-manual-review";
  }
  throw new TypeError(
    "Ambiguous external-write recovery requires a reconcile or manual pre-crash recovery hold.",
  );
}

function validateResolution(input: EffectRecoveryOutcomeInput): EffectRecoveryDisposition {
  assertOccurredAtMs(input.occurredAtMs);
  assertJsonText("Effect recovery evidenceRefsJson", input.evidenceRefsJson);

  if (input.source === "reconciliation") {
    if (input.outcome === "inconclusive") {
      if (input.outputRefsJson !== undefined) {
        throw new TypeError("Inconclusive reconciliation cannot carry recovered output refs.");
      }
      return "hold-for-manual-review";
    }
    if (input.outcome === "confirmed-not-applied") {
      if (input.outputRefsJson !== undefined) {
        throw new TypeError("A confirmed-not-applied effect cannot carry recovered output refs.");
      }
      return "rerun-authorized";
    }
    if (input.outcome === "confirmed-applied") {
      if (input.outputRefsJson === undefined) {
        throw new TypeError("A confirmed-applied effect requires recovered outputRefsJson.");
      }
      assertJsonText("Effect recovery outputRefsJson", input.outputRefsJson);
      return "complete-with-recovered-output";
    }
    throw new TypeError(
      `Reconciliation cannot produce effect recovery outcome '${String(input.outcome)}'.`,
    );
  }

  if (input.source === "manual-review") {
    if (input.outcome === "confirmed-not-applied") {
      if (input.outputRefsJson !== undefined) {
        throw new TypeError("A confirmed-not-applied effect cannot carry recovered output refs.");
      }
      return "rerun-authorized";
    }
    if (input.outcome === "confirmed-applied") {
      if (input.outputRefsJson === undefined) {
        throw new TypeError("A confirmed-applied effect requires recovered outputRefsJson.");
      }
      assertJsonText("Effect recovery outputRefsJson", input.outputRefsJson);
      return "complete-with-recovered-output";
    }
    if (input.outcome === "abandoned") {
      if (input.outputRefsJson !== undefined) {
        throw new TypeError("An abandoned effect recovery cannot carry recovered output refs.");
      }
      return "fail";
    }
    throw new TypeError(
      `Manual review cannot produce effect recovery outcome '${String(input.outcome)}'.`,
    );
  }

  throw new TypeError(`Unknown effect recovery outcome source '${String(input.source)}'.`);
}

function assertSourceAllowed(nextAction: EffectRecoveryNextAction, source: EffectRecoveryOutcomeSource) {
  if (nextAction === "hold-for-reconciliation") {
    if (source !== "reconciliation") {
      throw new TypeError("This recovery hold requires reconciliation before manual review.");
    }
    return;
  }
  if (nextAction === "hold-for-manual-review") {
    if (source !== "manual-review") {
      throw new TypeError("This recovery hold requires a manual-review outcome.");
    }
    return;
  }
  throw new TypeError(`Effect recovery is already final with action '${nextAction}'.`);
}

function parseStoredOutcome(
  row: SqliteRow,
  classification: PreCrashRecoveryClassification,
): DurableEffectRecoveryOutcome {
  const schemaVersion = requireInteger(row, "event_schema_version", 1);
  if (schemaVersion !== DURABLE_EFFECT_RECOVERY_OUTCOME_EVENT_SCHEMA_VERSION) {
    throw new TypeError(
      `Unsupported effect recovery outcome event schema version ${String(schemaVersion)}.`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(requireString(row, "payload_json")) as unknown;
  } catch (error) {
    throw new TypeError("Durable effect recovery outcome payload is not valid JSON.", {
      cause: error,
    });
  }
  if (!isObject(payload)) {
    throw new TypeError("Durable effect recovery outcome payload must decode to an object.");
  }

  if (requireString(payload, "logicalEffectId") !== classification.logicalEffectId) {
    throw new TypeError("Durable effect recovery outcome logical effect identity does not match.");
  }
  if (requireString(payload, "recoveryPolicy") !== classification.recoveryPolicy) {
    throw new TypeError("Durable effect recovery outcome recovery policy does not match.");
  }

  const source = requireString(payload, "source") as EffectRecoveryOutcomeSource;
  const outcome = requireString(payload, "outcome") as EffectRecoveryOutcomeKind;
  const evidenceRefsJson = requireString(payload, "evidenceRefsJson");
  const outputRefsJson = nullableString(payload, "outputRefsJson");
  const occurredAtMs = requireInteger(row, "occurred_at_ms");
  const disposition = validateResolution({
    source,
    outcome,
    evidenceRefsJson,
    ...(outputRefsJson === null ? {} : { outputRefsJson }),
    occurredAtMs,
  });

  if (requireString(payload, "disposition") !== disposition) {
    throw new TypeError("Durable effect recovery outcome disposition is inconsistent with its result.");
  }

  return Object.freeze({
    eventId: requireInteger(row, "event_id", 1),
    source,
    outcome,
    disposition,
    evidenceRefsJson,
    outputRefsJson,
    occurredAtMs,
  });
}

function loadHistory(
  connection: DatabaseSync,
  identity: AmbiguousExternalWriteRecoveryIdentity,
): readonly DurableEffectRecoveryOutcome[] {
  const { classification } = identity;
  const rows = connection
    .prepare(
      `SELECT event_id, event_schema_version, occurred_at_ms, payload_json
       FROM ${DURABLE_EVENTS_TABLE}
       WHERE run_id = ?
         AND op_index = ?
         AND iteration = ?
         AND attempt = ?
         AND event_type = ?
       ORDER BY event_id`,
    )
    .all(
      identity.runId,
      classification.opIndex,
      classification.iteration,
      classification.attempt,
      DURABLE_EFFECT_RECOVERY_OUTCOME_EVENT_TYPE,
    ) as SqliteRow[];

  return Object.freeze(rows.map((row) => parseStoredOutcome(row, classification)));
}

function buildState(
  identity: AmbiguousExternalWriteRecoveryIdentity,
  history: readonly DurableEffectRecoveryOutcome[],
): AmbiguousExternalWriteRecoveryState {
  const { classification } = identity;
  let nextAction: EffectRecoveryNextAction = initialAction(classification);

  for (const outcome of history) {
    assertSourceAllowed(nextAction, outcome.source);
    nextAction = outcome.disposition;
  }

  const latest = history.at(-1);
  const recoveredOutputRefsJson =
    nextAction === "complete-with-recovered-output" ? (latest?.outputRefsJson ?? null) : null;
  if (nextAction === "complete-with-recovered-output" && recoveredOutputRefsJson === null) {
    throw new TypeError("Completed effect recovery state is missing recovered output refs.");
  }

  return Object.freeze({
    runId: identity.runId,
    opIndex: classification.opIndex,
    iteration: classification.iteration,
    attempt: classification.attempt,
    logicalEffectId: classification.logicalEffectId,
    recoveryPolicy: classification.recoveryPolicy as "reconcile" | "manual",
    nextAction,
    recoveredOutputRefsJson,
    history,
  });
}

/**
 * Read restart-stable ambiguous-write recovery state from durable outcome events.
 *
 * No outcome is inferred. A reconcile policy begins held for reconciliation; a
 * manual policy begins held for review. Only committed evidence-backed outcome
 * events move that state to recovered completion, explicit rerun authority,
 * manual review, or failure.
 */
export function readAmbiguousExternalWriteRecoveryState(
  connection: DatabaseSync,
  identity: AmbiguousExternalWriteRecoveryIdentity,
): AmbiguousExternalWriteRecoveryState {
  if (identity.runId.length === 0) {
    throw new TypeError("Effect recovery runId must not be empty.");
  }
  initialAction(identity.classification);
  return buildState(identity, loadHistory(connection, identity));
}

function assertRunningAttemptIdentity(
  connection: DatabaseSync,
  identity: AmbiguousExternalWriteRecoveryIdentity,
): void {
  const { classification } = identity;
  const row = connection
    .prepare(
      `SELECT logical_effect_id, status
       FROM ${NODE_ATTEMPTS_TABLE}
       WHERE run_id = ? AND op_index = ? AND iteration = ? AND attempt = ?`,
    )
    .get(
      identity.runId,
      classification.opIndex,
      classification.iteration,
      classification.attempt,
    ) as SqliteRow | undefined;

  if (row === undefined) {
    throw new RangeError("Effect recovery references an unavailable durable node attempt.");
  }
  if (requireString(row, "logical_effect_id") !== classification.logicalEffectId) {
    throw new TypeError("Effect recovery logical effect identity does not match the durable attempt.");
  }
  if (requireString(row, "status") !== "running") {
    throw new TypeError("Effect recovery outcome requires the ambiguous durable attempt to remain running.");
  }
}

/**
 * Append one reconciliation/manual-review outcome through the serialized commit
 * path and return the resulting restart-stable recovery state.
 *
 * This function deliberately does not complete/fail the attempt or mutate the
 * scheduler frontier. 5.4 records the explicit recovery decision; the runtime
 * recovery executor must later apply that disposition atomically with scheduler
 * state. This prevents a reconciliation observation from being mistaken for an
 * already-committed node completion.
 */
export function commitAmbiguousExternalWriteRecoveryOutcome(
  database: SerializedSqliteCommitPath,
  input: CommitAmbiguousExternalWriteRecoveryOutcomeInput,
): Promise<AmbiguousExternalWriteRecoveryState> {
  if (input.runId.length === 0) {
    throw new TypeError("Effect recovery runId must not be empty.");
  }
  initialAction(input.classification);
  const disposition = validateResolution(input.resolution);

  return database.commit((connection) => {
    assertRunningAttemptIdentity(connection, input);
    const before = readAmbiguousExternalWriteRecoveryState(connection, input);
    assertSourceAllowed(before.nextAction, input.resolution.source);

    const payloadJson = JSON.stringify({
      logicalEffectId: input.classification.logicalEffectId,
      recoveryPolicy: input.classification.recoveryPolicy,
      source: input.resolution.source,
      outcome: input.resolution.outcome,
      disposition,
      evidenceRefsJson: input.resolution.evidenceRefsJson,
      outputRefsJson: input.resolution.outputRefsJson ?? null,
    });

    connection
      .prepare(
        `INSERT INTO ${DURABLE_EVENTS_TABLE}(
           run_id, event_type, event_schema_version, op_index, iteration,
           attempt, occurred_at_ms, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        DURABLE_EFFECT_RECOVERY_OUTCOME_EVENT_TYPE,
        DURABLE_EFFECT_RECOVERY_OUTCOME_EVENT_SCHEMA_VERSION,
        input.classification.opIndex,
        input.classification.iteration,
        input.classification.attempt,
        input.resolution.occurredAtMs,
        payloadJson,
      );

    return readAmbiguousExternalWriteRecoveryState(connection, input);
  });
}
