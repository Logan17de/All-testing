import { afterEach, describe, expect, it } from "vitest";

import {
  DURABLE_CHECKPOINTS_MIGRATION,
  DURABLE_EVENTS_MIGRATION,
  DURABLE_EVENTS_TABLE,
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_NODE_ATTEMPTS_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  NODE_ATTEMPTS_TABLE,
  NODE_INVOCATIONS_TABLE,
  SQLITE_MEMORY_PATH,
  SqliteDatabase,
  runSqliteMigrations,
} from "@zet-harness/db";

import {
  DURABLE_EFFECT_RECOVERY_OUTCOME_EVENT_TYPE,
  commitAmbiguousExternalWriteRecoveryOutcome,
  readAmbiguousExternalWriteRecoveryState,
} from "./runtime-effect-recovery.js";
import type { PreCrashRecoveryClassification } from "./runtime-recovery-policy.js";

const migrations = Object.freeze([
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  DURABLE_NODE_ATTEMPTS_MIGRATION,
  DURABLE_EVENTS_MIGRATION,
  DURABLE_CHECKPOINTS_MIGRATION,
]);
const databases: SqliteDatabase[] = [];

function classification(
  recoveryPolicy: "reconcile" | "manual",
  logicalEffectId = "effect-write",
): PreCrashRecoveryClassification {
  return Object.freeze({
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId,
    startedAtMs: 7,
    sourceNodeId: "write-node",
    recoveryPolicy,
    action: recoveryPolicy === "reconcile" ? "hold-for-reconciliation" : "hold-for-manual-review",
  });
}

