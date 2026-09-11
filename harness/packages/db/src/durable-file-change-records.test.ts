import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  COMPILED_PLANS_TABLE,
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_NODE_ATTEMPTS_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  GRAPH_COMPILATIONS_TABLE,
  GRAPH_SOURCES_TABLE,
  NODE_INVOCATIONS_TABLE,
  RUNS_TABLE,
  runSqliteMigrations,
} from "./index.js";
import {
  DURABLE_FILE_CHANGES_MIGRATION,
  FILE_CHANGES_TABLE,
  readFileChangeHistory,
  readRunFileChanges,
  recordFileChange,
  type RecordFileChangeInput,
} from "./durable-file-change-records.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const withDatabase = (run: (connection: DatabaseSync, runId: string) => void): void => {
  const connection = new DatabaseSync(":memory:", {
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });

  try {
    runSqliteMigrations(
      connection,
      [
        DURABLE_GRAPH_IDENTITY_MIGRATION,
        DURABLE_RUNS_MIGRATION,
        DURABLE_NODE_ATTEMPTS_MIGRATION,
        DURABLE_FILE_CHANGES_MIGRATION,
      ],
      { now: () => 1 },
    );
    const runId = createRun(connection, "fc");
    insertInvocation(connection, runId, 0, 0, "effect-1");
    run(connection, runId);
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
        document_hash, semantic_hash, hash_algorithm, graph_id, revision_id,
        normalized_document_json, canonical_semantics_json, created_at_ms
      ) VALUES (?, ?, 'sha256', ?, ?, '{}', '{}', 10)`,
    )
    .run(documentHash, semanticHash, `graph-${suffix}`, `rev-${suffix}`);

  const plan = connection
    .prepare(
      `INSERT INTO ${COMPILED_PLANS_TABLE}(
        semantic_hash, registry_hash, compiler_version, hash_algorithm, ir_hash,
        execution_ir_json, node_pins_json, plugin_pins_json, created_at_ms
      ) VALUES (?, ?, 'harness.compiler/v1', 'sha256', ?, '{}', '[]', '[]', 11)`,
    )
    .run(semanticHash, `sha256:registry-${suffix}`, `sha256:ir-${suffix}`);

  const compiledPlanId = Number(plan.lastInsertRowid);
  connection
    .prepare(
      `INSERT INTO ${GRAPH_COMPILATIONS_TABLE}(
        document_hash, compiled_plan_id, semantic_hash, created_at_ms
      ) VALUES (?, ?, ?, 12)`,
    )
    .run(documentHash, compiledPlanId, semanticHash);

  connection
    .prepare(
      `INSERT INTO ${RUNS_TABLE}(
        run_id, document_hash, compiled_plan_id, status, parent_run_id,
        fork_metadata_json, created_at_ms, started_at_ms, finished_at_ms
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
        run_id, op_index, iteration, logical_effect_id, created_at_ms
      ) VALUES (?, ?, ?, ?, 21)`,
    )
    .run(runId, opIndex, iteration, logicalEffectId);
};

function input(
  runId: string,
  overrides: Partial<RecordFileChangeInput> = {},
): RecordFileChangeInput {
  return {
    runId,
    opIndex: 0,
    iteration: 0,
    logicalEffectId: "effect-1",
    attempt: 1,
    workspacePath: "src/index.ts",
    changeKind: "created",
    beforeSha256: null,
    afterSha256: HASH_A,
    bytesWritten: 10,
    recordedAtMs: 100,
    ...overrides,
  };
}

describe("recording file changes", () => {
  it("stores a creation with a null before hash", () => {
    withDatabase((connection, runId) => {
      recordFileChange(connection, input(runId));
      const [record] = readRunFileChanges(connection, runId);
      expect(record?.changeKind).toBe("created");
      expect(record?.beforeSha256).toBeNull();
      expect(record?.afterSha256).toBe(HASH_A);
    });
  });

  it("stores a modification with both hashes", () => {
    withDatabase((connection, runId) => {
      recordFileChange(
        connection,
        input(runId, { changeKind: "modified", beforeSha256: HASH_A, afterSha256: HASH_B }),
      );
      const [record] = readRunFileChanges(connection, runId);
      expect(record?.beforeSha256).toBe(HASH_A);
      expect(record?.afterSha256).toBe(HASH_B);
    });
  });

  it("stores a deletion with a null after hash", () => {
    withDatabase((connection, runId) => {
      recordFileChange(
        connection,
        input(runId, {
          changeKind: "deleted",
          beforeSha256: HASH_A,
          afterSha256: null,
          bytesWritten: 0,
        }),
      );
      const [record] = readRunFileChanges(connection, runId);
      expect(record?.afterSha256).toBeNull();
    });
  });

  it("keeps the workspace-relative path, not a host path", () => {
    withDatabase((connection, runId) => {
      recordFileChange(connection, input(runId, { workspacePath: "docs/readme.md" }));
      const [record] = readRunFileChanges(connection, runId);
      expect(record?.workspacePath).toBe("docs/readme.md");
    });
  });
});

describe("schema invariants", () => {
  it("refuses a creation that claims a before hash", () => {
    withDatabase((connection, runId) => {
      expect(() =>
        recordFileChange(connection, input(runId, { changeKind: "created", beforeSha256: HASH_A })),
      ).toThrow();
    });
  });

  it("refuses a modification with no before hash", () => {
    withDatabase((connection, runId) => {
      expect(() =>
        recordFileChange(
          connection,
          input(runId, { changeKind: "modified", beforeSha256: null, afterSha256: HASH_B }),
        ),
      ).toThrow();
    });
  });

  it("refuses a deletion that claims an after hash", () => {
    withDatabase((connection, runId) => {
      expect(() =>
        recordFileChange(
          connection,
          input(runId, { changeKind: "deleted", beforeSha256: HASH_A, afterSha256: HASH_B }),
        ),
      ).toThrow();
    });
  });

  it("refuses a malformed hash before touching the database", () => {
    withDatabase((connection, runId) => {
      expect(() =>
        recordFileChange(connection, input(runId, { afterSha256: "not-a-hash" })),
      ).toThrow(TypeError);
    });
  });

  it("refuses an uppercase hash", () => {
    withDatabase((connection, runId) => {
      expect(() =>
        recordFileChange(connection, input(runId, { afterSha256: HASH_A.toUpperCase() })),
      ).toThrow(TypeError);
    });
  });

  it("refuses a zero attempt", () => {
    withDatabase((connection, runId) => {
      expect(() => recordFileChange(connection, input(runId, { attempt: 0 }))).toThrow(TypeError);
    });
  });

  it("refuses a negative byte count", () => {
    withDatabase((connection, runId) => {
      expect(() => recordFileChange(connection, input(runId, { bytesWritten: -1 }))).toThrow(
        TypeError,
      );
    });
  });

  it("refuses an empty path", () => {
    withDatabase((connection, runId) => {
      expect(() => recordFileChange(connection, input(runId, { workspacePath: "" }))).toThrow(
        TypeError,
      );
    });
  });

  it("refuses a record for an invocation that does not exist", () => {
    withDatabase((connection, runId) => {
      expect(() =>
        recordFileChange(connection, input(runId, { logicalEffectId: "never-invoked" })),
      ).toThrow();
    });
  });

  it("refuses two records for the same attempt and path", () => {
    withDatabase((connection, runId) => {
      recordFileChange(connection, input(runId));
      expect(() => recordFileChange(connection, input(runId))).toThrow();
    });
  });

  it("allows the same path on a later attempt", () => {
    withDatabase((connection, runId) => {
      recordFileChange(connection, input(runId, { attempt: 1 }));
      recordFileChange(
        connection,
        input(runId, {
          attempt: 2,
          changeKind: "modified",
          beforeSha256: HASH_A,
          afterSha256: HASH_B,
        }),
      );
      expect(readRunFileChanges(connection, runId)).toHaveLength(2);
    });
  });
});

describe("append-only history", () => {
  it("refuses an update", () => {
    withDatabase((connection, runId) => {
      recordFileChange(connection, input(runId));
      expect(() =>
        connection
          .prepare(`UPDATE ${FILE_CHANGES_TABLE} SET after_sha256 = ? WHERE run_id = ?`)
          .run(HASH_C, runId),
      ).toThrow();
    });
  });

  it("refuses a delete", () => {
    withDatabase((connection, runId) => {
      recordFileChange(connection, input(runId));
      expect(() =>
        connection.prepare(`DELETE FROM ${FILE_CHANGES_TABLE} WHERE run_id = ?`).run(runId),
      ).toThrow();
    });
  });

  it("keeps the record after a refused update", () => {
    withDatabase((connection, runId) => {
      recordFileChange(connection, input(runId));
      try {
        connection
          .prepare(`UPDATE ${FILE_CHANGES_TABLE} SET after_sha256 = ? WHERE run_id = ?`)
          .run(HASH_C, runId);
      } catch {
        // expected
      }
      expect(readRunFileChanges(connection, runId)[0]?.afterSha256).toBe(HASH_A);
    });
  });
});

describe("reading history", () => {
  it("returns changes in recorded order", () => {
    withDatabase((connection, runId) => {
      recordFileChange(connection, input(runId, { workspacePath: "a.txt" }));
      recordFileChange(connection, input(runId, { workspacePath: "b.txt" }));
      expect(readRunFileChanges(connection, runId).map((r) => r.workspacePath)).toEqual([
        "a.txt",
        "b.txt",
      ]);
    });
  });

  it("filters history by path", () => {
    withDatabase((connection, runId) => {
      recordFileChange(connection, input(runId, { workspacePath: "a.txt" }));
      recordFileChange(connection, input(runId, { workspacePath: "b.txt" }));
      recordFileChange(
        connection,
        input(runId, {
          workspacePath: "a.txt",
          attempt: 2,
          changeKind: "modified",
          beforeSha256: HASH_A,
          afterSha256: HASH_B,
        }),
      );
      const history = readFileChangeHistory(connection, runId, "a.txt");
      expect(history).toHaveLength(2);
      expect(history.map((r) => r.attempt)).toEqual([1, 2]);
    });
  });

  it("returns an empty list for an unknown run", () => {
    withDatabase((connection) => {
      expect(readRunFileChanges(connection, "run-missing")).toEqual([]);
    });
  });

  it("freezes returned records", () => {
    withDatabase((connection, runId) => {
      recordFileChange(connection, input(runId));
      const [record] = readRunFileChanges(connection, runId);
      expect(Object.isFrozen(record)).toBe(true);
    });
  });
});
