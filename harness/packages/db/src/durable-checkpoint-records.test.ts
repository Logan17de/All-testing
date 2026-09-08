import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_CONTROL_EDGES_TABLE,
  CHECKPOINT_OP_FRONTIER_TABLE,
  CHECKPOINT_ROUTER_SELECTIONS_TABLE,
  COMPILED_PLANS_TABLE,
  DURABLE_CHECKPOINTS_MIGRATION,
  DURABLE_EVENTS_MIGRATION,
  DURABLE_EVENTS_TABLE,
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_NODE_ATTEMPTS_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  GRAPH_COMPILATIONS_TABLE,
  GRAPH_SOURCES_TABLE,
  RUN_CHECKPOINTS_TABLE,
  RUNS_TABLE,
  runSqliteMigrations,
} from "./index.js";

const MIGRATIONS = Object.freeze([
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  DURABLE_NODE_ATTEMPTS_MIGRATION,
  DURABLE_EVENTS_MIGRATION,
  DURABLE_CHECKPOINTS_MIGRATION,
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

const appendEvent = (connection: DatabaseSync, runId: string, occurredAtMs = 30): number => {
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
      ) VALUES (?, 'runtime.checkpointable', 1, NULL, NULL, NULL, ?, '{}')`,
    )
    .run(runId, occurredAtMs);

  return Number(result.lastInsertRowid);
};

const createCheckpoint = (
  connection: DatabaseSync,
  runId: string,
  throughEventId: number,
  createdAtMs = 40,
): number => {
  const result = connection
    .prepare(
      `INSERT INTO ${RUN_CHECKPOINTS_TABLE}(
        run_id,
        through_event_id,
        checkpoint_schema_version,
        created_at_ms
      ) VALUES (?, ?, 1, ?)`,
    )
    .run(runId, throughEventId, createdAtMs);

  return Number(result.lastInsertRowid);
};

const insertOpFrontier = (
  connection: DatabaseSync,
  input: {
    readonly checkpointId: number;
    readonly opIndex: number;
    readonly iteration?: number;
    readonly status: string;
    readonly remainingDependencies?: number;
    readonly attemptsStarted?: number;
    readonly attemptBudgetUsed?: number;
    readonly readyOrder?: number | null;
    readonly retryNotBeforeMs?: number | null;
  },
): void => {
  connection
    .prepare(
      `INSERT INTO ${CHECKPOINT_OP_FRONTIER_TABLE}(
        checkpoint_id,
        op_index,
        iteration,
        status,
        remaining_dependencies,
        attempts_started,
        attempt_budget_used,
        ready_order,
        retry_not_before_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.checkpointId,
      input.opIndex,
      input.iteration ?? 0,
      input.status,
      input.remainingDependencies ?? 0,
      input.attemptsStarted ?? 0,
      input.attemptBudgetUsed ?? 0,
      input.readyOrder ?? null,
      input.retryNotBeforeMs ?? null,
    );
};

describe("durable checkpoint records", () => {
  it("installs sparse checkpoint/frontier storage as migration 5", () => {
    withDatabase((connection) => {
      expect(
        connection
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?) ORDER BY name",
          )
          .all(
            CHECKPOINT_CONTROL_EDGES_TABLE,
            CHECKPOINT_OP_FRONTIER_TABLE,
            CHECKPOINT_ROUTER_SELECTIONS_TABLE,
            RUN_CHECKPOINTS_TABLE,
          ),
      ).toEqual([
        { name: CHECKPOINT_CONTROL_EDGES_TABLE },
        { name: CHECKPOINT_OP_FRONTIER_TABLE },
        { name: CHECKPOINT_ROUTER_SELECTIONS_TABLE },
        { name: RUN_CHECKPOINTS_TABLE },
      ]);

      expect(
        connection.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toEqual([
        { version: 1, name: "durable_graph_and_compiled_plan_identity" },
        { version: 2, name: "durable_runs_and_fork_lineage" },
        { version: 3, name: "durable_node_attempts_and_effect_identity" },
        { version: 4, name: "append_only_versioned_durable_events" },
        { version: 5, name: "sparse_checkpoint_frontier_state" },
      ]);
    });
  });

  it("anchors each checkpoint to an event cursor from the same run", () => {
    withDatabase((connection) => {
      const firstRunId = createRun(connection, "checkpoint-a");
      const secondRunId = createRun(connection, "checkpoint-b");
      const firstEventId = appendEvent(connection, firstRunId);
      const secondEventId = appendEvent(connection, secondRunId);

      expect(createCheckpoint(connection, firstRunId, firstEventId)).toBe(1);
      expect(() => createCheckpoint(connection, firstRunId, secondEventId)).toThrow();
      expect(() => createCheckpoint(connection, firstRunId, firstEventId)).toThrow();
    });
  });

  it("stores only changed op frontier entries with deterministic ready and retry state", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "frontier");
      const checkpointId = createCheckpoint(connection, runId, appendEvent(connection, runId));

      insertOpFrontier(connection, {
        checkpointId,
        opIndex: 2,
        status: "pending",
        remainingDependencies: 1,
      });
      insertOpFrontier(connection, {
        checkpointId,
        opIndex: 4,
        status: "ready",
        readyOrder: 0,
      });
      insertOpFrontier(connection, {
        checkpointId,
        opIndex: 7,
        status: "retry-wait",
        attemptsStarted: 1,
        attemptBudgetUsed: 2,
        retryNotBeforeMs: 500,
      });

      expect(
        connection
          .prepare(
            `SELECT
               op_index AS opIndex,
               status,
               remaining_dependencies AS remainingDependencies,
               attempts_started AS attemptsStarted,
               attempt_budget_used AS attemptBudgetUsed,
               ready_order AS readyOrder,
               retry_not_before_ms AS retryNotBeforeMs
             FROM ${CHECKPOINT_OP_FRONTIER_TABLE}
             WHERE checkpoint_id = ?
             ORDER BY op_index`,
          )
          .all(checkpointId),
      ).toEqual([
        {
          opIndex: 2,
          status: "pending",
          remainingDependencies: 1,
          attemptsStarted: 0,
          attemptBudgetUsed: 0,
          readyOrder: null,
          retryNotBeforeMs: null,
        },
        {
          opIndex: 4,
          status: "ready",
          remainingDependencies: 0,
          attemptsStarted: 0,
          attemptBudgetUsed: 0,
          readyOrder: 0,
          retryNotBeforeMs: null,
        },
        {
          opIndex: 7,
          status: "retry-wait",
          remainingDependencies: 0,
          attemptsStarted: 1,
          attemptBudgetUsed: 2,
          readyOrder: null,
          retryNotBeforeMs: 500,
        },
      ]);
    });
  });

  it("rejects malformed op frontier invariants", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "invalid-frontier");
      const checkpointId = createCheckpoint(connection, runId, appendEvent(connection, runId));

      expect(() =>
        insertOpFrontier(connection, { checkpointId, opIndex: 0, status: "ready" }),
      ).toThrow();
      expect(() =>
        insertOpFrontier(connection, {
          checkpointId,
          opIndex: 1,
          status: "pending",
          readyOrder: 0,
        }),
      ).toThrow();
      expect(() =>
        insertOpFrontier(connection, {
          checkpointId,
          opIndex: 2,
          status: "retry-wait",
          attemptsStarted: 1,
          attemptBudgetUsed: 1,
        }),
      ).toThrow();
      expect(() =>
        insertOpFrontier(connection, {
          checkpointId,
          opIndex: 3,
          status: "completed",
          remainingDependencies: 1,
        }),
      ).toThrow();
      expect(() =>
        insertOpFrontier(connection, {
          checkpointId,
          opIndex: 4,
          status: "running",
        }),
      ).toThrow();
      expect(() =>
        insertOpFrontier(connection, {
          checkpointId,
          opIndex: 5,
          status: "completed",
          attemptsStarted: 2,
          attemptBudgetUsed: 1,
        }),
      ).toThrow();

      insertOpFrontier(connection, {
        checkpointId,
        opIndex: 6,
        status: "ready",
        readyOrder: 0,
      });
      expect(() =>
        insertOpFrontier(connection, {
          checkpointId,
          opIndex: 7,
          status: "ready",
          readyOrder: 0,
        }),
      ).toThrow();
    });
  });

  it("stores non-default control-edge state and explicit router selections", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "control-frontier");
      const checkpointId = createCheckpoint(connection, runId, appendEvent(connection, runId));

      connection
        .prepare(
          `INSERT INTO ${CHECKPOINT_CONTROL_EDGES_TABLE}(
            checkpoint_id,
            edge_index,
            iteration,
            status
          ) VALUES (?, 3, 0, 'completed')`,
        )
        .run(checkpointId);
      connection
        .prepare(
          `INSERT INTO ${CHECKPOINT_ROUTER_SELECTIONS_TABLE}(
            checkpoint_id,
            router_op_index,
            iteration,
            branch
          ) VALUES (?, 2, 0, 'success')`,
        )
        .run(checkpointId);

      expect(
        connection
          .prepare(
            `SELECT edge_index AS edgeIndex, status
             FROM ${CHECKPOINT_CONTROL_EDGES_TABLE}
             WHERE checkpoint_id = ?`,
          )
          .get(checkpointId),
      ).toEqual({ edgeIndex: 3, status: "completed" });
      expect(
        connection
          .prepare(
            `SELECT router_op_index AS routerOpIndex, branch
             FROM ${CHECKPOINT_ROUTER_SELECTIONS_TABLE}
             WHERE checkpoint_id = ?`,
          )
          .get(checkpointId),
      ).toEqual({ routerOpIndex: 2, branch: "success" });

      expect(() =>
        connection
          .prepare(
            `INSERT INTO ${CHECKPOINT_CONTROL_EDGES_TABLE}(
              checkpoint_id,
              edge_index,
              iteration,
              status
            ) VALUES (?, 4, 0, 'unresolved')`,
          )
          .run(checkpointId),
      ).toThrow();
      expect(() =>
        connection
          .prepare(
            `INSERT INTO ${CHECKPOINT_ROUTER_SELECTIONS_TABLE}(
              checkpoint_id,
              router_op_index,
              iteration,
              branch
            ) VALUES (?, 5, 0, '')`,
          )
          .run(checkpointId),
      ).toThrow();
    });
  });

  it("keeps checkpoint headers and frontier rows append-only", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "append-only");
      const checkpointId = createCheckpoint(connection, runId, appendEvent(connection, runId));
      insertOpFrontier(connection, {
        checkpointId,
        opIndex: 1,
        status: "ready",
        readyOrder: 0,
      });

      expect(() =>
        connection
          .prepare(
            `UPDATE ${RUN_CHECKPOINTS_TABLE}
             SET checkpoint_schema_version = 2
             WHERE checkpoint_id = ?`,
          )
          .run(checkpointId),
      ).toThrow("run_checkpoints is append-only");
      expect(() =>
        connection
          .prepare(
            `DELETE FROM ${CHECKPOINT_OP_FRONTIER_TABLE}
             WHERE checkpoint_id = ? AND op_index = 1 AND iteration = 0`,
          )
          .run(checkpointId),
      ).toThrow("checkpoint_op_frontier is append-only");
    });
  });
});
