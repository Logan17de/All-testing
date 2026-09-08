import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  COMPILED_PLANS_TABLE,
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  GRAPH_COMPILATIONS_TABLE,
  GRAPH_SOURCES_TABLE,
  runSqliteMigrations,
} from "./index.js";

const withDatabase = (run: (connection: DatabaseSync) => void): void => {
  const connection = new DatabaseSync(":memory:", {
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });

  try {
    runSqliteMigrations(connection, [DURABLE_GRAPH_IDENTITY_MIGRATION], { now: () => 1 });
    run(connection);
  } finally {
    connection.close();
  }
};

const insertSource = (
  connection: DatabaseSync,
  documentHash: string,
  semanticHash: string,
  graphId: string,
  revisionId: string,
): void => {
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
    .run(documentHash, semanticHash, graphId, revisionId);
};

const insertPlan = (
  connection: DatabaseSync,
  semanticHash: string,
  registryHash: string,
  compilerVersion: string,
  irHash: string,
): number => {
  const result = connection
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
      ) VALUES (?, ?, ?, 'sha256', ?, '{}', '[]', '[]', 11)`,
    )
    .run(semanticHash, registryHash, compilerVersion, irHash);

  return Number(result.lastInsertRowid);
};

describe("durable graph/compiler identity records", () => {
  it("installs exact-source, compiled-plan, and source-to-plan identity tables", () => {
    withDatabase((connection) => {
      const rows = connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?) ORDER BY name",
        )
        .all(COMPILED_PLANS_TABLE, GRAPH_COMPILATIONS_TABLE, GRAPH_SOURCES_TABLE);

      expect(rows).toEqual([
        { name: COMPILED_PLANS_TABLE },
        { name: GRAPH_COMPILATIONS_TABLE },
        { name: GRAPH_SOURCES_TABLE },
      ]);
    });
  });

  it("allows metadata-distinct source documents with one semantic identity to share a plan", () => {
    withDatabase((connection) => {
      insertSource(connection, "sha256:doc-a", "sha256:sem", "graph", "rev-a");
      insertSource(connection, "sha256:doc-b", "sha256:sem", "graph", "rev-b");
      const planId = insertPlan(
        connection,
        "sha256:sem",
        "sha256:registry",
        "harness.compiler/v1",
        "sha256:ir",
      );

      const link = connection.prepare(
        `INSERT INTO ${GRAPH_COMPILATIONS_TABLE}(
          document_hash,
          compiled_plan_id,
          semantic_hash,
          created_at_ms
        ) VALUES (?, ?, ?, 12)`,
      );
      link.run("sha256:doc-a", planId, "sha256:sem");
      link.run("sha256:doc-b", planId, "sha256:sem");

      expect(
        connection
          .prepare(
            `SELECT document_hash AS documentHash, compiled_plan_id AS compiledPlanId
             FROM ${GRAPH_COMPILATIONS_TABLE}
             ORDER BY document_hash`,
          )
          .all(),
      ).toEqual([
        { documentHash: "sha256:doc-a", compiledPlanId: planId },
        { documentHash: "sha256:doc-b", compiledPlanId: planId },
      ]);
    });
  });

  it("rejects associating a source with a plan from a different semantic identity", () => {
    withDatabase((connection) => {
      insertSource(connection, "sha256:doc", "sha256:sem-a", "graph", "rev");
      const planId = insertPlan(
        connection,
        "sha256:sem-b",
        "sha256:registry",
        "harness.compiler/v1",
        "sha256:ir",
      );

      expect(() =>
        connection
          .prepare(
            `INSERT INTO ${GRAPH_COMPILATIONS_TABLE}(
              document_hash,
              compiled_plan_id,
              semantic_hash,
              created_at_ms
            ) VALUES (?, ?, ?, 12)`,
          )
          .run("sha256:doc", planId, "sha256:sem-a"),
      ).toThrow();
    });
  });

  it("makes semantic hash + registry hash + compiler version the unique compile identity", () => {
    withDatabase((connection) => {
      insertPlan(connection, "sha256:sem", "sha256:registry", "harness.compiler/v1", "sha256:ir-a");

      expect(() =>
        insertPlan(
          connection,
          "sha256:sem",
          "sha256:registry",
          "harness.compiler/v1",
          "sha256:ir-b",
        ),
      ).toThrow();
    });
  });

  it("does not mistake the IR content hash for full compiler provenance identity", () => {
    withDatabase((connection) => {
      const first = insertPlan(
        connection,
        "sha256:sem",
        "sha256:registry-a",
        "harness.compiler/v1",
        "sha256:same-ir",
      );
      const second = insertPlan(
        connection,
        "sha256:sem",
        "sha256:registry-b",
        "harness.compiler/v2",
        "sha256:same-ir",
      );

      expect(first).not.toBe(second);
      expect(
        connection
          .prepare(`SELECT COUNT(*) AS count FROM ${COMPILED_PLANS_TABLE} WHERE ir_hash = ?`)
          .get("sha256:same-ir"),
      ).toEqual({ count: 2 });
    });
  });

  it("prevents reusing one graph revision identity for different source content", () => {
    withDatabase((connection) => {
      insertSource(connection, "sha256:doc-a", "sha256:sem-a", "graph", "rev");

      expect(() =>
        insertSource(connection, "sha256:doc-b", "sha256:sem-b", "graph", "rev"),
      ).toThrow();
    });
  });
});
