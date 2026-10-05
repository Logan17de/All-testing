import type { PluginHost } from "@zet-harness/core";
import type { SqliteDatabase } from "@zet-harness/db";
import { createSortableId } from "@zet-harness/db/sortable-id";
import {
  GRAPH_SUBGRAPH_SEPARATOR,
  canonicalizeGraphJsonV1Semantics,
  checkGraphJsonV1Diagnostics,
  diffGraphJsonV1,
  checkGraphJsonV1Shape,
  expandGraphJsonV1Subgraphs,
  lowerCanonicalGraphJsonV1ToExecutionIr,
  normalizeGraphJsonV1,
  recordGraphCompilerIdentityV1,
  stripGraphJsonV1UiMetadata,
  type ExecutionIrV1,
  type GraphCompilerIdentityV1,
  type GraphJsonDiffV1,
  type GraphJsonV1,
  type GraphJsonV1DiagnosticContext,
  type GraphSourceResolver,
  type NodeResolutionResolver,
} from "@zet-harness/graph";
import type { NodeManifest } from "@zet-harness/plugin-api";
import type { IsolatedPlugin } from "@zet-harness/plugin-loader";

import { reconstructExecutionFrontier } from "./runtime-recovery.js";
import { currentOps } from "./runtime-iteration-frontier.js";

/**
 * Editor-facing graph and run service.
 *
 * The editor sends Graph JSON; this compiles it through the same frozen compiler
 * stages every other path uses, stores the result as an immutable plan, and
 * reports run state back. It adds no execution semantics of its own: a run it
 * creates is an ordinary `pending` run the durable dispatcher admits like any
 * other.
 */

export type RuntimeGraphErrorCode =
  | "FORK_POINT_INVALID"
  | "GRAPH_REVISION_NOT_FOUND"
  | "FORK_UNSUPPORTED"
  | "GRAPH_INVALID"
  | "GRAPH_REVISION_CONFLICT"
  | "RUN_NOT_FOUND";

export class RuntimeGraphError extends Error {
  readonly code: RuntimeGraphErrorCode;
  readonly statusCode: number;
  readonly diagnostics: readonly EditorDiagnostic[];

