import { describe, expect, it } from "vitest";

import {
  COMPILED_PLANS_TABLE,
  DURABLE_EVENTS_MIGRATION,
  DURABLE_EVENTS_TABLE,
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_NODE_ATTEMPTS_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  GRAPH_COMPILATIONS_TABLE,
  GRAPH_SOURCES_TABLE,
  NODE_ATTEMPTS_TABLE,
  NODE_INVOCATIONS_TABLE,
  RUNS_TABLE,
  SQLITE_MEMORY_PATH,
  SqliteDatabase,
  commitDurableNodeCompletion,
  runSqliteMigrations,
} from "./index.js";

const MIGRATIONS = Object.freeze([
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  DURABLE_NODE_ATTEMPTS_MIGRATION,
  DURABLE_EVENTS_MIGRATION,
]);

const withDatabase = async (
  run: (database: SqliteDatabase) => Promise<void> | void,
): Promise<void> => {
  const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  database.open();

  try {
    runSqliteMigrations(database.connection(), MIGRATIONS, { now: () => 1 });
    await run(database);
  } finally {
    await database.drainWrites();
    database.close();
  }
};

const createRun = (database: SqliteDatabase, suffix: string): string => {
  const connection = database.connection();
  const documentHash = `sha256:doc-${suffix}`;
  const semanticHash = `sha256:sem-${suffix}`;
  const runId = `run-${suffix}`;

  connection
    .prepare(
      `INSERT INTO ${GRAPH_SOURCES_TABLE}(
        document_hash,
        semantic_hash,
        hash_algorithm,
        graph_id,
        revision_id,
        normalized_document_json,
        canonical_semantics_json,
        created_at_ms
      ) VALUES (?, ?, 'sha256', ?, ?, '{}', '{}', 10)`,
    )
    .run(documentHash, semanticHash, `graph-${suffix}`, `rev-${suffix}`);

  const plan = connection
    .prepare(
      `INSERT INTO ${COMPILED_PLANS_TABLE}(
        semantic_hash,
        registry_hash,
        compiler_version,
        hash_algorithm,
        ir_hash,
        execution_ir_json,
        node_pins_json,
        plugin_pins_json,
        created_at_ms
      ) VALUES (?, ?, 'harness.compiler/v1', 'sha256', ?, '{}', '[]', '[]', 11)`,
    )
    .run(semanticHash, `sha256:registry-${suffix}`, `sha256:ir-${suffix}`);

  const compiledPlanId = Number(plan.lastInsertRowid);
  connection
    .prepare(
      `INSERT INTO ${GRAPH_COMPILATIONS_TABLE}(
        document_hash,
        compiled_plan_id,
        semantic_hash,
        created_at_ms
      ) VALUES (?, ?, ?, 12)`,
    )
    .run(documentHash, compiledPlanId, semanticHash);

  connection
    .prepare(
      `INSERT INTO ${RUNS_TABLE}(
        run_id,
        document_hash,
        compiled_plan_id,
        status,
        parent_run_id,
        fork_metadata_json,
        created_at_ms,
        started_at_ms,
        finished_at_ms
      ) VALUES (?, ?, ?, 'running', NULL, NULL, 20, 20, NULL)`,
    )
    .run(runId, documentHash, compiledPlanId);

  return runId;
};

const createAttempt = (
  database: SqliteDatabase,
  runId: string,
  opIndex: number,
  iteration = 0,
  attempt = 1,
): void => {
  const connection = database.connection();
  const logicalEffectId = `effect:${runId}:${opIndex}:${iteration}`;

  connection
    .prepare(
      `INSERT INTO ${NODE_INVOCATIONS_TABLE}(
        run_id,
        op_index,
        iteration,
        logical_effect_id,
        created_at_ms
      ) VALUES (?, ?, ?, ?, 21)`,
    )
    .run(runId, opIndex, iteration, logicalEffectId);

  connection
    .prepare(
      `INSERT INTO ${NODE_ATTEMPTS_TABLE}(
        run_id,
        op_index,
        iteration,
        attempt,
        logical_effect_id,
        status,
        input_refs_json,
        output_refs_json,
        error_json,
        usage_json,
        started_at_ms,
        finished_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'running', '{}', NULL, NULL, NULL, 22, NULL)`,
    )
    .run(runId, opIndex, iteration, attempt, logicalEffectId);
};

const completionInput = (runId: string, opIndex = 0) => ({
  runId,
  opIndex,
  iteration: 0,
  attempt: 1,
  outputRefsJson: `{"result":"blob:${opIndex}"}`,
  usageJson: '{"tokens":7}',
  finishedAtMs: 30 + opIndex,
  terminalEvent: {
    eventType: "op.completed",
    eventSchemaVersion: 1,
    occurredAtMs: 31 + opIndex,
    payloadJson: `{"opIndex":${opIndex}}`,
  },
});

