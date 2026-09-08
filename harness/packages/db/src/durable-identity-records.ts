import type { SqliteMigration } from "./migrations.js";

export const GRAPH_SOURCES_TABLE = "graph_sources" as const;
export const COMPILED_PLANS_TABLE = "compiled_plans" as const;
export const GRAPH_COMPILATIONS_TABLE = "graph_compilations" as const;

/** Exact normalized authoring-document identity. */
export interface DurableGraphSourceRecord {
  readonly documentHash: string;
  readonly semanticHash: string;
  readonly hashAlgorithm: string;
  readonly graphId: string;
  readonly revisionId: string;
  readonly normalizedDocumentJson: string;
  readonly canonicalSemanticsJson: string;
  readonly createdAtMs: number;
}

/**
 * Deterministic compiled-plan identity.
 *
 * `irHash` is only the Execution IR content hash. The durable compile identity is
 * semanticHash + registryHash + compilerVersion, matching the Phase 2 compiler
 * contract. Different compiler/provenance identities may therefore legitimately
 * point at identical IR content.
 */
export interface DurableCompiledPlanRecord {
  readonly compiledPlanId: number;
  readonly semanticHash: string;
  readonly registryHash: string;
  readonly compilerVersion: string;
  readonly hashAlgorithm: string;
  readonly irHash: string;
  readonly executionIrJson: string;
  readonly nodePinsJson: string;
  readonly pluginPinsJson: string;
  readonly createdAtMs: number;
}

/** Links an exact source document to one compatible deterministic compiled plan. */
export interface DurableGraphCompilationRecord {
  readonly documentHash: string;
  readonly compiledPlanId: number;
  readonly semanticHash: string;
  readonly createdAtMs: number;
}

/**
 * First application-schema migration.
 *
 * The storage layer records compiler outputs; it does not derive or verify their
 * hashes. Source-document identity and executable-plan identity stay separate so
 * metadata-only revisions may share one compiled plan when semantic identity is
 * unchanged.
 */
export const DURABLE_GRAPH_IDENTITY_MIGRATION: SqliteMigration = Object.freeze({
  version: 1,
  name: "durable_graph_and_compiled_plan_identity",
  sql: `
CREATE TABLE ${GRAPH_SOURCES_TABLE} (
  document_hash TEXT PRIMARY KEY,
  semantic_hash TEXT NOT NULL,
  hash_algorithm TEXT NOT NULL,
  graph_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  normalized_document_json TEXT NOT NULL,
  canonical_semantics_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (graph_id, revision_id),
  UNIQUE (document_hash, semantic_hash)
) STRICT;

CREATE TABLE ${COMPILED_PLANS_TABLE} (
  compiled_plan_id INTEGER PRIMARY KEY,
  semantic_hash TEXT NOT NULL,
  registry_hash TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  hash_algorithm TEXT NOT NULL,
  ir_hash TEXT NOT NULL,
  execution_ir_json TEXT NOT NULL,
  node_pins_json TEXT NOT NULL,
  plugin_pins_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (semantic_hash, registry_hash, compiler_version),
  UNIQUE (compiled_plan_id, semantic_hash)
) STRICT;

CREATE TABLE ${GRAPH_COMPILATIONS_TABLE} (
  document_hash TEXT NOT NULL,
  compiled_plan_id INTEGER NOT NULL,
  semantic_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (document_hash, compiled_plan_id),
  FOREIGN KEY (document_hash, semantic_hash)
    REFERENCES ${GRAPH_SOURCES_TABLE}(document_hash, semantic_hash)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (compiled_plan_id, semantic_hash)
    REFERENCES ${COMPILED_PLANS_TABLE}(compiled_plan_id, semantic_hash)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;
`,
});