  constructor(
    code: RuntimeGraphErrorCode,
    message: string,
    statusCode: number,
    diagnostics: readonly EditorDiagnostic[] = [],
  ) {
    super(message);
    this.name = "RuntimeGraphError";
    this.code = code;
    this.statusCode = statusCode;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

/** One diagnostic shape for every compiler stage, located for display on the canvas. */
export interface EditorDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly stage: string;
  readonly path?: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly port?: string;
}

export interface PaletteNode {
  readonly manifest: NodeManifest;
  readonly pluginId: string;
  readonly isolated: boolean;
}

export interface GraphSources {
  readonly host?: PluginHost;
  readonly sandboxes?: readonly IsolatedPlugin[];
  /** Saved graphs a subgraph node may run, looked up by graph id and revision id. */
  readonly graphs?: GraphSourceResolver;
}

const NO_SAVED_GRAPHS: GraphSourceResolver = { getGraph: () => undefined };

/**
 * Saved graph revisions, as stored when a run was created.
 *
 * A (graph id, revision id) pair is immutable once stored, so a subgraph that
 * pins a revision always expands to the same content.
 */
export function createStoredGraphResolver(database: SqliteDatabase): GraphSourceResolver {
  return {
    getGraph(graphId, revisionId) {
      const row = database
        .connection()
        .prepare(
          "SELECT normalized_document_json AS json FROM graph_sources WHERE graph_id = ? AND revision_id = ?",
        )
        .get(graphId, revisionId) as { readonly json: string } | undefined;
      return row === undefined ? undefined : (JSON.parse(row.json) as GraphJsonV1);
    },
  };
}

/** Point a diagnostic from inside an expanded subgraph at the subgraph node the author placed. */
function onAuthoredNode<
  T extends { readonly message: string; readonly nodeId?: string; readonly edgeId?: string },
>(diagnostic: T, subgraphNodeIds: ReadonlySet<string>): T {
  const owner = (id: string | undefined): string | undefined => {
    if (id === undefined) return undefined;
    const head = id.split(GRAPH_SUBGRAPH_SEPARATOR)[0]!;
    return head !== id && subgraphNodeIds.has(head) ? head : undefined;
  };
  const nodeOwner = owner(diagnostic.nodeId) ?? owner(diagnostic.edgeId);
  if (nodeOwner === undefined) return diagnostic;
  return {
    ...diagnostic,
    nodeId: nodeOwner,
    message: `Inside subgraph '${nodeOwner}': ${diagnostic.message}`,
  };
}

/**
 * Resolve node types across in-process plugins and sandboxes.
 *
 * In-process registrations win, matching the executor's resolution order, so the
 * compiler pins exactly the definition that will later run.
 */
export function createCompositeNodeResolver(sources: GraphSources): NodeResolutionResolver {
  const findSandboxed = (type: string, version: string) => {
    for (const sandbox of sources.sandboxes ?? []) {
      const node = sandbox.nodes.find(
        (candidate) => candidate.manifest.type === type && candidate.manifest.version === version,
      );
      if (node !== undefined) return { sandbox, manifest: node.manifest };
    }
    return undefined;
  };

  return {
    getManifest(type, version) {
      return (
        sources.host?.nodes.getManifest(type, version) ?? findSandboxed(type, version)?.manifest
      );
    },
    getResolution(type, version) {
      const hosted = sources.host?.nodes.getResolution(type, version);
      if (hosted !== undefined) return hosted;
      const sandboxed = findSandboxed(type, version);
      return sandboxed === undefined
        ? undefined
        : {
            manifest: sandboxed.manifest,
            plugin: { id: sandboxed.sandbox.pluginId, version: sandboxed.sandbox.pluginVersion },
          };
    },
  };
}

/** Every node a graph may use right now, for the editor palette. */
export function listPaletteNodes(sources: GraphSources): readonly PaletteNode[] {
  const nodes: PaletteNode[] = [];
  const seen = new Set<string>();
  const add = (manifest: NodeManifest, pluginId: string, isolated: boolean): void => {
    const key = `${manifest.type}\u0000${manifest.version}`;
    if (seen.has(key)) return;
    seen.add(key);
    nodes.push(Object.freeze({ manifest, pluginId, isolated }));
  };

  for (const manifest of sources.host?.nodes.listManifests() ?? []) {
    const resolution = sources.host?.nodes.getResolution(manifest.type, manifest.version);
    add(manifest, resolution?.plugin.id ?? "host", false);
  }
  for (const sandbox of sources.sandboxes ?? []) {
    for (const node of sandbox.nodes) add(node.manifest, sandbox.pluginId, true);
  }

  nodes.sort((left, right) =>
    left.manifest.type === right.manifest.type
      ? left.manifest.version.localeCompare(right.manifest.version)
      : left.manifest.type.localeCompare(right.manifest.type),
  );
  return Object.freeze(nodes);
}

export interface CompiledGraph {
  readonly graph: GraphJsonV1;
  readonly ir: ExecutionIrV1;
  readonly identity: GraphCompilerIdentityV1;
  readonly normalizedDocumentJson: string;
  readonly canonicalSemanticsJson: string;
}

export type GraphCompileResult =
  | { readonly valid: true; readonly compiled: CompiledGraph }
  | { readonly valid: false; readonly diagnostics: readonly EditorDiagnostic[] };

function locate(diagnostic: {
  readonly code: string;
  readonly message: string;
  readonly stage: string;
  readonly path?: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly port?: string;
}): EditorDiagnostic {
  return Object.freeze({
    code: diagnostic.code,
    message: diagnostic.message,
    stage: diagnostic.stage,
    ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
    ...(diagnostic.nodeId === undefined ? {} : { nodeId: diagnostic.nodeId }),
    ...(diagnostic.edgeId === undefined ? {} : { edgeId: diagnostic.edgeId }),
    ...(diagnostic.port === undefined ? {} : { port: diagnostic.port }),
  });
}

/**
 * Compile editor Graph JSON through the frozen compiler stages.
 *
 * Validation, normalization, canonicalization, lowering and identity run in the
 * same order as every other compile path. The editor never gets a shortcut that
 * skips a stage, so what it shows as valid is exactly what the runtime accepts.
 */
export async function compileEditorGraph(
  document: unknown,
  sources: GraphSources,
  capabilityAuthority: GraphJsonV1DiagnosticContext["capabilityAuthority"],
): Promise<GraphCompileResult> {
  const resolver = createCompositeNodeResolver(sources);

  // 8.4: subgraph nodes expand into the saved graphs they name before anything else
  // checks the graph, so every later stage sees, and every run executes, one flat graph.
  let expanded: unknown = document;
  const subgraphNodeIds = new Set<string>();
  if (checkGraphJsonV1Shape(document).valid) {
    const authored = document as GraphJsonV1;
    for (const node of authored.nodes) {
      if (resolver.getManifest(node.type, node.version)?.control?.kind === "subgraph") {
        subgraphNodeIds.add(node.id);
      }
    }
    if (subgraphNodeIds.size > 0) {
      const expansion = expandGraphJsonV1Subgraphs(
        authored,
        resolver,
        sources.graphs ?? NO_SAVED_GRAPHS,
      );
      if (!expansion.valid) {
        return {
          valid: false,
          diagnostics: Object.freeze(
            expansion.diagnostics.map((diagnostic) =>
              locate(onAuthoredNode({ ...diagnostic, stage: "subgraphs" }, subgraphNodeIds)),
            ),
          ),
        };
      }
      expanded = expansion.graph;
    }
  }

  const checked = checkGraphJsonV1Diagnostics(expanded, { resolver, capabilityAuthority });
  if (!checked.valid) {
    return {
      valid: false,
      diagnostics: Object.freeze(
        checked.diagnostics.map((diagnostic) =>
          locate(onAuthoredNode(diagnostic, subgraphNodeIds)),
        ),
      ),
    };
  }

  const graph = expanded as GraphJsonV1;
  const normalizedResult = normalizeGraphJsonV1(graph, resolver);
  if (!normalizedResult.valid || normalizedResult.normalized === undefined) {
    return { valid: false, diagnostics: Object.freeze(normalizedResult.diagnostics.map(locate)) };
  }

  const normalized = normalizedResult.normalized;
  try {
    const canonical = canonicalizeGraphJsonV1Semantics(stripGraphJsonV1UiMetadata(normalized));
    const ir = lowerCanonicalGraphJsonV1ToExecutionIr(canonical, resolver);
    const identity = await recordGraphCompilerIdentityV1({ normalized, canonical, ir });
    return {
      valid: true,
      compiled: Object.freeze({
        graph,
        ir,
        identity,
        normalizedDocumentJson: JSON.stringify(normalized.document),
        canonicalSemanticsJson: canonical.canonicalSemanticsJson,
      }),
    };
  } catch (error: unknown) {
    // Lowering only sees graphs the validators accepted, so a throw here is a
    // compiler defect worth surfacing plainly rather than a user mistake.
    return {
      valid: false,
      diagnostics: Object.freeze([
        {
          code: "GRAPH_LOWERING_FAILED",
          message: error instanceof Error ? error.message : "Graph could not be lowered.",
          stage: "lowering",
        },
      ]),
    };
  }
}

/** A graph's stored document and the plan compiled from it. */
export interface StoredPlan {
  readonly documentHash: string;
  readonly compiledPlanId: number;
}

export interface CreatedRun {
  readonly runId: string;
  readonly compiledPlanId: number;
  readonly documentHash: string;
}

/**
 * Store a compiled graph and create a pending run for it.
 *
 * Identity rows are reused when the same content was stored before: a plan is
 * keyed by semantic hash, registry hash and compiler version, so re-running an
 * unchanged graph does not duplicate its plan. A graph revision id that already
 * names different content is refused rather than silently overwritten.
 */
/**
 * Store a compiled graph and return the plan a run can be created from.
 *
 * Storing is idempotent: the same document and the same compile identity resolve to
 * the rows already there, so triggers and the editor share one plan per graph.
 */
export async function storeCompiledGraph(
  database: SqliteDatabase,
  compiled: CompiledGraph,
  now: number = Date.now(),
): Promise<StoredPlan> {
  const { identity, graph } = compiled;
  // The durable control reducer does not track loop iterations yet, so one graph may
  // use loops or routers and joins, not both. Refuse it before storing a run.
  const kinds = new Set(compiled.ir.ops.map((op) => op.control?.kind));
  if (kinds.has("loop") && (kinds.has("router") || kinds.has("join"))) {
    throw new RuntimeGraphError(
      "GRAPH_INVALID",
      "Loops cannot yet be combined with Route or Wait nodes in the same graph.",
      422,
    );
  }
  let compiledPlanId = -1;

  await database.commit((connection) => {
    const existingRevision = connection
      .prepare(
        "SELECT document_hash AS hash FROM graph_sources WHERE graph_id = ? AND revision_id = ?",
      )
      .get(graph.graphId, graph.revisionId) as { readonly hash: string } | undefined;
    if (existingRevision !== undefined && existingRevision.hash !== identity.documentHash) {
      throw new RuntimeGraphError(
        "GRAPH_REVISION_CONFLICT",
        "This graph revision id is already stored with different content; save a new revision.",
        409,
      );
    }

    connection
      .prepare(
        `INSERT INTO graph_sources (document_hash, semantic_hash, hash_algorithm, graph_id,
          revision_id, normalized_document_json, canonical_semantics_json, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(document_hash) DO NOTHING`,
      )
      .run(
        identity.documentHash,
        identity.semanticHash,
        identity.hashAlgorithm,
        graph.graphId,
        graph.revisionId,
        compiled.normalizedDocumentJson,
        compiled.canonicalSemanticsJson,
        now,
      );

    const existingPlan = connection
      .prepare(
        `SELECT compiled_plan_id AS id FROM compiled_plans
         WHERE semantic_hash = ? AND registry_hash = ? AND compiler_version = ?`,
      )
      .get(identity.semanticHash, identity.registryHash, identity.compilerVersion) as
      { readonly id: number } | undefined;

    if (existingPlan === undefined) {
      const inserted = connection
        .prepare(
          `INSERT INTO compiled_plans (semantic_hash, registry_hash, compiler_version,
            hash_algorithm, ir_hash, execution_ir_json, node_pins_json, plugin_pins_json,
            created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          identity.semanticHash,
          identity.registryHash,
          identity.compilerVersion,
          identity.hashAlgorithm,
          identity.irHash,
          JSON.stringify(compiled.ir),
          JSON.stringify(identity.nodePins),
          JSON.stringify(identity.pluginPins),
          now,
        );
      compiledPlanId = Number(inserted.lastInsertRowid);
    } else {
      compiledPlanId = existingPlan.id;
    }

    connection
      .prepare(
        `INSERT INTO graph_compilations (document_hash, compiled_plan_id, semantic_hash, created_at_ms)
         VALUES (?, ?, ?, ?) ON CONFLICT(document_hash, compiled_plan_id) DO NOTHING`,
      )
      .run(identity.documentHash, compiledPlanId, identity.semanticHash, now);
  });

  return Object.freeze({ compiledPlanId, documentHash: identity.documentHash });
}

/**
 * The one durable path that starts a run.
 *
 * Every way of starting work — the editor, a trigger, a client — ends here, so a run
 * always begins as an ordinary `pending` run bound to a stored plan, and the
 * dispatcher admits it like any other.
 */
export async function createRunFromStoredPlan(
  database: SqliteDatabase,
  plan: StoredPlan,
  now: number = Date.now(),
  assertAuthority?: () => void,
): Promise<string> {
  const runId = `run-${createSortableId()}`;
  await database.commit((connection) => {
    assertAuthority?.();
    connection
      .prepare(
        `INSERT INTO runs (run_id, document_hash, compiled_plan_id, status, parent_run_id,
          fork_metadata_json, created_at_ms, started_at_ms, finished_at_ms)
         VALUES (?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)`,
      )
      .run(runId, plan.documentHash, plan.compiledPlanId, now);
  });
  return runId;
}

export async function createRunFromCompiledGraph(
  database: SqliteDatabase,
  compiled: CompiledGraph,
  now: number = Date.now(),
  assertAuthority?: () => void,
): Promise<CreatedRun> {
  const plan = await storeCompiledGraph(database, compiled, now);
  const runId = await createRunFromStoredPlan(database, plan, now, assertAuthority);
  return Object.freeze({ runId, ...plan });
}

export interface RunNodeState {
  /** Latest iteration: a loop body's current one, zero everywhere else. */
  readonly iteration: number;
  readonly opIndex: number;
  readonly nodeId: string;
  readonly type: string;
  readonly version: string;
  readonly status: string;
  readonly attemptsStarted: number;
}

export interface RunAttemptView {
  readonly iteration: number;
  readonly opIndex: number;
  readonly attempt: number;
  readonly status: string;
  readonly outputs: unknown;
  readonly error: unknown;
  readonly usage: unknown;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
}

export interface RunTimelineEvent {
  readonly eventId: number;
  readonly eventType: string;
  readonly opIndex: number | null;
  readonly attempt: number | null;
  readonly occurredAtMs: number;
}

/** Where a forked run came from, for the run view. */
export interface RunLineage {
  readonly parentRunId: string;
  /** The parent event the fork was cut after, when the fork recorded one. */
  readonly throughEventId: number | null;
  /** The parent checkpoint the frontier at the cut was rebuilt from. */
  readonly parentCheckpointId: number | null;
  /** The fork's own starting checkpoint. */
  readonly checkpointId: number | null;
}

/** A run forked from this one. */
export interface RunForkSummary {
  readonly runId: string;
  readonly status: string;
  readonly throughEventId: number | null;
  readonly createdAtMs: number;
}

export interface RunView {
  readonly runId: string;
  readonly status: string;
  readonly graphId: string;
  readonly revisionId: string;
  readonly createdAtMs: number;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly forkedFrom: RunLineage | null;
  readonly forks: readonly RunForkSummary[];
  readonly nodes: readonly RunNodeState[];
  readonly attempts: readonly RunAttemptView[];
  readonly timeline: readonly RunTimelineEvent[];
  readonly graph: unknown;
}

export interface RunSummary {
  readonly runId: string;
  readonly status: string;
  readonly graphId: string;
  readonly createdAtMs: number;
  readonly parentRunId: string | null;
}

const TIMELINE_LIMIT = 500;
const FORK_LIST_LIMIT = 50;

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function safeInteger(record: Readonly<Record<string, unknown>>, field: string): number | null {
  const value = record[field];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** The fork point a run recorded when it was created, as far as it can be read. */
function forkPointOf(metadataJson: string | null): {
  readonly throughEventId: number | null;
  readonly parentCheckpointId: number | null;
  readonly checkpointId: number | null;
} {
  const parsed = parseJson(metadataJson);
  const record =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : {};
  return {
    throughEventId: safeInteger(record, "throughEventId"),
    parentCheckpointId: safeInteger(record, "parentCheckpointId"),
    checkpointId: safeInteger(record, "checkpointId"),
  };
}

/**
 * Read one run for the inspector.
 *
 * Node state comes from the durable frontier, the same reconstruction recovery
 * uses, so the overlay shows what the runtime would resume from rather than a UI
 * guess. Stored values pass through `redact` before leaving the daemon.
 */
export function readRunView(
  database: SqliteDatabase,
  runId: string,
  redact: (value: unknown) => unknown,
): RunView {
  const connection = database.connection();
  const run = connection
    .prepare(
      `SELECT r.run_id AS runId, r.status AS status, r.created_at_ms AS createdAtMs,
        r.started_at_ms AS startedAtMs, r.finished_at_ms AS finishedAtMs,
        r.parent_run_id AS parentRunId, r.fork_metadata_json AS forkMetadataJson,
        g.graph_id AS graphId, g.revision_id AS revisionId,
        g.normalized_document_json AS documentJson
       FROM runs AS r JOIN graph_sources AS g ON g.document_hash = r.document_hash
       WHERE r.run_id = ?`,
    )
    .get(runId) as
    | {
        readonly runId: string;
        readonly status: string;
        readonly createdAtMs: number;
        readonly startedAtMs: number | null;
        readonly finishedAtMs: number | null;
        readonly parentRunId: string | null;
        readonly forkMetadataJson: string | null;
        readonly graphId: string;
        readonly revisionId: string;
        readonly documentJson: string;
      }
    | undefined;
  if (run === undefined) {
    throw new RuntimeGraphError("RUN_NOT_FOUND", "No run exists with this id.", 404);
  }

  const frontier = reconstructExecutionFrontier(connection, runId);
  const ops =
    (
      frontier.executionIr as unknown as {
        readonly ops?: readonly {
          readonly sourceNodeId: string;
          readonly type: string;
          readonly version: string;
        }[];
      }
    ).ops ?? [];

  const nodes = currentOps(frontier).map((op) =>
    Object.freeze({
      opIndex: op.opIndex,
      nodeId: ops[op.opIndex]?.sourceNodeId ?? `op-${String(op.opIndex)}`,
      type: ops[op.opIndex]?.type ?? "unknown",
      version: ops[op.opIndex]?.version ?? "unknown",
      status: op.status,
      iteration: op.iteration,
      attemptsStarted: op.attemptsStarted,
    }),
  );

  const attempts = (
    connection
      .prepare(
        `SELECT op_index AS opIndex, iteration, attempt, status, output_refs_json AS outputs,
          error_json AS error, usage_json AS usage, started_at_ms AS startedAtMs,
          finished_at_ms AS finishedAtMs
         FROM node_attempts WHERE run_id = ? ORDER BY op_index, iteration, attempt`,
      )
      .all(runId) as {
      readonly opIndex: number;
      readonly iteration: number;
      readonly attempt: number;
      readonly status: string;
      readonly outputs: string | null;
      readonly error: string | null;
      readonly usage: string | null;
      readonly startedAtMs: number;
      readonly finishedAtMs: number | null;
    }[]
  ).map((row) =>
    Object.freeze({
      opIndex: row.opIndex,
      iteration: row.iteration,
      attempt: row.attempt,
      status: row.status,
      outputs: redact(parseJson(row.outputs)),
      error: redact(parseJson(row.error)),
      usage: redact(parseJson(row.usage)),
      startedAtMs: row.startedAtMs,
      finishedAtMs: row.finishedAtMs,
    }),
  );

  // Event payloads are deliberately omitted: the timeline shows what happened
  // and when, and the inspector reads values from attempts, which are redacted.
  const timeline = (
    connection
      .prepare(
        `SELECT event_id AS eventId, event_type AS eventType, op_index AS opIndex,
          attempt, occurred_at_ms AS occurredAtMs
         FROM durable_events WHERE run_id = ? ORDER BY event_id LIMIT ?`,
      )
      .all(runId, TIMELINE_LIMIT) as unknown as RunTimelineEvent[]
  ).map((row) => Object.freeze({ ...row }));

  // A run's own parent column is authoritative; its fork metadata says where it was cut.
  const forkedFrom: RunLineage | null =
    run.parentRunId === null
      ? null
      : Object.freeze({
          parentRunId: run.parentRunId,
          ...forkPointOf(run.forkMetadataJson),
        });
  const forks = (
    connection
      .prepare(
        `SELECT run_id AS runId, status, fork_metadata_json AS forkMetadataJson,
          created_at_ms AS createdAtMs
         FROM runs WHERE parent_run_id = ? ORDER BY created_at_ms, run_id LIMIT ?`,
      )
      .all(runId, FORK_LIST_LIMIT) as unknown as {
      readonly runId: string;
      readonly status: string;
      readonly forkMetadataJson: string | null;
      readonly createdAtMs: number;
    }[]
  ).map((row) =>
    Object.freeze({
      runId: row.runId,
      status: row.status,
      throughEventId: forkPointOf(row.forkMetadataJson).throughEventId,
      createdAtMs: row.createdAtMs,
    }),
  );

  return Object.freeze({
    runId: run.runId,
    status: run.status,
    graphId: run.graphId,
    revisionId: run.revisionId,
    createdAtMs: run.createdAtMs,
    startedAtMs: run.startedAtMs,
    finishedAtMs: run.finishedAtMs,
    forkedFrom,
    forks: Object.freeze(forks),
    // The stored document, so the inspector draws the graph that actually ran.
    graph: redact(parseJson(run.documentJson)),
    nodes: Object.freeze(nodes),
    attempts: Object.freeze(attempts),
    timeline: Object.freeze(timeline),
  });
}

/** One stored revision of a graph, with the identities the compiler gave it. */
export interface GraphRevisionSummary {
  readonly graphId: string;
  readonly revisionId: string;
  readonly documentHash: string;
  readonly semanticHash: string;
  readonly createdAtMs: number;
  /** How many runs were started from this exact document. */
  readonly runs: number;
}

/**
 * Every stored revision of one graph, newest first.
 *
 * A revision is stored when a run or a trigger is created from it, so this is the
 * history of what was actually run, not every edit someone made in the editor.
 */
export function listGraphRevisions(
  database: SqliteDatabase,
  graphId: string,
  limit = 100,
): readonly GraphRevisionSummary[] {
  const rows = database
    .connection()
    .prepare(
      `SELECT g.graph_id AS graphId, g.revision_id AS revisionId, g.document_hash AS documentHash,
        g.semantic_hash AS semanticHash, g.created_at_ms AS createdAtMs,
        (SELECT COUNT(*) FROM runs WHERE runs.document_hash = g.document_hash) AS runs
       FROM graph_sources AS g WHERE g.graph_id = ?
       ORDER BY g.created_at_ms DESC, g.revision_id DESC LIMIT ?`,
    )
    .all(graphId, Math.max(1, Math.min(limit, 200))) as unknown as GraphRevisionSummary[];
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

/** The stored document of one revision, as it was when it ran. */
export function readGraphRevision(
  database: SqliteDatabase,
  graphId: string,
  revisionId: string,
): GraphJsonV1 | undefined {
  const row = database
    .connection()
    .prepare(
      `SELECT normalized_document_json AS json FROM graph_sources
       WHERE graph_id = ? AND revision_id = ?`,
    )
    .get(graphId, revisionId) as { readonly json: string } | undefined;
  if (row === undefined) return undefined;
  return JSON.parse(row.json) as GraphJsonV1;
}

/**
 * Compare two stored revisions of one graph.
 *
 * The stored semantic hashes settle whether the two would run the same way, so
 * nothing is recompiled to answer that; the diff explains it in a person's terms.
 */
export function diffGraphRevisions(
  database: SqliteDatabase,
  graphId: string,
  fromRevisionId: string,
  toRevisionId: string,
): GraphJsonDiffV1 {
  const before = readGraphRevision(database, graphId, fromRevisionId);
  const after = readGraphRevision(database, graphId, toRevisionId);
  if (before === undefined || after === undefined) {
    throw new RuntimeGraphError(
      "GRAPH_REVISION_NOT_FOUND",
      `No stored revision '${before === undefined ? fromRevisionId : toRevisionId}' of '${graphId}'.`,
      404,
    );
  }
  return diffGraphJsonV1(before, after);
}

/** Most recent runs first, for the run list. */
export function listRecentRuns(database: SqliteDatabase, limit = 50): readonly RunSummary[] {
  const rows = database
    .connection()
    .prepare(
      `SELECT r.run_id AS runId, r.status AS status, g.graph_id AS graphId,
        r.created_at_ms AS createdAtMs, r.parent_run_id AS parentRunId
       FROM runs AS r JOIN graph_sources AS g ON g.document_hash = r.document_hash
       ORDER BY r.created_at_ms DESC, r.run_id DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 200))) as unknown as RunSummary[];
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}
