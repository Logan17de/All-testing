import { afterEach, describe, expect, it } from "vitest";

import {
  DURABLE_CHECKPOINTS_MIGRATION,
  DURABLE_EVENTS_MIGRATION,
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_NODE_ATTEMPTS_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  SqliteDatabase,
  runSqliteMigrations,
} from "@zet-harness/db";

import {
  DURABLE_FRONTIER_EVENT_SCHEMA_VERSION,
  DURABLE_OP_FRONTIER_EVENT_TYPE,
  DURABLE_ROUTER_SELECTION_EVENT_TYPE,
  reconstructExecutionFrontier,
} from "./runtime-recovery.js";

const databases: SqliteDatabase[] = [];

function op(
  sourceNodeId: string,
  dependencies: readonly number[],
  options: {
    readonly maxAttempts?: number;
    readonly executionMode?: string;
    readonly recovery?: string;
    readonly control?: Readonly<Record<string, unknown>>;
  } = {},
): Readonly<Record<string, unknown>> {
  return {
    sourceNodeId,
    type: "test.node",
    version: "1",
    config: {},
    inputs: [],
    dependencies,
    behavior: {
      primitiveFamily: options.executionMode === "none" ? "control" : "pure",
      determinism: "deterministic",
      effect: "none",
      idempotency: "not-applicable",
      recovery: options.recovery ?? (options.executionMode === "none" ? "not-applicable" : "rerun"),
      executionMode: options.executionMode ?? "in-process",
      requiredCapabilities: [],
      ...(options.maxAttempts === undefined
        ? {}
        : { retry: { maxAttempts: options.maxAttempts, backoffMs: 0 } }),
    },
    ...(options.control === undefined ? {} : { control: options.control }),
  };
}

function executionIr(
  ops: readonly Readonly<Record<string, unknown>>[],
  controlEdges: readonly Readonly<Record<string, unknown>>[] = [],
): Readonly<Record<string, unknown>> {
  return {
    format: "harness.ir/v1",
    graphInputs: [],
    graphOutputs: [],
    ops,
    controlEdges,
    entrypoints: [],
    policies: { capabilities: { required: [], optional: [], deny: [] } },
  };
}

