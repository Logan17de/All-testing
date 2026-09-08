import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  SqliteDatabase,
  commitDurableNodeCompletion,
  runSqliteMigrations,
} from "@zet-harness/db";

import {
  DURABLE_FRONTIER_EVENT_SCHEMA_VERSION,
  DURABLE_OP_FRONTIER_EVENT_TYPE,
  reconstructExecutionFrontier,
} from "./runtime-recovery.js";
import { classifyPreCrashRunningAttempts } from "./runtime-recovery-policy.js";

const migrations = Object.freeze([
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  DURABLE_NODE_ATTEMPTS_MIGRATION,
  DURABLE_EVENTS_MIGRATION,
  DURABLE_CHECKPOINTS_MIGRATION,
]);

const tempDirectories: string[] = [];

function op(
  sourceNodeId: string,
  dependencies: readonly number[],
): Readonly<Record<string, unknown>> {
  return {
    sourceNodeId,
    type: "test.node",
    version: "1",
    config: {},
    inputs: [],
    dependencies,
    behavior: {
      primitiveFamily: "pure",
      determinism: "deterministic",
      effect: "none",
      idempotency: "not-applicable",
      recovery: "rerun",
      executionMode: "in-process",
      requiredCapabilities: [],
    },
  };
}

function executionIr(): Readonly<Record<string, unknown>> {
  return {
    format: "harness.ir/v1",
    graphInputs: [],
    graphOutputs: [],
    ops: [op("root", []), op("child", [0])],
    controlEdges: [],
    entrypoints: [],
    policies: { capabilities: { required: [], optional: [], deny: [] } },
  };
}

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "zet-harness-fault-recovery-"));
  tempDirectories.push(directory);
  return join(directory, "runtime.sqlite");
}

function openDatabase(path: string): SqliteDatabase {
  const database = new SqliteDatabase({ path });
  database.open();
  return database;
}

function initializeRun(path: string): SqliteDatabase {
  const database = openDatabase(path);
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
    .run(
      1,
      "sem",
      "registry",
      "harness.compiler/v1",
      "sha256",
      "ir",
      JSON.stringify(executionIr()),
      "[]",
      "[]",
      3,
    );
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

  insertRunningAttempt(database);
  return database;
}