describe("durable node completion commits", () => {
  it("atomically stores completion state, output refs, usage, and the exact attempt-scoped terminal event", async () => {
    await withDatabase(async (database) => {
      const runId = createRun(database, "completion");
      createAttempt(database, runId, 3);

      await expect(
        commitDurableNodeCompletion(database, completionInput(runId, 3)),
      ).resolves.toEqual({
        eventId: 1,
      });

      expect(
        database
          .connection()
          .prepare(
            `SELECT
               status,
               output_refs_json AS outputRefsJson,
               usage_json AS usageJson,
               finished_at_ms AS finishedAtMs
             FROM ${NODE_ATTEMPTS_TABLE}
             WHERE run_id = ? AND op_index = 3 AND iteration = 0 AND attempt = 1`,
          )
          .get(runId),
      ).toEqual({
        status: "completed",
        outputRefsJson: '{"result":"blob:3"}',
        usageJson: '{"tokens":7}',
        finishedAtMs: 33,
      });

      expect(
        database
          .connection()
          .prepare(
            `SELECT
               event_id AS eventId,
               event_type AS eventType,
               event_schema_version AS eventSchemaVersion,
               op_index AS opIndex,
               iteration,
               attempt,
               occurred_at_ms AS occurredAtMs,
               payload_json AS payloadJson
             FROM ${DURABLE_EVENTS_TABLE}
             WHERE run_id = ?`,
          )
          .get(runId),
      ).toEqual({
        eventId: 1,
        eventType: "op.completed",
        eventSchemaVersion: 1,
        opIndex: 3,
        iteration: 0,
        attempt: 1,
        occurredAtMs: 34,
        payloadJson: '{"opIndex":3}',
      });
    });
  });

  it("rolls the attempt back to running when the terminal event insert fails", async () => {
    await withDatabase(async (database) => {
      const runId = createRun(database, "event-rollback");
      createAttempt(database, runId, 0);

      const input = completionInput(runId);
      await expect(
        commitDurableNodeCompletion(database, {
          ...input,
          terminalEvent: { ...input.terminalEvent, eventSchemaVersion: 0 },
        }),
      ).rejects.toThrow();

      expect(
        database
          .connection()
          .prepare(
            `SELECT status, output_refs_json AS outputRefsJson, usage_json AS usageJson,
                    finished_at_ms AS finishedAtMs
             FROM ${NODE_ATTEMPTS_TABLE}
             WHERE run_id = ? AND op_index = 0 AND iteration = 0 AND attempt = 1`,
          )
          .get(runId),
      ).toEqual({
        status: "running",
        outputRefsJson: null,
        usageJson: null,
        finishedAtMs: null,
      });
      expect(
        database
          .connection()
          .prepare(`SELECT count(*) AS count FROM ${DURABLE_EVENTS_TABLE} WHERE run_id = ?`)
          .get(runId),
      ).toEqual({ count: 0 });
    });
  });

  it("rejects a second completion for the same attempt without appending another terminal event", async () => {
    await withDatabase(async (database) => {
      const runId = createRun(database, "duplicate");
      createAttempt(database, runId, 0);

      await commitDurableNodeCompletion(database, completionInput(runId));

      await expect(commitDurableNodeCompletion(database, completionInput(runId))).rejects.toThrow(
        "Durable node completion requires exactly one matching running attempt.",
      );

      expect(
        database
          .connection()
          .prepare(`SELECT count(*) AS count FROM ${DURABLE_EVENTS_TABLE} WHERE run_id = ?`)
          .get(runId),
      ).toEqual({ count: 1 });
    });
  });

  it("uses the serialized commit path when multiple node completions arrive together", async () => {
    await withDatabase(async (database) => {
      const runId = createRun(database, "fifo");
      createAttempt(database, runId, 0);
      createAttempt(database, runId, 1);

      const first = commitDurableNodeCompletion(database, completionInput(runId, 0));
      const second = commitDurableNodeCompletion(database, completionInput(runId, 1));

      await expect(Promise.all([first, second])).resolves.toEqual([{ eventId: 1 }, { eventId: 2 }]);

      expect(
        database
          .connection()
          .prepare(
            `SELECT event_id AS eventId, op_index AS opIndex
             FROM ${DURABLE_EVENTS_TABLE}
             WHERE run_id = ?
             ORDER BY event_id`,
          )
          .all(runId),
      ).toEqual([
        { eventId: 1, opIndex: 0 },
        { eventId: 2, opIndex: 1 },
      ]);
    });
  });
});