function createDatabase(ir: Readonly<Record<string, unknown>>, runId = "run-1"): SqliteDatabase {
  const database = new SqliteDatabase({ path: ":memory:" });
  database.open();
  databases.push(database);
  const connection = database.connection();
  runSqliteMigrations(connection, [
    DURABLE_GRAPH_IDENTITY_MIGRATION,
    DURABLE_RUNS_MIGRATION,
    DURABLE_NODE_ATTEMPTS_MIGRATION,
    DURABLE_EVENTS_MIGRATION,
    DURABLE_CHECKPOINTS_MIGRATION,
  ]);

  connection
    .prepare(
      `INSERT INTO graph_sources (
         document_hash, semantic_hash, hash_algorithm, graph_id, revision_id,
         normalized_document_json, canonical_semantics_json, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("doc", "sem", "sha256", "graph", "rev", "{}", "{}", 1);
  connection
    .prepare(
      `INSERT INTO compiled_plans (
         compiled_plan_id, semantic_hash, registry_hash, compiler_version,
         hash_algorithm, ir_hash, execution_ir_json, node_pins_json,
         plugin_pins_json, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(1, "sem", "registry", "harness.compiler/v1", "sha256", "ir", JSON.stringify(ir), "[]", "[]", 1);
  connection
    .prepare(
      `INSERT INTO graph_compilations (
         document_hash, compiled_plan_id, semantic_hash, created_at_ms
       ) VALUES (?, ?, ?, ?)`,
    )
    .run("doc", 1, "sem", 1);
  connection
    .prepare(
      `INSERT INTO runs (
         run_id, document_hash, compiled_plan_id, status, parent_run_id,
         fork_metadata_json, created_at_ms, started_at_ms, finished_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, "doc", 1, "running", null, null, 1, 1, null);

  return database;
}

function insertEvent(
  database: SqliteDatabase,
  input: {
    readonly type: string;
    readonly schemaVersion?: number;
    readonly opIndex?: number | null;
    readonly iteration?: number | null;
    readonly attempt?: number | null;
    readonly occurredAtMs?: number;
    readonly payload: unknown;
  },
): number {
  const connection = database.connection();
  connection
    .prepare(
      `INSERT INTO durable_events (
         run_id, event_type, event_schema_version, op_index, iteration,
         attempt, occurred_at_ms, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "run-1",
      input.type,
      input.schemaVersion ?? DURABLE_FRONTIER_EVENT_SCHEMA_VERSION,
      input.opIndex ?? null,
      input.iteration ?? null,
      input.attempt ?? null,
      input.occurredAtMs ?? 10,
      JSON.stringify(input.payload),
    );
  const row = connection.prepare("SELECT last_insert_rowid() AS id").get();
  if (typeof row?.id !== "number") {
    throw new TypeError("Expected numeric SQLite rowid in recovery test.");
  }
  return row.id;
}

function insertInvocation(database: SqliteDatabase, opIndex: number, logicalEffectId: string): void {
  database.connection()
    .prepare(
      `INSERT INTO node_invocations (
         run_id, op_index, iteration, logical_effect_id, created_at_ms
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run("run-1", opIndex, 0, logicalEffectId, 2);
}

function insertAttempt(
  database: SqliteDatabase,
  input: {
    readonly attemptId: number;
    readonly opIndex: number;
    readonly logicalEffectId: string;
    readonly status: "running" | "completed";
  },
): void {
  const completed = input.status === "completed";
  database.connection()
    .prepare(
      `INSERT INTO node_attempts (
         attempt_id, run_id, op_index, iteration, attempt, logical_effect_id,
         status, input_refs_json, output_refs_json, error_json, usage_json,
         started_at_ms, finished_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.attemptId,
      "run-1",
      input.opIndex,
      0,
      1,
      input.logicalEffectId,
      input.status,
      "{}",
      completed ? "{}" : null,
      null,
      null,
      3,
      completed ? 4 : null,
    );
}

function opPayload(
  status: string,
  input: {
    readonly remainingDependencies?: number;
    readonly attemptsStarted?: number;
    readonly attemptBudgetUsed?: number;
    readonly readyOrder?: number | null;
    readonly retryNotBeforeMs?: number | null;
  } = {},
): Readonly<Record<string, unknown>> {
  return {
    status,
    remainingDependencies: input.remainingDependencies ?? 0,
    attemptsStarted: input.attemptsStarted ?? 0,
    attemptBudgetUsed: input.attemptBudgetUsed ?? 0,
    readyOrder: input.readyOrder ?? null,
    retryNotBeforeMs: input.retryNotBeforeMs ?? null,
  };
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
});

describe("reconstructExecutionFrontier", () => {
  it("starts from immutable IR defaults and ignores unrelated durable event payloads", () => {
    const database = createDatabase(executionIr([op("root", []), op("child", [0])]));
    const unrelatedEventId = insertEvent(database, {
      type: "tool.audit",
      payload: { deliberately: "not a frontier payload" },
    });

    const recovered = reconstructExecutionFrontier(database.connection(), "run-1");

    expect(recovered.checkpoint).toBeNull();
    expect(recovered.replayedThroughEventId).toBe(unrelatedEventId);
    expect(recovered.frontierEventsApplied).toBe(0);
    expect(recovered.ops).toEqual([
      {
        opIndex: 0,
        iteration: 0,
        status: "ready",
        remainingDependencies: 0,
        attemptsStarted: 0,
        attemptBudgetUsed: 0,
        readyOrder: 0,
        retryNotBeforeMs: null,
      },
      {
        opIndex: 1,
        iteration: 0,
        status: "pending",
        remainingDependencies: 1,
        attemptsStarted: 0,
        attemptBudgetUsed: 0,
        readyOrder: null,
        retryNotBeforeMs: null,
      },
    ]);
    expect(recovered.readyQueue).toEqual([{ opIndex: 0, iteration: 0, readyOrder: 0 }]);
  });

  it("applies the latest sparse checkpoint then replays frontier events by event_id", () => {
    const database = createDatabase(
      executionIr([op("root", []), op("child", [0], { maxAttempts: 3 })]),
    );
    insertInvocation(database, 0, "effect-root");
    insertAttempt(database, {
      attemptId: 1,
      opIndex: 0,
      logicalEffectId: "effect-root",
      status: "completed",
    });

    const rootCompletedEventId = insertEvent(database, {
      type: DURABLE_OP_FRONTIER_EVENT_TYPE,
      opIndex: 0,
      iteration: 0,
      attempt: 1,
      occurredAtMs: 50,
      payload: opPayload("completed", { attemptsStarted: 1, attemptBudgetUsed: 1 }),
    });

    const connection = database.connection();
    connection
      .prepare(
        `INSERT INTO run_checkpoints (
           run_id, through_event_id, checkpoint_schema_version, created_at_ms
         ) VALUES (?, ?, ?, ?)`,
      )
      .run("run-1", rootCompletedEventId, 1, 60);
    const checkpointRow = connection.prepare("SELECT last_insert_rowid() AS id").get();
    if (typeof checkpointRow?.id !== "number") {
      throw new TypeError("Expected checkpoint id.");
    }
    const checkpointId = checkpointRow.id;
    connection
      .prepare(
        `INSERT INTO checkpoint_op_frontier (
           checkpoint_id, op_index, iteration, status, remaining_dependencies,
           attempts_started, attempt_budget_used, ready_order, retry_not_before_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      )
      .run(checkpointId, 0, 0, "completed", 0, 1, 1, null, null);
    connection
      .prepare(
        `INSERT INTO checkpoint_op_frontier (
           checkpoint_id, op_index, iteration, status, remaining_dependencies,
           attempts_started, attempt_budget_used, ready_order, retry_not_before_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      )
      .run(checkpointId, 1, 0, "ready", 0, 0, 0, 0, null);

    const unrelatedEventId = insertEvent(database, {
      type: "audit.note",
      occurredAtMs: 100,
      payload: { note: "journal order is not timestamp order" },
    });

    insertInvocation(database, 1, "effect-child");
    insertAttempt(database, {
      attemptId: 2,
      opIndex: 1,
      logicalEffectId: "effect-child",
      status: "running",
    });
    const runningEventId = insertEvent(database, {
      type: DURABLE_OP_FRONTIER_EVENT_TYPE,
      opIndex: 1,
      iteration: 0,
      attempt: 1,
      occurredAtMs: 5,
      payload: opPayload("running", { attemptsStarted: 1, attemptBudgetUsed: 1 }),
    });

    const recovered = reconstructExecutionFrontier(connection, "run-1");

    expect(recovered.checkpoint).toMatchObject({
      checkpointId,
      throughEventId: rootCompletedEventId,
      checkpointSchemaVersion: 1,
    });
    expect(unrelatedEventId).toBeLessThan(runningEventId);
    expect(recovered.replayedThroughEventId).toBe(runningEventId);
    expect(recovered.frontierEventsApplied).toBe(1);
    expect(recovered.ops.map(({ status }) => status)).toEqual(["completed", "running"]);
    expect(recovered.readyQueue).toEqual([]);
    expect(recovered.preCrashRunningAttempts).toEqual([
      {
        opIndex: 1,
        iteration: 0,
        attempt: 1,
        logicalEffectId: "effect-child",
        startedAtMs: 3,
      },
    ]);
  });

  it("overlays a durable running attempt so stale readiness can never dispatch it", () => {
    const database = createDatabase(executionIr([op("root", [], { maxAttempts: 2 })]));
    insertInvocation(database, 0, "effect-root");
    insertAttempt(database, {
      attemptId: 1,
      opIndex: 0,
      logicalEffectId: "effect-root",
      status: "running",
    });

    const recovered = reconstructExecutionFrontier(database.connection(), "run-1");

    expect(recovered.ops[0]).toMatchObject({
      status: "running",
      attemptsStarted: 1,
      attemptBudgetUsed: 1,
      readyOrder: null,
    });
    expect(recovered.readyQueue).toEqual([]);
    expect(recovered.preCrashRunningAttempts).toHaveLength(1);
  });

  it("rejects an unsupported schema version for a recognized frontier event", () => {
    const database = createDatabase(executionIr([op("root", [])]));
    insertEvent(database, {
      type: DURABLE_OP_FRONTIER_EVENT_TYPE,
      schemaVersion: 2,
      opIndex: 0,
      iteration: 0,
      payload: opPayload("ready", { readyOrder: 0 }),
    });

    expect(() => reconstructExecutionFrontier(database.connection(), "run-1")).toThrow(
      "Unsupported frontier event schema version 2",
    );
  });

  it("validates router selections against the immutable compiled IR", () => {
    const database = createDatabase(
      executionIr(
        [
          op("router", [], {
            executionMode: "none",
            control: { kind: "router", entry: "entry", branches: ["left"] },
          }),
          op("child", [0]),
        ],
        [{ from: { op: 0, port: "left" }, to: { op: 1 } }],
      ),
    );
    insertEvent(database, {
      type: DURABLE_ROUTER_SELECTION_EVENT_TYPE,
      opIndex: 0,
      iteration: 0,
      payload: { branch: "right" },
    });

    expect(() => reconstructExecutionFrontier(database.connection(), "run-1")).toThrow(
      "undeclared router branch 'right'",
    );
  });

  it("rejects duplicate final ready ordering across sparse/default state", () => {
    const database = createDatabase(executionIr([op("a", []), op("b", [])]));
    insertEvent(database, {
      type: DURABLE_OP_FRONTIER_EVENT_TYPE,
      opIndex: 1,
      iteration: 0,
      payload: opPayload("ready", { readyOrder: 0 }),
    });

    expect(() => reconstructExecutionFrontier(database.connection(), "run-1")).toThrow(
      "duplicate readyOrder 0",
    );
  });
});