function insertRunningAttempt(database: SqliteDatabase): void {
  const connection = database.connection();
  connection
    .prepare(
      `INSERT INTO ${NODE_INVOCATIONS_TABLE} (
         run_id, op_index, iteration, logical_effect_id, created_at_ms
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run("run-1", 0, 0, "effect-root", 6);
  connection
    .prepare(
      `INSERT INTO ${NODE_ATTEMPTS_TABLE} (
         run_id, op_index, iteration, attempt, logical_effect_id, status,
         input_refs_json, output_refs_json, error_json, usage_json,
         started_at_ms, finished_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("run-1", 0, 0, 1, "effect-root", "running", "{}", null, null, null, 7, null);
}

function completionInput(eventSchemaVersion = 1) {
  return {
    runId: "run-1",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    outputRefsJson: '{"result":"sha256:committed-output"}',
    usageJson: '{"tokens":7}',
    finishedAtMs: 8,
    terminalEvent: {
      eventType: "op.completed",
      eventSchemaVersion,
      occurredAtMs: 9,
      payloadJson: '{"opIndex":0}',
    },
  };
}

function appendOpFrontier(
  database: SqliteDatabase,
  opIndex: number,
  status: "completed" | "ready",
): void {
  const runningAccounting = status === "completed";
  database
    .connection()
    .prepare(
      `INSERT INTO ${DURABLE_EVENTS_TABLE} (
         run_id, event_type, event_schema_version, op_index, iteration,
         attempt, occurred_at_ms, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "run-1",
      DURABLE_OP_FRONTIER_EVENT_TYPE,
      DURABLE_FRONTIER_EVENT_SCHEMA_VERSION,
      opIndex,
      0,
      runningAccounting ? 1 : null,
      10 + opIndex,
      JSON.stringify({
        status,
        remainingDependencies: 0,
        attemptsStarted: runningAccounting ? 1 : 0,
        attemptBudgetUsed: runningAccounting ? 1 : 0,
        readyOrder: status === "ready" ? 0 : null,
        retryNotBeforeMs: null,
      }),
    );
}

function readAttempt(database: SqliteDatabase): Readonly<Record<string, unknown>> | undefined {
  return database
    .connection()
    .prepare(
      `SELECT
         status,
         output_refs_json AS outputRefsJson,
         usage_json AS usageJson,
         finished_at_ms AS finishedAtMs
       FROM ${NODE_ATTEMPTS_TABLE}
       WHERE run_id = 'run-1' AND op_index = 0 AND iteration = 0 AND attempt = 1`,
    )
    .get();
}

function closeAndReopen(database: SqliteDatabase, path: string): SqliteDatabase {
  database.close();
  return openDatabase(path);
}

function seededCut(seed: number): 0 | 1 | 2 {
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (Math.abs(value) % 3) as 0 | 1 | 2;
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("runtime kill/restart fault injection", () => {
  it("recovers a pre-commit crash as one uncertain running attempt classified for rerun", () => {
    const path = createDatabasePath();
    let database = initializeRun(path);

    database = closeAndReopen(database, path);
    try {
      const frontier = reconstructExecutionFrontier(database.connection(), "run-1");

      expect(frontier.ops.map(({ status }) => status)).toEqual(["running", "pending"]);
      expect(frontier.readyQueue).toEqual([]);
      expect(classifyPreCrashRunningAttempts(frontier)).toEqual([
        {
          opIndex: 0,
          iteration: 0,
          attempt: 1,
          logicalEffectId: "effect-root",
          startedAtMs: 7,
          sourceNodeId: "root",
          recoveryPolicy: "rerun",
          action: "rerun",
        },
      ]);
      expect(readAttempt(database)).toEqual({
        status: "running",
        outputRefsJson: null,
        usageJson: null,
        finishedAtMs: null,
      });
    } finally {
      database.close();
    }
  });

  it("preserves rollback across restart when failure is injected inside the atomic completion commit", async () => {
    const path = createDatabasePath();
    let database = initializeRun(path);

    await expect(commitDurableNodeCompletion(database, completionInput(0))).rejects.toThrow();
    database = closeAndReopen(database, path);

    try {
      expect(readAttempt(database)).toEqual({
        status: "running",
        outputRefsJson: null,
        usageJson: null,
        finishedAtMs: null,
      });
      expect(
        database
          .connection()
          .prepare(`SELECT count(*) AS count FROM ${DURABLE_EVENTS_TABLE} WHERE run_id = 'run-1'`)
          .get(),
      ).toEqual({ count: 0 });

      const frontier = reconstructExecutionFrontier(database.connection(), "run-1");
      expect(classifyPreCrashRunningAttempts(frontier)[0]).toMatchObject({
        sourceNodeId: "root",
        action: "rerun",
      });
    } finally {
      database.close();
    }
  });

  it("keeps committed output durable after restart without prematurely admitting downstream work", async () => {
    const path = createDatabasePath();
    let database = initializeRun(path);

    await commitDurableNodeCompletion(database, completionInput());
    database = closeAndReopen(database, path);

    try {
      expect(readAttempt(database)).toEqual({
        status: "completed",
        outputRefsJson: '{"result":"sha256:committed-output"}',
        usageJson: '{"tokens":7}',
        finishedAtMs: 8,
      });
      expect(
        database
          .connection()
          .prepare(
            `SELECT event_type AS eventType, count(*) AS count
             FROM ${DURABLE_EVENTS_TABLE}
             WHERE run_id = 'run-1'
             GROUP BY event_type`,
          )
          .all(),
      ).toEqual([{ eventType: "op.completed", count: 1 }]);

      const frontier = reconstructExecutionFrontier(database.connection(), "run-1");
      expect(frontier.preCrashRunningAttempts).toEqual([]);
      expect(frontier.ops.map(({ status }) => status)).toEqual(["ready", "pending"]);
      expect(frontier.readyQueue).toEqual([{ opIndex: 0, iteration: 0, readyOrder: 0 }]);
    } finally {
      database.close();
    }
  });

  it("replays seeded crash cuts around completion and frontier publication without inventing state", async () => {
    for (let seed = 1; seed <= 36; seed += 1) {
      const path = createDatabasePath();
      let database = initializeRun(path);
      const cut = seededCut(seed);

      if (cut >= 1) {
        await commitDurableNodeCompletion(database, completionInput());
      }
      if (cut >= 2) {
        appendOpFrontier(database, 0, "completed");
        appendOpFrontier(database, 1, "ready");
      }

      database = closeAndReopen(database, path);
      try {
        const frontier = reconstructExecutionFrontier(database.connection(), "run-1");
        const attempt = readAttempt(database);

        if (cut === 0) {
          expect(attempt?.status, `seed ${String(seed)}`).toBe("running");
          expect(
            frontier.ops.map(({ status }) => status),
            `seed ${String(seed)}`,
          ).toEqual(["running", "pending"]);
          expect(classifyPreCrashRunningAttempts(frontier), `seed ${String(seed)}`).toHaveLength(1);
          continue;
        }

        expect(attempt, `seed ${String(seed)}`).toMatchObject({
          status: "completed",
          outputRefsJson: '{"result":"sha256:committed-output"}',
        });
        expect(frontier.preCrashRunningAttempts, `seed ${String(seed)}`).toEqual([]);

        if (cut === 1) {
          expect(
            frontier.ops.map(({ status }) => status),
            `seed ${String(seed)}`,
          ).toEqual(["ready", "pending"]);
          expect(frontier.readyQueue, `seed ${String(seed)}`).toEqual([
            { opIndex: 0, iteration: 0, readyOrder: 0 },
          ]);
        } else {
          expect(
            frontier.ops.map(({ status }) => status),
            `seed ${String(seed)}`,
          ).toEqual(["completed", "ready"]);
          expect(frontier.readyQueue, `seed ${String(seed)}`).toEqual([
            { opIndex: 1, iteration: 0, readyOrder: 0 },
          ]);
        }
      } finally {
        database.close();
      }
    }
  });
});
