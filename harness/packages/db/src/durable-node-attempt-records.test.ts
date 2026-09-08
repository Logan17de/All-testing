import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  COMPILED_PLANS_TABLE,
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

const withDatabase = (run: (connection: DatabaseSync) => void): void => {
  const connection = new DatabaseSync(":memory:", {
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });

  try {
    runSqliteMigrations(
      connection,
      [DURABLE_GRAPH_IDENTITY_MIGRATION, DURABLE_RUNS_MIGRATION, DURABLE_NODE_ATTEMPTS_MIGRATION],
      { now: () => 1 },
    );
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

const insertInvocation = (
  connection: DatabaseSync,
  runId: string,
  opIndex: number,
  iteration: number,
  logicalEffectId: string,
): void => {
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
};

const insertAttempt = (
  connection: DatabaseSync,
  input: {
    readonly runId: string;
    readonly opIndex?: number;
    readonly iteration?: number;
    readonly attempt?: number;
    readonly logicalEffectId: string;
    readonly status?: string;
    readonly inputRefsJson?: string;
    readonly outputRefsJson?: string | null;
    readonly errorJson?: string | null;
    readonly usageJson?: string | null;
    readonly startedAtMs?: number;
    readonly finishedAtMs?: number | null;
  },
): void => {
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.opIndex ?? 0,
      input.iteration ?? 0,
      input.attempt ?? 1,
      input.logicalEffectId,
      input.status ?? "running",
      input.inputRefsJson ?? "{}",
      input.outputRefsJson ?? null,
      input.errorJson ?? null,
      input.usageJson ?? null,
      input.startedAtMs ?? 22,
      input.finishedAtMs ?? null,
    );
};

describe("durable node attempt records", () => {
  it("installs logical invocation and attempt identity as migration 3", () => {
    withDatabase((connection) => {
      expect(
        connection
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?) ORDER BY name",
          )
          .all(NODE_ATTEMPTS_TABLE, NODE_INVOCATIONS_TABLE),
      ).toEqual([{ name: NODE_ATTEMPTS_TABLE }, { name: NODE_INVOCATIONS_TABLE }]);

      expect(
        connection.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toEqual([
        { version: 1, name: "durable_graph_and_compiled_plan_identity" },
        { version: 2, name: "durable_runs_and_fork_lineage" },
        { version: 3, name: "durable_node_attempts_and_effect_identity" },
      ]);
    });
  });

  it("keeps one logical effect identity stable across retry attempts", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "retry");
      insertInvocation(connection, runId, 4, 2, "effect:retry:4:2");

      insertAttempt(connection, {
        runId,
        opIndex: 4,
        iteration: 2,
        attempt: 1,
        logicalEffectId: "effect:retry:4:2",
        status: "failed",
        errorJson: '{"code":"TRANSIENT"}',
        usageJson: '{"tokens":3}',
        finishedAtMs: 25,
      });
      insertAttempt(connection, {
        runId,
        opIndex: 4,
        iteration: 2,
        attempt: 2,
        logicalEffectId: "effect:retry:4:2",
        status: "completed",
        outputRefsJson: '{"result":"inline:ok"}',
        usageJson: '{"tokens":5}',
        startedAtMs: 30,
        finishedAtMs: 35,
      });

      expect(
        connection
          .prepare(
            `SELECT
               attempt,
               logical_effect_id AS logicalEffectId,
               status,
               output_refs_json AS outputRefsJson,
               error_json AS errorJson,
               usage_json AS usageJson
             FROM ${NODE_ATTEMPTS_TABLE}
             WHERE run_id = ? AND op_index = 4 AND iteration = 2
             ORDER BY attempt`,
          )
          .all(runId),
      ).toEqual([
        {
          attempt: 1,
          logicalEffectId: "effect:retry:4:2",
          status: "failed",
          outputRefsJson: null,
          errorJson: '{"code":"TRANSIENT"}',
          usageJson: '{"tokens":3}',
        },
        {
          attempt: 2,
          logicalEffectId: "effect:retry:4:2",
          status: "completed",
          outputRefsJson: '{"result":"inline:ok"}',
          errorJson: null,
          usageJson: '{"tokens":5}',
        },
      ]);
    });
  });

  it("rejects a retry that changes the logical effect identity", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "stable-id");
      insertInvocation(connection, runId, 0, 0, "effect:stable");
      insertAttempt(connection, { runId, logicalEffectId: "effect:stable" });

      expect(() =>
        insertAttempt(connection, {
          runId,
          attempt: 2,
          logicalEffectId: "effect:different",
        }),
      ).toThrow();
    });
  });

  it("rejects reusing one logical effect identity for another invocation", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "effect-reuse");
      insertInvocation(connection, runId, 0, 0, "effect:unique");

      expect(() => insertInvocation(connection, runId, 0, 1, "effect:unique")).toThrow();
    });
  });

  it("does not define cross-run replay/fork effect identity semantics", () => {
    withDatabase((connection) => {
      const firstRunId = createRun(connection, "effect-run-a");
      const secondRunId = createRun(connection, "effect-run-b");

      insertInvocation(connection, firstRunId, 0, 0, "effect:portable");
      insertInvocation(connection, secondRunId, 0, 0, "effect:portable");

      expect(
        connection
          .prepare(
            `SELECT run_id AS runId
             FROM ${NODE_INVOCATIONS_TABLE}
             WHERE logical_effect_id = ?
             ORDER BY run_id`,
          )
          .all("effect:portable"),
      ).toEqual([{ runId: firstRunId }, { runId: secondRunId }]);
    });
  });

  it("rejects duplicate attempt numbers for the same run/op/iteration", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "attempt-number");
      insertInvocation(connection, runId, 1, 0, "effect:attempt-number");
      insertAttempt(connection, {
        runId,
        opIndex: 1,
        logicalEffectId: "effect:attempt-number",
      });

      expect(() =>
        insertAttempt(connection, {
          runId,
          opIndex: 1,
          logicalEffectId: "effect:attempt-number",
        }),
      ).toThrow();
    });
  });

  it("rejects attempts without a durable logical invocation", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "missing-invocation");

      expect(() =>
        insertAttempt(connection, { runId, logicalEffectId: "effect:missing" }),
      ).toThrow();
    });
  });

  it("enforces attempt status, terminal payload, and timing invariants", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "attempt-state");
      insertInvocation(connection, runId, 0, 0, "effect:state");

      expect(() =>
        insertAttempt(connection, {
          runId,
          logicalEffectId: "effect:state",
          status: "mystery",
        }),
      ).toThrow();
      expect(() =>
        insertAttempt(connection, {
          runId,
          logicalEffectId: "effect:state",
          status: "running",
          finishedAtMs: 23,
        }),
      ).toThrow();
      expect(() =>
        insertAttempt(connection, {
          runId,
          logicalEffectId: "effect:state",
          status: "completed",
          finishedAtMs: 23,
        }),
      ).toThrow();
      expect(() =>
        insertAttempt(connection, {
          runId,
          logicalEffectId: "effect:state",
          status: "failed",
          finishedAtMs: 23,
        }),
      ).toThrow();
      expect(() =>
        insertAttempt(connection, {
          runId,
          logicalEffectId: "effect:state",
          status: "completed",
          outputRefsJson: "{}",
          startedAtMs: 30,
          finishedAtMs: 29,
        }),
      ).toThrow();
    });
  });

  it("preserves runs while logical invocations reference them", () => {
    withDatabase((connection) => {
      const runId = createRun(connection, "delete");
      insertInvocation(connection, runId, 0, 0, "effect:delete");

      expect(() =>
        connection.prepare(`DELETE FROM ${RUNS_TABLE} WHERE run_id = ?`).run(runId),
      ).toThrow();
    });
  });
});
