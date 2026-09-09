import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

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
  SQLITE_MEMORY_PATH,
  SqliteDatabase,
  runSqliteMigrations,
} from "./index.js";
import {
  LOGICAL_EFFECT_ID_PREFIX,
  ensureDurableNodeInvocation,
  generateLogicalEffectId,
} from "./durable-node-invocation.js";

const migrations = [
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  DURABLE_NODE_ATTEMPTS_MIGRATION,
] as const;

function openDatabase(path = SQLITE_MEMORY_PATH): SqliteDatabase {
  const database = new SqliteDatabase({ path });
  database.open();
  runSqliteMigrations(database.connection(), migrations, { now: () => 1 });
  return database;
}

function createRun(connection: DatabaseSync, suffix: string): string {
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
}

describe("durable logical effect identity", () => {
  it("generates opaque versioned Harness-owned IDs", () => {
    const first = generateLogicalEffectId();
    const second = generateLogicalEffectId();

    expect(first).toMatch(
      /^zet-effect-v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.startsWith(LOGICAL_EFFECT_ID_PREFIX)).toBe(true);
    expect(second).not.toBe(first);
  });

  it("creates one identity and reuses it for retry-time calls", async () => {
    const database = openDatabase();

    try {
      const runId = createRun(database.connection(), "retry-stable");
      const first = await ensureDurableNodeInvocation(database, {
        runId,
        opIndex: 4,
        iteration: 2,
        createdAtMs: 100,
      });
      const retry = await ensureDurableNodeInvocation(database, {
        runId,
        opIndex: 4,
        iteration: 2,
        createdAtMs: 999,
      });

      expect(retry).toEqual(first);
      expect(retry.createdAtMs).toBe(100);
      expect(
        database
          .connection()
          .prepare(
            `SELECT COUNT(*) AS count
             FROM ${NODE_INVOCATIONS_TABLE}
             WHERE run_id = ? AND op_index = 4 AND iteration = 2`,
          )
          .get(runId),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("serializes concurrent creators onto the same logical invocation row", async () => {
    const database = openDatabase();

    try {
      const runId = createRun(database.connection(), "concurrent");
      const input = { runId, opIndex: 1, iteration: 0, createdAtMs: 200 } as const;
      const [first, second] = await Promise.all([
        ensureDurableNodeInvocation(database, input),
        ensureDurableNodeInvocation(database, input),
      ]);

      expect(second.logicalEffectId).toBe(first.logicalEffectId);
      expect(
        database
          .connection()
          .prepare(`SELECT COUNT(*) AS count FROM ${NODE_INVOCATIONS_TABLE} WHERE run_id = ?`)
          .get(runId),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("reuses the persisted identity after a file-backed close and reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zet-harness-effect-id-"));
    const path = join(directory, "runtime.sqlite");

    try {
      let database = openDatabase(path);
      const runId = createRun(database.connection(), "restart");
      const beforeRestart = await ensureDurableNodeInvocation(database, {
        runId,
        opIndex: 7,
        iteration: 3,
        createdAtMs: 300,
      });
      database.close();

      database = openDatabase(path);
      try {
        const afterRestart = await ensureDurableNodeInvocation(database, {
          runId,
          opIndex: 7,
          iteration: 3,
          createdAtMs: 400,
        });

        expect(afterRestart).toEqual(beforeRestart);
        expect(afterRestart.createdAtMs).toBe(300);
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates independent IDs for distinct logical invocation coordinates", async () => {
    const database = openDatabase();

    try {
      const runId = createRun(database.connection(), "coordinates");
      const first = await ensureDurableNodeInvocation(database, {
        runId,
        opIndex: 0,
        iteration: 0,
        createdAtMs: 500,
      });
      const nextIteration = await ensureDurableNodeInvocation(database, {
        runId,
        opIndex: 0,
        iteration: 1,
        createdAtMs: 501,
      });
      const nextOp = await ensureDurableNodeInvocation(database, {
        runId,
        opIndex: 1,
        iteration: 0,
        createdAtMs: 502,
      });

      expect(new Set([first.logicalEffectId, nextIteration.logicalEffectId, nextOp.logicalEffectId]).size).toBe(
        3,
      );
    } finally {
      database.close();
    }
  });

  it("rejects malformed durable invocation coordinates before entering SQLite", () => {
    const database = openDatabase();

    try {
      expect(() =>
        ensureDurableNodeInvocation(database, {
          runId: " ",
          opIndex: 0,
          iteration: 0,
          createdAtMs: 0,
        }),
      ).toThrow("runId");
      expect(() =>
        ensureDurableNodeInvocation(database, {
          runId: "run-valid",
          opIndex: -1,
          iteration: 0,
          createdAtMs: 0,
        }),
      ).toThrow("opIndex");
    } finally {
      database.close();
    }
  });
});
