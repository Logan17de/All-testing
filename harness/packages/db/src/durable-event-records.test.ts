import { DatabaseSync } from "node:sqlite";

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
  runSqliteMigrations,
} from "./index.js";

const MIGRATIONS = Object.freeze([
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  DURABLE_NODE_ATTEMPTS_MIGRATION,
  DURABLE_EVENTS_MIGRATION,
]);

const withDatabase = (run: (connection: DatabaseSync) => void): void => {
  const connection = new DatabaseSync(":memory:", {
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });

  try {
    runSqliteMigrations(connection, MIGRATIONS, { now: () => 1 });
    run(connection);
  } finally {
    connection.close();
  }
};

const createRun = (connection: DatabaseSync, suffix: string): string => {
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
  connection: DatabaseSync,
  runId: string,
  opIndex = 0,
  iteration = 0,
  attempt = 1,
): void => {
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

const appendEvent = (
  connection: DatabaseSync,
  input: {
    readonly runId: string;
    readonly eventType?: string;
    readonly eventSchemaVersion?: number;
    readonly opIndex?: number | null;
    readonly iteration?: number | null;
    readonly attempt?: number | null;
    readonly occurredAtMs?: number;
    readonly payloadJson?: string;
  },
): number => {
  const result = connection
    .prepare(
      `INSERT INTO ${DURABLE_EVENTS_TABLE}(
        run_id,
        event_type,
        event_schema_version,
        op_index,
        iteration,
        attempt,
        occurred_at_ms,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.eventType ?? "run.started",
      input.eventSchemaVersion ?? 1,
      input.opIndex ?? null,
      input.iteration ?? null,
      input.attempt ?? null,
      input.occurredAtMs ?? 23,
      input.payloadJson ?? "{}",
    );

  return Number(result.lastInsertRowid);
};

describe("durable event records", () => {
  it("installs the append-only event journal as migration 4", () => {
    withDatabase((connection) => {
      expect(
        connection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(DURABLE_EVENTS_TABLE),
      ).toEqual({ name: DURABLE_EVENTS_TABLE });

      expect(
        connection.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toEqual([
        { version: 1, name: "durable_graph_and_compiled_plan_identity" },
        { version: 2, name: "durable_runs_and_fork_lineage" },
        { version: 3, name: "durable_node_attempts_and_effect_identity" },
        { version: 4, name: "append_only_versioned_durable_events" },
      ]);
    });
  });

  it("uses database-generated global event IDs as the journal order", () => {
    withDatabase((connection) => {
      const firstRunId = createRun(connection, "events-a");
      const secondRunId = createRun(connection, "events-b");

      expect(
        appendEvent(connection, { runId: firstRunId, occurredAtMs: 100 }),
      ).toBe(1);
      expect(
        appendEvent(connection, { runId: secondRunId, occurredAtMs: 1 }),
      ).toBe(2);
      expect(
        appendEvent(connection, { runId: firstRunId, occurredAtMs: 50 }),
      ).toBe(3);

      expect(
        connection
          .prepare(
            `SELECT event_id AS eventId, run_id AS runId, occurred_at_ms AS occurredAtMs
             FROM ${DURABLE_EVENTS_TABLE}
             ORDER BY event_id`,
          )
          .all(),
      ).toEqual([
        { eventId: 1, runId: firstRunId, occurredAtMs: 100 },
        { eventId: 2, runId: secondRunId, occurredAtMs: 1 },
        { eventId: 3, runId: firstRunId, occurredAtMs: 50 },
      ]);
    });
  });

  it("stores explicit event schema versions independently from event type", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "schema-version");
      appendEvent(connection, {
        runId,
        eventType: "op.completed",
        eventSchemaVersion: 1,
        payloadJson: '{"shape":"v1"}',
      });
      appendEvent(connection, {
        runId,
        eventType: "op.completed",
        eventSchemaVersion: 2,
        payloadJson: '{"shape":"v2"}',
      });

      expect(
        connection
          .prepare(
            `SELECT
               event_type AS eventType,
               event_schema_version AS eventSchemaVersion,
               payload_json AS payloadJson
             FROM ${DURABLE_EVENTS_TABLE}
             WHERE run_id = ?
             ORDER BY event_id`,
          )
          .all(runId),
      ).toEqual([
        {
          eventType: "op.completed",
          eventSchemaVersion: 1,
          payloadJson: '{"shape":"v1"}',
        },
        {
          eventType: "op.completed",
          eventSchemaVersion: 2,
          payloadJson: '{"shape":"v2"}',
        },
      ]);
    });
  });

  it("supports run, op/iteration, and concrete-attempt event scopes", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "scope");
      createAttempt(connection, runId, 4, 2, 1);

      appendEvent(connection, { runId, eventType: "run.started" });
      appendEvent(connection, {
        runId,
        eventType: "op.ready",
        opIndex: 4,
        iteration: 2,
      });
      appendEvent(connection, {
        runId,
        eventType: "op.attempt.started",
        opIndex: 4,
        iteration: 2,
        attempt: 1,
      });

      expect(
        connection
          .prepare(
            `SELECT
               event_type AS eventType,
               op_index AS opIndex,
               iteration,
               attempt
             FROM ${DURABLE_EVENTS_TABLE}
             WHERE run_id = ?
             ORDER BY event_id`,
          )
          .all(runId),
      ).toEqual([
        {
          eventType: "run.started",
          opIndex: null,
          iteration: null,
          attempt: null,
        },
        { eventType: "op.ready", opIndex: 4, iteration: 2, attempt: null },
        {
          eventType: "op.attempt.started",
          opIndex: 4,
          iteration: 2,
          attempt: 1,
        },
      ]);
    });
  });

  it("rejects malformed scope tuples and missing concrete attempts", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "scope-invalid");

      expect(() => appendEvent(connection, { runId, iteration: 0 })).toThrow();
      expect(() => appendEvent(connection, { runId, opIndex: 0 })).toThrow();
      expect(() => appendEvent(connection, { runId, attempt: 1 })).toThrow();
      expect(() =>
        appendEvent(connection, { runId, opIndex: 0, iteration: 0, attempt: 1 }),
      ).toThrow();
    });
  });

  it("rejects invalid envelope values and unknown runs", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "envelope");

      expect(() => appendEvent(connection, { runId, eventType: "" })).toThrow();
      expect(() =>
        appendEvent(connection, { runId, eventSchemaVersion: 0 }),
      ).toThrow();
      expect(() => appendEvent(connection, { runId, occurredAtMs: -1 })).toThrow();
      expect(() => appendEvent(connection, { runId, payloadJson: "" })).toThrow();
      expect(() => appendEvent(connection, { runId: "missing-run" })).toThrow();
    });
  });

  it("rejects updates and deletes so committed events remain append-only", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "append-only");
      const eventId = appendEvent(connection, {
        runId,
        payloadJson: '{"value":1}',
      });

      expect(() =>
        connection
          .prepare(
            `UPDATE ${DURABLE_EVENTS_TABLE} SET payload_json = '{"value":2}' WHERE event_id = ?`,
          )
          .run(eventId),
      ).toThrow("durable_events is append-only");
      expect(() =>
        connection
          .prepare(`DELETE FROM ${DURABLE_EVENTS_TABLE} WHERE event_id = ?`)
          .run(eventId),
      ).toThrow("durable_events is append-only");

      expect(
        connection
          .prepare(
            `SELECT payload_json AS payloadJson FROM ${DURABLE_EVENTS_TABLE} WHERE event_id = ?`,
          )
          .get(eventId),
      ).toEqual({ payloadJson: '{"value":1}' });
    });
  });
});