function createDatabase(): SqliteDatabase {
  const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  databases.push(database);
  database.open();
  const connection = database.connection();
  runSqliteMigrations(connection, migrations, { now: () => 1 });

  connection
    .prepare(
      `INSERT INTO graph_sources (
         document_hash, semantic_hash, hash_algorithm, graph_id, revision_id,
         normalized_document_json, canonical_semantics_json, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("doc", "sem", "sha256", "graph", "rev", "{}", "{}", 2);
  connection
    .prepare(
      `INSERT INTO compiled_plans (
         compiled_plan_id, semantic_hash, registry_hash, compiler_version,
         hash_algorithm, ir_hash, execution_ir_json, node_pins_json,
         plugin_pins_json, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(1, "sem", "registry", "harness.compiler/v1", "sha256", "ir", "{}", "[]", "[]", 3);
  connection
    .prepare(
      `INSERT INTO graph_compilations (
         document_hash, compiled_plan_id, semantic_hash, created_at_ms
       ) VALUES (?, ?, ?, ?)`,
    )
    .run("doc", 1, "sem", 4);
  connection
    .prepare(
      `INSERT INTO runs (
         run_id, document_hash, compiled_plan_id, status, parent_run_id,
         fork_metadata_json, created_at_ms, started_at_ms, finished_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("run-1", "doc", 1, "running", null, null, 5, 5, null);
  connection
    .prepare(
      `INSERT INTO ${NODE_INVOCATIONS_TABLE} (
         run_id, op_index, iteration, logical_effect_id, created_at_ms
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run("run-1", 0, 0, "effect-write", 6);
  connection
    .prepare(
      `INSERT INTO ${NODE_ATTEMPTS_TABLE} (
         run_id, op_index, iteration, attempt, logical_effect_id, status,
         input_refs_json, output_refs_json, error_json, usage_json,
         started_at_ms, finished_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("run-1", 0, 0, 1, "effect-write", "running", "{}", null, null, null, 7, null);

  return database;
}

function eventCount(database: SqliteDatabase): number {
  const row = database
    .connection()
    .prepare(
      `SELECT count(*) AS count
       FROM ${DURABLE_EVENTS_TABLE}
       WHERE event_type = ?`,
    )
    .get(DURABLE_EFFECT_RECOVERY_OUTCOME_EVENT_TYPE);
  return Number(row?.count ?? 0);
}

function attemptStatus(database: SqliteDatabase): unknown {
  return database
    .connection()
    .prepare(
      `SELECT status
       FROM ${NODE_ATTEMPTS_TABLE}
       WHERE run_id = 'run-1' AND op_index = 0 AND iteration = 0 AND attempt = 1`,
    )
    .get()?.status;
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
});

describe("ambiguous external-write recovery outcomes", () => {
  it("starts in the policy-specific hold without inferring an outcome", () => {
    const database = createDatabase();

    const reconcileState = readAmbiguousExternalWriteRecoveryState(database.connection(), {
      runId: "run-1",
      classification: classification("reconcile"),
    });
    expect(reconcileState.nextAction).toBe("hold-for-reconciliation");
    expect(reconcileState.history).toEqual([]);
    expect(Object.isFrozen(reconcileState.history)).toBe(true);

    const manualState = readAmbiguousExternalWriteRecoveryState(database.connection(), {
      runId: "run-1",
      classification: classification("manual"),
    });
    expect(manualState.nextAction).toBe("hold-for-manual-review");
  });

  it("records confirmed-not-applied reconciliation as explicit rerun authority", async () => {
    const database = createDatabase();
    const recovery = classification("reconcile");

    const state = await commitAmbiguousExternalWriteRecoveryOutcome(database, {
      runId: "run-1",
      classification: recovery,
      resolution: {
        source: "reconciliation",
        outcome: "confirmed-not-applied",
        evidenceRefsJson: '{"probe":"blob:effect-not-found"}',
        occurredAtMs: 8,
      },
    });

    expect(state.nextAction).toBe("rerun-authorized");
    expect(state.recoveredOutputRefsJson).toBeNull();
    expect(state.history).toEqual([
      expect.objectContaining({
        source: "reconciliation",
        outcome: "confirmed-not-applied",
        disposition: "rerun-authorized",
      }),
    ]);
    expect(eventCount(database)).toBe(1);
    expect(attemptStatus(database)).toBe("running");

    await expect(
      commitAmbiguousExternalWriteRecoveryOutcome(database, {
        runId: "run-1",
        classification: recovery,
        resolution: {
          source: "reconciliation",
          outcome: "confirmed-not-applied",
          evidenceRefsJson: '{"probe":"duplicate"}',
          occurredAtMs: 9,
        },
      }),
    ).rejects.toThrow(/already final/u);
    expect(eventCount(database)).toBe(1);
  });

  it("escalates inconclusive reconciliation to manual review and survives reread", async () => {
    const database = createDatabase();
    const recovery = classification("reconcile");

    const held = await commitAmbiguousExternalWriteRecoveryOutcome(database, {
      runId: "run-1",
      classification: recovery,
      resolution: {
        source: "reconciliation",
        outcome: "inconclusive",
        evidenceRefsJson: '{"probe":"blob:ambiguous"}',
        occurredAtMs: 8,
      },
    });
    expect(held.nextAction).toBe("hold-for-manual-review");

    const resolved = await commitAmbiguousExternalWriteRecoveryOutcome(database, {
      runId: "run-1",
      classification: recovery,
      resolution: {
        source: "manual-review",
        outcome: "confirmed-applied",
        evidenceRefsJson: '{"review":"blob:operator-confirmation"}',
        outputRefsJson: '{"resource":"blob:recovered-output"}',
        occurredAtMs: 9,
      },
    });
    expect(resolved.nextAction).toBe("complete-with-recovered-output");
    expect(resolved.recoveredOutputRefsJson).toBe('{"resource":"blob:recovered-output"}');
    expect(resolved.history).toHaveLength(2);
    expect(attemptStatus(database)).toBe("running");

    const reread = readAmbiguousExternalWriteRecoveryState(database.connection(), {
      runId: "run-1",
      classification: recovery,
    });
    expect(reread).toEqual(resolved);
  });

  it("supports direct manual abandonment as an explicit failure disposition", async () => {
    const database = createDatabase();
    const recovery = classification("manual");

    const state = await commitAmbiguousExternalWriteRecoveryOutcome(database, {
      runId: "run-1",
      classification: recovery,
      resolution: {
        source: "manual-review",
        outcome: "abandoned",
        evidenceRefsJson: '{"review":"blob:abort-decision"}',
        occurredAtMs: 8,
      },
    });

    expect(state.nextAction).toBe("fail");
    expect(eventCount(database)).toBe(1);
    expect(attemptStatus(database)).toBe("running");
  });

  it("rejects source jumps, malformed outcome data, and mismatched durable identity", async () => {
    const database = createDatabase();
    const reconcile = classification("reconcile");

    await expect(
      commitAmbiguousExternalWriteRecoveryOutcome(database, {
        runId: "run-1",
        classification: reconcile,
        resolution: {
          source: "manual-review",
          outcome: "abandoned",
          evidenceRefsJson: "{}",
          occurredAtMs: 8,
        },
      }),
    ).rejects.toThrow(/requires reconciliation/u);

    await expect(
      commitAmbiguousExternalWriteRecoveryOutcome(database, {
        runId: "run-1",
        classification: reconcile,
        resolution: {
          source: "reconciliation",
          outcome: "confirmed-applied",
          evidenceRefsJson: "{}",
          occurredAtMs: 8,
        },
      }),
    ).rejects.toThrow(/requires recovered outputRefsJson/u);

    await expect(
      commitAmbiguousExternalWriteRecoveryOutcome(database, {
        runId: "run-1",
        classification: reconcile,
        resolution: {
          source: "reconciliation",
          outcome: "confirmed-not-applied",
          evidenceRefsJson: "not-json",
          occurredAtMs: 8,
        },
      }),
    ).rejects.toThrow(/evidenceRefsJson must be valid JSON text/u);

    await expect(
      commitAmbiguousExternalWriteRecoveryOutcome(database, {
        runId: "run-1",
        classification: classification("reconcile", "wrong-effect"),
        resolution: {
          source: "reconciliation",
          outcome: "confirmed-not-applied",
          evidenceRefsJson: "{}",
          occurredAtMs: 8,
        },
      }),
    ).rejects.toThrow(/logical effect identity does not match/u);

    expect(eventCount(database)).toBe(0);
  });
});
