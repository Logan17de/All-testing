import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  COMPILED_PLANS_TABLE,
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  GRAPH_COMPILATIONS_TABLE,
  GRAPH_SOURCES_TABLE,
  RUNS_TABLE,
  runSqliteMigrations,
} from "./index.js";

const withDatabase = (run: (connection: DatabaseSync) => void): void => {
  const connection = new DatabaseSync(":memory:", {
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });

  try {
    runSqliteMigrations(connection, [DURABLE_GRAPH_IDENTITY_MIGRATION, DURABLE_RUNS_MIGRATION], {
      now: () => 1,
    });
    run(connection);
  } finally {
    connection.close();
  }
};

const createCompilation = (connection: DatabaseSync, suffix: string): number => {
  const documentHash = `sha256:doc-${suffix}`;
  const semanticHash = `sha256:sem-${suffix}`;

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

  return compiledPlanId;
};

const insertRun = (
  connection: DatabaseSync,
  input: {
    readonly runId: string;
    readonly documentHash: string;
    readonly compiledPlanId: number;
    readonly status?: string;
    readonly parentRunId?: string | null;
    readonly forkMetadataJson?: string | null;
    readonly createdAtMs?: number;
    readonly startedAtMs?: number | null;
    readonly finishedAtMs?: number | null;
  },
): void => {
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.documentHash,
      input.compiledPlanId,
      input.status ?? "pending",
      input.parentRunId ?? null,
      input.forkMetadataJson ?? null,
      input.createdAtMs ?? 20,
      input.startedAtMs ?? null,
      input.finishedAtMs ?? null,
    );
};

describe("durable run records", () => {
  it("installs the ordered run migration after durable compiler identity", () => {
    withDatabase((connection) => {
      expect(
        connection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(RUNS_TABLE),
      ).toEqual({ name: RUNS_TABLE });

      expect(
        connection
          .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([
        { version: 1, name: "durable_graph_and_compiled_plan_identity" },
        { version: 2, name: "durable_runs_and_fork_lineage" },
      ]);
    });
  });

  it("stores root and child lineage without forcing a child to reuse the parent plan", () => {
    withDatabase((connection) => {
      const parentPlanId = createCompilation(connection, "parent");
      const childPlanId = createCompilation(connection, "child");

      insertRun(connection, {
        runId: "run-parent",
        documentHash: "sha256:doc-parent",
        compiledPlanId: parentPlanId,
        status: "completed",
        startedAtMs: 21,
        finishedAtMs: 22,
      });
      insertRun(connection, {
        runId: "run-child",
        documentHash: "sha256:doc-child",
        compiledPlanId: childPlanId,
        parentRunId: "run-parent",
        forkMetadataJson: '{"reason":"branch"}',
      });

      expect(
        connection
          .prepare(
            `SELECT
               run_id AS runId,
               parent_run_id AS parentRunId,
               fork_metadata_json AS forkMetadataJson,
               compiled_plan_id AS compiledPlanId
             FROM ${RUNS_TABLE}
             ORDER BY run_id`,
          )
          .all(),
      ).toEqual([
        {
          runId: "run-child",
          parentRunId: "run-parent",
          forkMetadataJson: '{"reason":"branch"}',
          compiledPlanId: childPlanId,
        },
        {
          runId: "run-parent",
          parentRunId: null,
          forkMetadataJson: null,
          compiledPlanId: parentPlanId,
        },
      ]);
    });
  });

  it("allows child lineage without fork metadata while checkpoints remain undefined", () => {
    withDatabase((connection) => {
      const planId = createCompilation(connection, "lineage");
      insertRun(connection, {
        runId: "run-parent",
        documentHash: "sha256:doc-lineage",
        compiledPlanId: planId,
      });
      insertRun(connection, {
        runId: "run-child",
        documentHash: "sha256:doc-lineage",
        compiledPlanId: planId,
        parentRunId: "run-parent",
      });

      expect(
        connection
          .prepare(`SELECT parent_run_id AS parentRunId FROM ${RUNS_TABLE} WHERE run_id = ?`)
          .get("run-child"),
      ).toEqual({ parentRunId: "run-parent" });
    });
  });

  it("rejects fork metadata on a root run", () => {
    withDatabase((connection) => {
      const planId = createCompilation(connection, "root");

      expect(() =>
        insertRun(connection, {
          runId: "run-root",
          documentHash: "sha256:doc-root",
          compiledPlanId: planId,
          forkMetadataJson: "{}",
        }),
      ).toThrow();
    });
  });

  it("rejects missing and self parent lineage", () => {
    withDatabase((connection) => {
      const planId = createCompilation(connection, "parent-checks");

      expect(() =>
        insertRun(connection, {
          runId: "run-missing-parent",
          documentHash: "sha256:doc-parent-checks",
          compiledPlanId: planId,
          parentRunId: "does-not-exist",
        }),
      ).toThrow();

      expect(() =>
        insertRun(connection, {
          runId: "run-self",
          documentHash: "sha256:doc-parent-checks",
          compiledPlanId: planId,
          parentRunId: "run-self",
        }),
      ).toThrow();
    });
  });

  it("requires the exact source-to-plan compilation association", () => {
    withDatabase((connection) => {
      createCompilation(connection, "source-a");
      const planB = createCompilation(connection, "source-b");

      expect(() =>
        insertRun(connection, {
          runId: "run-mismatch",
          documentHash: "sha256:doc-source-a",
          compiledPlanId: planB,
        }),
      ).toThrow();
    });
  });

  it("rejects unknown run status and non-monotonic timing", () => {
    withDatabase((connection) => {
      const planId = createCompilation(connection, "state");

      expect(() =>
        insertRun(connection, {
          runId: "run-status",
          documentHash: "sha256:doc-state",
          compiledPlanId: planId,
          status: "mystery",
        }),
      ).toThrow();

      expect(() =>
        insertRun(connection, {
          runId: "run-time",
          documentHash: "sha256:doc-state",
          compiledPlanId: planId,
          createdAtMs: 20,
          startedAtMs: 30,
          finishedAtMs: 29,
        }),
      ).toThrow();
    });
  });

  it("preserves parent runs while descendants reference them", () => {
    withDatabase((connection) => {
      const planId = createCompilation(connection, "delete");
      insertRun(connection, {
        runId: "run-parent",
        documentHash: "sha256:doc-delete",
        compiledPlanId: planId,
      });
      insertRun(connection, {
        runId: "run-child",
        documentHash: "sha256:doc-delete",
        compiledPlanId: planId,
        parentRunId: "run-parent",
      });

      expect(() =>
        connection.prepare(`DELETE FROM ${RUNS_TABLE} WHERE run_id = ?`).run("run-parent"),
      ).toThrow();
    });
  });
});
