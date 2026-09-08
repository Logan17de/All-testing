import type { DatabaseSync } from "node:sqlite";

import {
  CHECKPOINT_CONTROL_EDGES_TABLE,
  CHECKPOINT_OP_FRONTIER_TABLE,
  CHECKPOINT_ROUTER_SELECTIONS_TABLE,
  COMPILED_PLANS_TABLE,
  DURABLE_EVENTS_TABLE,
  NODE_ATTEMPTS_TABLE,
  RUN_CHECKPOINTS_TABLE,
  RUNS_TABLE,
  type DurableCheckpointControlEdgeStatus,
  type DurableCheckpointOpStatus,
  type DurableRunStatus,
} from "@zet-harness/db";

export const DURABLE_OP_FRONTIER_EVENT_TYPE = "harness.frontier.op" as const;
export const DURABLE_CONTROL_EDGE_FRONTIER_EVENT_TYPE = "harness.frontier.control-edge" as const;
export const DURABLE_ROUTER_SELECTION_EVENT_TYPE = "harness.frontier.router-selection" as const;
export const DURABLE_FRONTIER_EVENT_SCHEMA_VERSION = 1 as const;
export const DURABLE_CHECKPOINT_SCHEMA_VERSION = 1 as const;

const OP_STATUSES = new Set<DurableCheckpointOpStatus>([
  "pending",
  "ready",
  "running",
  "completed",
  "skipped",
  "waiting",
  "retry-wait",
  "failed",
  "cancelled",
]);
const CONTROL_EDGE_STATUSES = new Set<DurableCheckpointControlEdgeStatus>([
  "active",
  "skipped",
  "completed",
]);
const RUN_STATUSES = new Set<DurableRunStatus>([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);

interface RecoveryIrBehavior {
  readonly executionMode: string;
  readonly recovery: string;
  readonly retry?: {
    readonly maxAttempts: number;
  };
}

interface RecoveryIrControl {
  readonly kind: string;
  readonly branches?: readonly string[];
}

export interface RecoveryExecutionIrOp {
  readonly sourceNodeId: string;
  readonly dependencies: readonly number[];
  readonly behavior: RecoveryIrBehavior;
  readonly control?: RecoveryIrControl;
}

export interface RecoveryExecutionIrControlEdge {
  readonly from: { readonly op: number; readonly port?: string };
  readonly to: { readonly op: number; readonly port?: string };
}

export interface RecoveryExecutionIrV1 {
  readonly format: "harness.ir/v1";
  readonly ops: readonly RecoveryExecutionIrOp[];
  readonly controlEdges: readonly RecoveryExecutionIrControlEdge[];
  readonly [key: string]: unknown;
}

export interface RecoveredOpFrontier {
  readonly opIndex: number;
  readonly iteration: number;
  readonly status: DurableCheckpointOpStatus;
  readonly remainingDependencies: number;
  readonly attemptsStarted: number;
  readonly attemptBudgetUsed: number;
  readonly readyOrder: number | null;
  readonly retryNotBeforeMs: number | null;
}

export interface RecoveredControlEdgeFrontier {
  readonly edgeIndex: number;
  readonly iteration: number;
  readonly status: "unresolved" | DurableCheckpointControlEdgeStatus;
}

export interface RecoveredRouterSelection {
  readonly routerOpIndex: number;
  readonly iteration: number;
  readonly branch: string;
}

export interface RecoveredReadyEntry {
  readonly opIndex: number;
  readonly iteration: number;
  readonly readyOrder: number;
}

export interface PreCrashRunningAttempt {
  readonly opIndex: number;
  readonly iteration: number;
  readonly attempt: number;
  readonly logicalEffectId: string;
  readonly startedAtMs: number;
}

export interface RecoveredCheckpointAnchor {
  readonly checkpointId: number;
  readonly throughEventId: number;
  readonly checkpointSchemaVersion: number;
  readonly createdAtMs: number;
}

export interface RecoveredExecutionFrontier {
  readonly runId: string;
  readonly runStatus: DurableRunStatus;
  readonly compiledPlanId: number;
  readonly executionIr: RecoveryExecutionIrV1;
  readonly checkpoint: RecoveredCheckpointAnchor | null;
  readonly replayedThroughEventId: number;
  readonly frontierEventsApplied: number;
  readonly ops: readonly RecoveredOpFrontier[];
  readonly controlEdges: readonly RecoveredControlEdgeFrontier[];
  readonly routerSelections: readonly RecoveredRouterSelection[];
  readonly readyQueue: readonly RecoveredReadyEntry[];
  readonly preCrashRunningAttempts: readonly PreCrashRunningAttempt[];
}

interface MutableOpFrontier {
  opIndex: number;
  iteration: number;
  status: DurableCheckpointOpStatus;
  remainingDependencies: number;
  attemptsStarted: number;
  attemptBudgetUsed: number;
  readyOrder: number | null;
  retryNotBeforeMs: number | null;
}

interface MutableControlEdgeFrontier {
  edgeIndex: number;
  iteration: number;
  status: "unresolved" | DurableCheckpointControlEdgeStatus;
}

type SqliteRow = Readonly<Record<string, unknown>>;

function key(index: number, iteration: number): string {
  return `${String(index)}:${String(iteration)}`;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(row: SqliteRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Recovery row field '${field}' must be a non-empty string.`);
  }
  return value;
}

function requireInteger(row: SqliteRow, field: string, minimum = 0): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(
      `Recovery row field '${field}' must be a safe integer >= ${String(minimum)}.`,
    );
  }
  return value;
}

function nullableInteger(row: SqliteRow, field: string, minimum = 0): number | null {
  const value = row[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(
      `Recovery row field '${field}' must be null or a safe integer >= ${String(minimum)}.`,
    );
  }
  return value;
}

function parseJsonObject(json: string, label: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new TypeError(`${label} is not valid JSON.`, { cause: error });
  }
  if (!isObject(value)) {
    throw new TypeError(`${label} must decode to an object.`);
  }
  return value;
}

function parseExecutionIr(json: string): RecoveryExecutionIrV1 {
  const value = parseJsonObject(json, "Stored Execution IR");
  if (value.format !== "harness.ir/v1") {
    throw new TypeError("Stored Execution IR must use format 'harness.ir/v1'.");
  }
  if (!Array.isArray(value.ops) || !Array.isArray(value.controlEdges)) {
    throw new TypeError("Stored Execution IR must contain ops and controlEdges arrays.");
  }

  value.ops.forEach((rawOp, opIndex) => {
    if (!isObject(rawOp)) {
      throw new TypeError(`Stored Execution IR op ${String(opIndex)} must be an object.`);
    }
    if (typeof rawOp.sourceNodeId !== "string" || rawOp.sourceNodeId.length === 0) {
      throw new TypeError(`Stored Execution IR op ${String(opIndex)} has invalid sourceNodeId.`);
    }
    if (!Array.isArray(rawOp.dependencies)) {
      throw new TypeError(`Stored Execution IR op ${String(opIndex)} has invalid dependencies.`);
    }
    let previous = -1;
    for (const dependency of rawOp.dependencies) {
      if (
        typeof dependency !== "number" ||
        !Number.isSafeInteger(dependency) ||
        dependency < 0 ||
        dependency >= value.ops.length ||
        dependency === opIndex ||
        dependency <= previous
      ) {
        throw new TypeError(
          `Stored Execution IR op ${String(opIndex)} has invalid canonical dependency indexes.`,
        );
      }
      previous = dependency;
    }

    if (!isObject(rawOp.behavior)) {
      throw new TypeError(`Stored Execution IR op ${String(opIndex)} has invalid behavior.`);
    }
    if (
      typeof rawOp.behavior.executionMode !== "string" ||
      typeof rawOp.behavior.recovery !== "string"
    ) {
      throw new TypeError(
        `Stored Execution IR op ${String(opIndex)} has invalid recovery/execution behavior.`,
      );
    }
    if (rawOp.behavior.retry !== undefined) {
      if (
        !isObject(rawOp.behavior.retry) ||
        typeof rawOp.behavior.retry.maxAttempts !== "number" ||
        !Number.isSafeInteger(rawOp.behavior.retry.maxAttempts) ||
        rawOp.behavior.retry.maxAttempts < 1
      ) {
        throw new TypeError(`Stored Execution IR op ${String(opIndex)} has invalid retry policy.`);
      }
    }

    if (rawOp.control !== undefined) {
      if (!isObject(rawOp.control) || typeof rawOp.control.kind !== "string") {
        throw new TypeError(`Stored Execution IR op ${String(opIndex)} has invalid control data.`);
      }
      if (rawOp.control.kind === "router") {
        if (
          !Array.isArray(rawOp.control.branches) ||
          rawOp.control.branches.some(
            (branch) => typeof branch !== "string" || branch.length === 0,
          )
        ) {
          throw new TypeError(
            `Stored Execution IR router op ${String(opIndex)} has invalid branches.`,
          );
        }
      }
    }
  });

  value.controlEdges.forEach((rawEdge, edgeIndex) => {
    if (
      !isObject(rawEdge) ||
      !isObject(rawEdge.from) ||
      !isObject(rawEdge.to) ||
      typeof rawEdge.from.op !== "number" ||
      typeof rawEdge.to.op !== "number" ||
      !Number.isSafeInteger(rawEdge.from.op) ||
      !Number.isSafeInteger(rawEdge.to.op) ||
      rawEdge.from.op < 0 ||
      rawEdge.to.op < 0 ||
      rawEdge.from.op >= value.ops.length ||
      rawEdge.to.op >= value.ops.length
    ) {
      throw new TypeError(
        `Stored Execution IR control edge ${String(edgeIndex)} references an invalid op.`,
      );
    }
  });

  return value as RecoveryExecutionIrV1;
}

function getMaxAttempts(ir: RecoveryExecutionIrV1, opIndex: number): number {
  const op = ir.ops[opIndex];
  if (op === undefined) {
    throw new RangeError(`Recovery op index ${String(opIndex)} is unavailable.`);
  }
  return op.behavior.retry?.maxAttempts ?? 1;
}

function createFreshFrontier(ir: RecoveryExecutionIrV1): {
  readonly ops: Map<string, MutableOpFrontier>;
  readonly controlEdges: Map<string, MutableControlEdgeFrontier>;
} {
  const ops = new Map<string, MutableOpFrontier>();
  let readyOrder = 0;

  ir.ops.forEach((op, opIndex) => {
    const remainingDependencies = op.dependencies.length;
    const ready = remainingDependencies === 0;
    ops.set(key(opIndex, 0), {
      opIndex,
      iteration: 0,
      status: ready ? "ready" : "pending",
      remainingDependencies,
      attemptsStarted: 0,
      attemptBudgetUsed: 0,
      readyOrder: ready ? readyOrder : null,
      retryNotBeforeMs: null,
    });
    if (ready) {
      readyOrder += 1;
    }
  });

  const controlEdges = new Map<string, MutableControlEdgeFrontier>();
  ir.controlEdges.forEach((_edge, edgeIndex) => {
    controlEdges.set(key(edgeIndex, 0), {
      edgeIndex,
      iteration: 0,
      status: "unresolved",
    });
  });

  return { ops, controlEdges };
}

function assertOpFrontier(
  ir: RecoveryExecutionIrV1,
  state: MutableOpFrontier,
  label: string,
): void {
  const op = ir.ops[state.opIndex];
  if (op === undefined) {
    throw new RangeError(`${label} references unavailable op ${String(state.opIndex)}.`);
  }
  if (!Number.isSafeInteger(state.iteration) || state.iteration < 0) {
    throw new TypeError(`${label} has an invalid iteration.`);
  }
  if (!OP_STATUSES.has(state.status)) {
    throw new TypeError(`${label} has unknown op status '${String(state.status)}'.`);
  }
  if (
    !Number.isSafeInteger(state.remainingDependencies) ||
    state.remainingDependencies < 0 ||
    state.remainingDependencies > op.dependencies.length
  ) {
    throw new TypeError(`${label} has an invalid remaining dependency count.`);
  }
  if (
    !Number.isSafeInteger(state.attemptsStarted) ||
    state.attemptsStarted < 0 ||
    !Number.isSafeInteger(state.attemptBudgetUsed) ||
    state.attemptBudgetUsed < state.attemptsStarted
  ) {
    throw new TypeError(`${label} has invalid attempt accounting.`);
  }

  const maxAttempts = getMaxAttempts(ir, state.opIndex);
  if (state.attemptBudgetUsed > maxAttempts) {
    throw new TypeError(`${label} exceeds the Execution IR retry budget.`);
  }

  if (state.status === "ready") {
    if (
      state.readyOrder === null ||
      !Number.isSafeInteger(state.readyOrder) ||
      state.readyOrder < 0
    ) {
      throw new TypeError(`${label} ready state requires a non-negative readyOrder.`);
    }
  } else if (state.readyOrder !== null) {
    throw new TypeError(`${label} non-ready state cannot carry readyOrder.`);
  }

  if (state.status === "retry-wait") {
    if (
      state.retryNotBeforeMs === null ||
      !Number.isSafeInteger(state.retryNotBeforeMs) ||
      state.retryNotBeforeMs < 0
    ) {
      throw new TypeError(`${label} retry-wait state requires retryNotBeforeMs.`);
    }
  } else if (state.retryNotBeforeMs !== null) {
    throw new TypeError(`${label} non-retry state cannot carry retryNotBeforeMs.`);
  }

  if (
    !["pending", "skipped", "cancelled"].includes(state.status) &&
    state.remainingDependencies !== 0
  ) {
    throw new TypeError(`${label} runnable/terminal execution state requires zero dependencies.`);
  }
  if (["running", "retry-wait"].includes(state.status) && state.attemptsStarted < 1) {
    throw new TypeError(`${label} running/retry state requires at least one started attempt.`);
  }
}

function applyOpFrontier(
  ir: RecoveryExecutionIrV1,
  ops: Map<string, MutableOpFrontier>,
  state: MutableOpFrontier,
  label: string,
): void {
  assertOpFrontier(ir, state, label);
  ops.set(key(state.opIndex, state.iteration), state);
}

function assertControlEdge(
  ir: RecoveryExecutionIrV1,
  state: MutableControlEdgeFrontier,
  label: string,
): void {
  if (ir.controlEdges[state.edgeIndex] === undefined) {
    throw new RangeError(`${label} references unavailable control edge ${String(state.edgeIndex)}.`);
  }
  if (!Number.isSafeInteger(state.iteration) || state.iteration < 0) {
    throw new TypeError(`${label} has an invalid iteration.`);
  }
  if (state.status !== "unresolved" && !CONTROL_EDGE_STATUSES.has(state.status)) {
    throw new TypeError(`${label} has unknown control-edge status '${String(state.status)}'.`);
  }
}

function applyControlEdge(
  ir: RecoveryExecutionIrV1,
  controlEdges: Map<string, MutableControlEdgeFrontier>,
  state: MutableControlEdgeFrontier,
  label: string,
): void {
  assertControlEdge(ir, state, label);
  controlEdges.set(key(state.edgeIndex, state.iteration), state);
}

function assertRouterSelection(
  ir: RecoveryExecutionIrV1,
  selection: RecoveredRouterSelection,
  label: string,
): void {
  const op = ir.ops[selection.routerOpIndex];
  if (op === undefined || op.control?.kind !== "router") {
    throw new TypeError(`${label} references an op that is not a router.`);
  }
  if (!Number.isSafeInteger(selection.iteration) || selection.iteration < 0) {
    throw new TypeError(`${label} has an invalid iteration.`);
  }
  if (
    selection.branch.length === 0 ||
    op.control.branches === undefined ||
    !op.control.branches.includes(selection.branch)
  ) {
    throw new TypeError(`${label} selects undeclared router branch '${selection.branch}'.`);
  }
}

function loadCheckpoint(
  connection: DatabaseSync,
  runId: string,
  ir: RecoveryExecutionIrV1,
  ops: Map<string, MutableOpFrontier>,
  controlEdges: Map<string, MutableControlEdgeFrontier>,
  routerSelections: Map<string, RecoveredRouterSelection>,
): RecoveredCheckpointAnchor | null {
  const checkpointRow = connection
    .prepare(
      `SELECT checkpoint_id, through_event_id, checkpoint_schema_version, created_at_ms
       FROM ${RUN_CHECKPOINTS_TABLE}
       WHERE run_id = ?
       ORDER BY through_event_id DESC, checkpoint_id DESC
       LIMIT 1`,
    )
    .get(runId) as SqliteRow | undefined;

  if (checkpointRow === undefined) {
    return null;
  }

  const checkpoint: RecoveredCheckpointAnchor = Object.freeze({
    checkpointId: requireInteger(checkpointRow, "checkpoint_id", 1),
    throughEventId: requireInteger(checkpointRow, "through_event_id", 1),
    checkpointSchemaVersion: requireInteger(checkpointRow, "checkpoint_schema_version", 1),
    createdAtMs: requireInteger(checkpointRow, "created_at_ms"),
  });
  if (checkpoint.checkpointSchemaVersion !== DURABLE_CHECKPOINT_SCHEMA_VERSION) {
    throw new TypeError(
      `Unsupported checkpoint schema version ${String(checkpoint.checkpointSchemaVersion)}.`,
    );
  }

  const opRows = connection
    .prepare(
      `SELECT op_index, iteration, status, remaining_dependencies, attempts_started,
              attempt_budget_used, ready_order, retry_not_before_ms
       FROM ${CHECKPOINT_OP_FRONTIER_TABLE}
       WHERE checkpoint_id = ?
       ORDER BY op_index, iteration`,
    )
    .all(checkpoint.checkpointId) as SqliteRow[];

  for (const row of opRows) {
    const status = requireString(row, "status") as DurableCheckpointOpStatus;
    applyOpFrontier(
      ir,
      ops,
      {
        opIndex: requireInteger(row, "op_index"),
        iteration: requireInteger(row, "iteration"),
        status,
        remainingDependencies: requireInteger(row, "remaining_dependencies"),
        attemptsStarted: requireInteger(row, "attempts_started"),
        attemptBudgetUsed: requireInteger(row, "attempt_budget_used"),
        readyOrder: nullableInteger(row, "ready_order"),
        retryNotBeforeMs: nullableInteger(row, "retry_not_before_ms"),
      },
      `Checkpoint ${String(checkpoint.checkpointId)} op frontier`,
    );
  }

  const edgeRows = connection
    .prepare(
      `SELECT edge_index, iteration, status
       FROM ${CHECKPOINT_CONTROL_EDGES_TABLE}
       WHERE checkpoint_id = ?
       ORDER BY edge_index, iteration`,
    )
    .all(checkpoint.checkpointId) as SqliteRow[];

  for (const row of edgeRows) {
    applyControlEdge(
      ir,
      controlEdges,
      {
        edgeIndex: requireInteger(row, "edge_index"),
        iteration: requireInteger(row, "iteration"),
        status: requireString(row, "status") as DurableCheckpointControlEdgeStatus,
      },
      `Checkpoint ${String(checkpoint.checkpointId)} control-edge frontier`,
    );
  }

  const routerRows = connection
    .prepare(
      `SELECT router_op_index, iteration, branch
       FROM ${CHECKPOINT_ROUTER_SELECTIONS_TABLE}
       WHERE checkpoint_id = ?
       ORDER BY router_op_index, iteration`,
    )
    .all(checkpoint.checkpointId) as SqliteRow[];

  for (const row of routerRows) {
    const selection: RecoveredRouterSelection = Object.freeze({
      routerOpIndex: requireInteger(row, "router_op_index"),
      iteration: requireInteger(row, "iteration"),
      branch: requireString(row, "branch"),
    });
    assertRouterSelection(
      ir,
      selection,
      `Checkpoint ${String(checkpoint.checkpointId)} router selection`,
    );
    routerSelections.set(key(selection.routerOpIndex, selection.iteration), selection);
  }

  return checkpoint;
}

function parseOpEventPayload(
  payloadJson: string,
  opIndex: number,
  iteration: number,
): MutableOpFrontier {
  const payload = parseJsonObject(payloadJson, "Op frontier event payload");
  return {
    opIndex,
    iteration,
    status: payload.status as DurableCheckpointOpStatus,
    remainingDependencies: requireInteger(payload, "remainingDependencies"),
    attemptsStarted: requireInteger(payload, "attemptsStarted"),
    attemptBudgetUsed: requireInteger(payload, "attemptBudgetUsed"),
    readyOrder: nullableInteger(payload, "readyOrder"),
    retryNotBeforeMs: nullableInteger(payload, "retryNotBeforeMs"),
  };
}

function replayFrontierEvents(
  connection: DatabaseSync,
  runId: string,
  afterEventId: number,
  ir: RecoveryExecutionIrV1,
  ops: Map<string, MutableOpFrontier>,
  controlEdges: Map<string, MutableControlEdgeFrontier>,
  routerSelections: Map<string, RecoveredRouterSelection>,
): { readonly replayedThroughEventId: number; readonly frontierEventsApplied: number } {
  const rows = connection
    .prepare(
      `SELECT event_id, event_type, event_schema_version, op_index, iteration, attempt, payload_json
       FROM ${DURABLE_EVENTS_TABLE}
       WHERE run_id = ? AND event_id > ?
       ORDER BY event_id`,
    )
    .all(runId, afterEventId) as SqliteRow[];

  let replayedThroughEventId = afterEventId;
  let frontierEventsApplied = 0;

  for (const row of rows) {
    const eventId = requireInteger(row, "event_id", 1);
    const eventType = requireString(row, "event_type");
    const schemaVersion = requireInteger(row, "event_schema_version", 1);
    replayedThroughEventId = eventId;

    if (
      eventType !== DURABLE_OP_FRONTIER_EVENT_TYPE &&
      eventType !== DURABLE_CONTROL_EDGE_FRONTIER_EVENT_TYPE &&
      eventType !== DURABLE_ROUTER_SELECTION_EVENT_TYPE
    ) {
      continue;
    }
    if (schemaVersion !== DURABLE_FRONTIER_EVENT_SCHEMA_VERSION) {
      throw new TypeError(
        `Unsupported frontier event schema version ${String(schemaVersion)} for '${eventType}'.`,
      );
    }

    const payloadJson = requireString(row, "payload_json");
    if (eventType === DURABLE_OP_FRONTIER_EVENT_TYPE) {
      const opIndex = nullableInteger(row, "op_index");
      const iteration = nullableInteger(row, "iteration");
      if (opIndex === null || iteration === null) {
        throw new TypeError(`Frontier op event ${String(eventId)} must be op/iteration scoped.`);
      }
      const state = parseOpEventPayload(payloadJson, opIndex, iteration);
      applyOpFrontier(ir, ops, state, `Frontier op event ${String(eventId)}`);

      const attempt = nullableInteger(row, "attempt", 1);
      if (attempt !== null && attempt > state.attemptsStarted) {
        throw new TypeError(
          `Frontier op event ${String(eventId)} attempt exceeds attemptsStarted.`,
        );
      }
      frontierEventsApplied += 1;
      continue;
    }

    if (eventType === DURABLE_CONTROL_EDGE_FRONTIER_EVENT_TYPE) {
      if (
        nullableInteger(row, "op_index") !== null ||
        nullableInteger(row, "iteration") !== null ||
        nullableInteger(row, "attempt", 1) !== null
      ) {
        throw new TypeError(
          `Frontier control-edge event ${String(eventId)} must be run scoped.`,
        );
      }
      const payload = parseJsonObject(payloadJson, "Control-edge frontier event payload");
      applyControlEdge(
        ir,
        controlEdges,
        {
          edgeIndex: requireInteger(payload, "edgeIndex"),
          iteration: requireInteger(payload, "iteration"),
          status: requireString(payload, "status") as DurableCheckpointControlEdgeStatus,
        },
        `Frontier control-edge event ${String(eventId)}`,
      );
      frontierEventsApplied += 1;
      continue;
    }

    const opIndex = nullableInteger(row, "op_index");
    const iteration = nullableInteger(row, "iteration");
    if (opIndex === null || iteration === null || nullableInteger(row, "attempt", 1) !== null) {
      throw new TypeError(
        `Frontier router-selection event ${String(eventId)} must be op/iteration scoped without an attempt.`,
      );
    }
    const payload = parseJsonObject(payloadJson, "Router-selection frontier event payload");
    const selection: RecoveredRouterSelection = Object.freeze({
      routerOpIndex: opIndex,
      iteration,
      branch: requireString(payload, "branch"),
    });
    assertRouterSelection(ir, selection, `Frontier router-selection event ${String(eventId)}`);
    routerSelections.set(key(opIndex, iteration), selection);
    frontierEventsApplied += 1;
  }

  return { replayedThroughEventId, frontierEventsApplied };
}

function reconcileDurableAttempts(
  connection: DatabaseSync,
  runId: string,
  ir: RecoveryExecutionIrV1,
  ops: Map<string, MutableOpFrontier>,
): readonly PreCrashRunningAttempt[] {
  const rows = connection
    .prepare(
      `SELECT op_index, iteration, attempt, logical_effect_id, status, started_at_ms
       FROM ${NODE_ATTEMPTS_TABLE}
       WHERE run_id = ?
       ORDER BY op_index, iteration, attempt`,
    )
    .all(runId) as SqliteRow[];

  const runningByInvocation = new Set<string>();
  const preCrashRunning: PreCrashRunningAttempt[] = [];

  for (const row of rows) {
    const opIndex = requireInteger(row, "op_index");
    const iteration = requireInteger(row, "iteration");
    const attempt = requireInteger(row, "attempt", 1);
    const op = ir.ops[opIndex];
    if (op === undefined) {
      throw new RangeError(
        `Durable attempt references unavailable Execution IR op ${String(opIndex)}.`,
      );
    }

    const stateKey = key(opIndex, iteration);
    let state = ops.get(stateKey);
    if (state === undefined) {
      state = {
        opIndex,
        iteration,
        status: op.dependencies.length === 0 ? "ready" : "pending",
        remainingDependencies: op.dependencies.length,
        attemptsStarted: 0,
        attemptBudgetUsed: 0,
        readyOrder: null,
        retryNotBeforeMs: null,
      };
      ops.set(stateKey, state);
    }

    state.attemptsStarted = Math.max(state.attemptsStarted, attempt);
    state.attemptBudgetUsed = Math.max(state.attemptBudgetUsed, attempt);

    const status = requireString(row, "status");
    if (status !== "running") {
      assertOpFrontier(ir, state, `Recovered op ${stateKey}`);
      continue;
    }

    if (runningByInvocation.has(stateKey)) {
      throw new TypeError(`Multiple durable running attempts exist for op/iteration ${stateKey}.`);
    }
    if (["completed", "skipped", "failed", "cancelled"].includes(state.status)) {
      throw new TypeError(
        `Durable running attempt conflicts with terminal reconstructed op ${stateKey}.`,
      );
    }
    if (state.remainingDependencies !== 0) {
      throw new TypeError(
        `Durable running attempt for op/iteration ${stateKey} still has dependencies.`,
      );
    }

    runningByInvocation.add(stateKey);
    state.status = "running";
    state.readyOrder = null;
    state.retryNotBeforeMs = null;
    assertOpFrontier(ir, state, `Pre-crash running op ${stateKey}`);

    preCrashRunning.push(
      Object.freeze({
        opIndex,
        iteration,
        attempt,
        logicalEffectId: requireString(row, "logical_effect_id"),
        startedAtMs: requireInteger(row, "started_at_ms"),
      }),
    );
  }

  return Object.freeze(preCrashRunning);
}

function buildReadyQueue(ops: Iterable<MutableOpFrontier>): readonly RecoveredReadyEntry[] {
  const ready = [...ops]
    .filter((state) => state.status === "ready")
    .map((state) => {
      if (state.readyOrder === null) {
        throw new TypeError(
          `Recovered ready op ${key(state.opIndex, state.iteration)} is missing readyOrder.`,
        );
      }
      return Object.freeze({
        opIndex: state.opIndex,
        iteration: state.iteration,
        readyOrder: state.readyOrder,
      });
    })
    .sort(
      (left, right) =>
        left.readyOrder - right.readyOrder ||
        left.iteration - right.iteration ||
        left.opIndex - right.opIndex,
    );

  const seen = new Set<number>();
  for (const entry of ready) {
    if (seen.has(entry.readyOrder)) {
      throw new TypeError(
        `Recovered frontier has duplicate readyOrder ${String(entry.readyOrder)}.`,
      );
    }
    seen.add(entry.readyOrder);
  }
  return Object.freeze(ready);
}

function frozenOps(
  ir: RecoveryExecutionIrV1,
  ops: Map<string, MutableOpFrontier>,
): readonly RecoveredOpFrontier[] {
  const items = [...ops.values()].sort(
    (left, right) => left.iteration - right.iteration || left.opIndex - right.opIndex,
  );
  for (const item of items) {
    assertOpFrontier(ir, item, `Recovered op ${key(item.opIndex, item.iteration)}`);
  }
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

function frozenControlEdges(
  ir: RecoveryExecutionIrV1,
  controlEdges: Map<string, MutableControlEdgeFrontier>,
): readonly RecoveredControlEdgeFrontier[] {
  const items = [...controlEdges.values()].sort(
    (left, right) => left.iteration - right.iteration || left.edgeIndex - right.edgeIndex,
  );
  for (const item of items) {
    assertControlEdge(ir, item, `Recovered control edge ${key(item.edgeIndex, item.iteration)}`);
  }
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

function frozenRouterSelections(
  selections: Map<string, RecoveredRouterSelection>,
): readonly RecoveredRouterSelection[] {
  return Object.freeze(
    [...selections.values()].sort(
      (left, right) =>
        left.iteration - right.iteration || left.routerOpIndex - right.routerOpIndex,
    ),
  );
}

/**
 * Reconstruct one run's durable scheduler frontier after process restart.
 *
 * Order is authoritative and intentionally independent of wall-clock timestamps:
 * fresh immutable IR state -> latest sparse checkpoint -> recognized frontier
 * events in durable event_id order -> overlay still-running durable attempts.
 *
 * General durable events remain opaque and are ignored by this reducer. Running
 * attempts are surfaced, not classified: Phase 4.17 decides rerun/reconcile/fail
 * behavior from the op recovery policy.
 */
export function reconstructExecutionFrontier(
  connection: DatabaseSync,
  runId: string,
): RecoveredExecutionFrontier {
  if (runId.length === 0) {
    throw new TypeError("Recovery runId must not be empty.");
  }

  const runRow = connection
    .prepare(
      `SELECT r.run_id, r.status, r.compiled_plan_id, p.execution_ir_json
       FROM ${RUNS_TABLE} AS r
       JOIN ${COMPILED_PLANS_TABLE} AS p
         ON p.compiled_plan_id = r.compiled_plan_id
       WHERE r.run_id = ?`,
    )
    .get(runId) as SqliteRow | undefined;

  if (runRow === undefined) {
    throw new RangeError(`Durable run '${runId}' does not exist.`);
  }

  const runStatus = requireString(runRow, "status") as DurableRunStatus;
  if (!RUN_STATUSES.has(runStatus)) {
    throw new TypeError(`Durable run '${runId}' has unknown status '${runStatus}'.`);
  }
  const compiledPlanId = requireInteger(runRow, "compiled_plan_id", 1);
  const executionIr = parseExecutionIr(requireString(runRow, "execution_ir_json"));
  const { ops, controlEdges } = createFreshFrontier(executionIr);
  const routerSelections = new Map<string, RecoveredRouterSelection>();

  const checkpoint = loadCheckpoint(
    connection,
    runId,
    executionIr,
    ops,
    controlEdges,
    routerSelections,
  );
  const replay = replayFrontierEvents(
    connection,
    runId,
    checkpoint?.throughEventId ?? 0,
    executionIr,
    ops,
    controlEdges,
    routerSelections,
  );
  const preCrashRunningAttempts = reconcileDurableAttempts(
    connection,
    runId,
    executionIr,
    ops,
  );

  const recoveredOps = frozenOps(executionIr, ops);
  const readyQueue = buildReadyQueue(recoveredOps);

  return Object.freeze({
    runId,
    runStatus,
    compiledPlanId,
    executionIr,
    checkpoint,
    replayedThroughEventId: replay.replayedThroughEventId,
    frontierEventsApplied: replay.frontierEventsApplied,
    ops: recoveredOps,
    controlEdges: frozenControlEdges(executionIr, controlEdges),
    routerSelections: frozenRouterSelections(routerSelections),
    readyQueue,
    preCrashRunningAttempts,
  });
}
