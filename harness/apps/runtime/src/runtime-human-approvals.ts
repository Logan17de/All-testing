import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { SqliteDatabase } from "@zet-harness/db";
import type { DurableApprovalRecord } from "@zet-harness/db/durable-approval-records";
import { generateLogicalEffectId } from "@zet-harness/db/durable-node-invocation";

import { RuntimeApprovalError } from "./runtime-approval-error.js";
import {
  RuntimeRedactionRegistry,
  canonicalRuntimeJson,
  type SafeJson,
} from "./runtime-redaction.js";
import {
  reconstructExecutionFrontier,
  type RecoveredExecutionFrontier,
  type RecoveredOpFrontier,
} from "./runtime-recovery.js";

export interface RuntimeApprovalAuthority {
  evaluate(capability: string): { readonly decision: "allow" | "deny" };
}

export interface SuspendForApprovalInput {
  readonly runId: string;
  readonly opIndex: number;
  readonly request: unknown;
  readonly expiresAtMs?: number;
}

export interface ResumeApprovalInput {
  readonly approvalId: string;
  readonly resumeToken: string;
  readonly decision: "approved" | "rejected";
  readonly payload?: unknown;
}

interface StoredApproval extends DurableApprovalRecord {
  readonly resumeTokenHash: string;
  readonly responseHash: string | null;
}

const APPROVAL_SELECT = `SELECT
  approval_id AS approvalId, run_id AS runId, compiled_plan_id AS compiledPlanId,
  op_index AS opIndex, iteration, logical_effect_id AS logicalEffectId,
  checkpoint_id AS checkpointId, status, request_json AS requestJson,
  response_json AS responseJson, created_at_ms AS createdAtMs,
  expires_at_ms AS expiresAtMs, resolved_at_ms AS resolvedAtMs,
  resume_token_hash AS resumeTokenHash, response_hash AS responseHash FROM approvals`;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tokenHash(token: string): string {
  return digest(`zet-approval-resume/v1\u0000${token}`);
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function assertId(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim()
  ) {
    throw new RuntimeApprovalError("APPROVAL_INVALID_REQUEST");
  }
}

function publicRecord(row: StoredApproval): DurableApprovalRecord {
  return Object.freeze({
    approvalId: row.approvalId,
    runId: row.runId,
    compiledPlanId: row.compiledPlanId,
    opIndex: row.opIndex,
    iteration: row.iteration,
    logicalEffectId: row.logicalEffectId,
    checkpointId: row.checkpointId,
    status: row.status,
    requestJson: row.requestJson,
    responseJson: row.responseJson,
    createdAtMs: row.createdAtMs,
    expiresAtMs: row.expiresAtMs,
    resolvedAtMs: row.resolvedAtMs,
  });
}

function load(connection: DatabaseSync, approvalId: string): StoredApproval {
  const row = connection
    .prepare(`${APPROVAL_SELECT} WHERE approval_id = ?`)
    .get(approvalId) as StoredApproval | undefined;
  if (row === undefined) throw new RuntimeApprovalError("APPROVAL_NOT_FOUND");
  return row;
}

function assertPending(row: StoredApproval, now: number): void {
  if (row.status !== "pending") throw new RuntimeApprovalError("APPROVAL_CONFLICT");
  if (row.expiresAtMs !== null && now >= row.expiresAtMs) {
    throw new RuntimeApprovalError("APPROVAL_EXPIRED");
  }
  if (now < row.createdAtMs) throw new RuntimeApprovalError("APPROVAL_INVALID_REQUEST");
}

function appendEvent(
  connection: DatabaseSync,
  runId: string,
  type: string,
  now: number,
  payload: unknown,
  opIndex: number | null = null,
): number {
  const result = connection
    .prepare(`INSERT INTO durable_events (
      run_id, event_type, event_schema_version, op_index, iteration, attempt,
      occurred_at_ms, payload_json
    ) VALUES (?, ?, 1, ?, ?, NULL, ?, ?)`)
    .run(runId, type, opIndex, opIndex === null ? null : 0, now, canonicalRuntimeJson(payload));
  return Number(result.lastInsertRowid);
}

/** Write a complete quiescent snapshot using the existing v5 sparse-frontier representation. */
function checkpoint(
  connection: DatabaseSync,
  frontier: RecoveredExecutionFrontier,
  ops: readonly RecoveredOpFrontier[],
  now: number,
): number {
  let cursor = 0;
  for (const state of ops) {
    cursor = appendEvent(
      connection,
      frontier.runId,
      "harness.frontier.op",
      now,
      state,
      state.opIndex,
    );
  }
  const header = connection
    .prepare(`INSERT INTO run_checkpoints (
      run_id, through_event_id, checkpoint_schema_version, created_at_ms
    ) VALUES (?, ?, 1, ?)`)
    .run(frontier.runId, cursor, now);
  const checkpointId = Number(header.lastInsertRowid);
  const insertOp = connection.prepare(`INSERT INTO checkpoint_op_frontier (
    checkpoint_id, op_index, iteration, status, remaining_dependencies, attempts_started,
    attempt_budget_used, ready_order, retry_not_before_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const state of ops) {
    insertOp.run(
      checkpointId,
      state.opIndex,
      state.iteration,
      state.status,
      state.remainingDependencies,
      state.attemptsStarted,
      state.attemptBudgetUsed,
      state.readyOrder,
      state.retryNotBeforeMs,
    );
  }
  const insertEdge = connection.prepare(`INSERT INTO checkpoint_control_edges
    (checkpoint_id, edge_index, iteration, status) VALUES (?, ?, ?, ?)`);
  for (const edge of frontier.controlEdges) {
    if (edge.status !== "unresolved") {
      insertEdge.run(checkpointId, edge.edgeIndex, edge.iteration, edge.status);
    }
  }
  return checkpointId;
}

/**
 * Durable approval gates for quiescent, iteration-zero plain DAGs.
 *
 * The host dispatches interrupt primitives here, never to plugin execute(). A wait
 * is committed state, not a live Promise. Approval completes only the human gate;
 * it never executes a downstream effect or changes host capabilities. The existing
 * scheduler/driver can dispatch the recovered ready frontier after the commit.
 */
export class RuntimeHumanApprovals {
  readonly #database: SqliteDatabase;
  readonly #redaction: RuntimeRedactionRegistry;
  readonly #evaluate: RuntimeApprovalAuthority["evaluate"] | undefined;
  readonly #now: () => number;

  constructor(
    database: SqliteDatabase,
    options: {
      readonly redaction?: RuntimeRedactionRegistry;
      readonly authority?: RuntimeApprovalAuthority;
      readonly now?: () => number;
    } = {},
  ) {
    this.#database = database;
    this.#redaction = options.redaction ?? new RuntimeRedactionRegistry();
    this.#evaluate = options.authority?.evaluate.bind(options.authority);
    this.#now = options.now ?? Date.now;
  }

  get(approvalId: string): DurableApprovalRecord {
    assertId(approvalId);
    return publicRecord(load(this.#database.connection(), approvalId));
  }

  listPending(runId?: string, limit = 100): readonly DurableApprovalRecord[] {
    if (runId !== undefined) assertId(runId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RuntimeApprovalError("APPROVAL_INVALID_REQUEST");
    }
    const rows = this.#database
      .connection()
      .prepare(`${APPROVAL_SELECT}
        WHERE status = 'pending' AND (? IS NULL OR run_id = ?)
        ORDER BY created_at_ms, approval_id LIMIT ?`)
      .all(runId ?? null, runId ?? null, limit) as unknown as StoredApproval[];
    return Object.freeze(rows.map(publicRecord));
  }

  suspend(input: SuspendForApprovalInput): Promise<{
    readonly approval: DurableApprovalRecord;
    readonly resumeToken: string | null;
    readonly duplicate: boolean;
  }> {
    // Snapshot all caller data before entering the queued transaction.
    const { runId, opIndex, expiresAtMs } = input;
    assertId(runId);
    if (!Number.isSafeInteger(opIndex) || opIndex < 0) {
      throw new RuntimeApprovalError("APPROVAL_INVALID_REQUEST");
    }
    const requestJson = this.safeJson(input.request);
    return this.#database.commit((connection) => {
      const existing = connection
        .prepare(`${APPROVAL_SELECT}
          WHERE run_id = ? AND op_index = ? AND iteration = 0`)
        .get(runId, opIndex) as StoredApproval | undefined;
      if (existing !== undefined) {
        if (
          existing.requestJson !== requestJson ||
          existing.expiresAtMs !== (expiresAtMs ?? null)
        ) {
          throw new RuntimeApprovalError("APPROVAL_CONFLICT");
        }
        return { approval: publicRecord(existing), resumeToken: null, duplicate: true };
      }
      const now = this.now();
      if (
        expiresAtMs !== undefined &&
        (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now)
      ) {
        throw new RuntimeApprovalError("APPROVAL_INVALID_REQUEST");
      }
      const frontier = this.frontier(connection, runId, opIndex);
      const state = frontier.ops.find((op) => op.opIndex === opIndex);
      if (state?.status !== "ready" || state.attemptsStarted !== 0) {
        throw new RuntimeApprovalError("APPROVAL_CONFLICT");
      }
      const approvalId = `approval-v1:${randomUUID()}`;
      const resumeToken = this.freshToken();
      const invocation = connection
        .prepare(`SELECT logical_effect_id AS id FROM node_invocations
          WHERE run_id = ? AND op_index = ? AND iteration = 0`)
        .get(runId, opIndex) as { readonly id: string } | undefined;
      const logicalEffectId = invocation?.id ?? generateLogicalEffectId();
      if (invocation === undefined) {
        connection
          .prepare(`INSERT INTO node_invocations
            (run_id, op_index, iteration, logical_effect_id, created_at_ms)
            VALUES (?, ?, 0, ?, ?)`)
          .run(runId, opIndex, logicalEffectId, now);
      }
      appendEvent(connection, runId, "harness.approval.requested", now, { approvalId }, opIndex);
      const ops = frontier.ops.map((op): RecoveredOpFrontier =>
        op.opIndex === opIndex ? { ...op, status: "waiting", readyOrder: null } : op,
      );
      const checkpointId = checkpoint(connection, frontier, ops, now);
      connection
        .prepare(`INSERT INTO approvals (
          approval_id, run_id, compiled_plan_id, op_index, iteration, logical_effect_id,
          checkpoint_id, status, request_json, resume_token_hash, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, 0, ?, ?, 'pending', ?, ?, ?, ?)`)
        .run(
          approvalId,
          runId,
          frontier.compiledPlanId,
          opIndex,
          logicalEffectId,
          checkpointId,
          requestJson,
          tokenHash(resumeToken),
          now,
          expiresAtMs ?? null,
        );
      connection.prepare("UPDATE runs SET status = 'waiting' WHERE run_id = ?").run(runId);
      return { approval: publicRecord(load(connection, approvalId)), resumeToken, duplicate: false };
    });
  }

  /** Protected local UI/host operation; recovers access after losing the initial response. */
  issueResumeToken(
    approvalId: string,
  ): Promise<{ readonly approvalId: string; readonly resumeToken: string }> {
    assertId(approvalId);
    return this.#database.commit((connection) => {
      const row = load(connection, approvalId);
      const now = this.now();
      assertPending(row, now);
      const frontier = this.frontier(connection, row.runId, row.opIndex, false);
      if (
        frontier.runStatus !== "waiting" ||
        frontier.compiledPlanId !== row.compiledPlanId ||
        frontier.ops.find((op) => op.opIndex === row.opIndex)?.status !== "waiting"
      ) {
        throw new RuntimeApprovalError("APPROVAL_CONFLICT");
      }
      const resumeToken = this.freshToken();
      connection
        .prepare("UPDATE approvals SET resume_token_hash = ? WHERE approval_id = ?")
        .run(tokenHash(resumeToken), approvalId);
      appendEvent(
        connection,
        row.runId,
        "harness.approval.token-rotated",
        now,
        { approvalId },
        row.opIndex,
      );
      return { approvalId, resumeToken };
    });
  }

  resume(input: ResumeApprovalInput): Promise<{
    readonly approval: DurableApprovalRecord;
    readonly duplicate: boolean;
  }> {
    const { approvalId, resumeToken, decision } = input;
    assertId(approvalId);
    if (typeof resumeToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(resumeToken)) {
      throw new RuntimeApprovalError("APPROVAL_INVALID_TOKEN");
    }
    if (decision !== "approved" && decision !== "rejected") {
      throw new RuntimeApprovalError("APPROVAL_INVALID_REQUEST");
    }
    const responseJson = this.safeJson(input.payload ?? null);
    const responseHash = digest(
      canonicalRuntimeJson({ decision, payload: JSON.parse(responseJson) as SafeJson }),
    );
    const suppliedHash = tokenHash(resumeToken);
    return this.#database.commit((connection) => {
      const row = load(connection, approvalId);
      if (
        !timingSafeEqual(Buffer.from(row.resumeTokenHash, "hex"), Buffer.from(suppliedHash, "hex"))
      ) {
        throw new RuntimeApprovalError("APPROVAL_INVALID_TOKEN");
      }
      // A lost HTTP response can be retried even after the run subsequently advances.
      if (row.status !== "pending") {
        if (row.status === decision && row.responseHash === responseHash) {
          return { approval: publicRecord(row), duplicate: true };
        }
        throw new RuntimeApprovalError("APPROVAL_CONFLICT");
      }
      const now = this.now();
      assertPending(row, now);
      const frontier = this.frontier(connection, row.runId, row.opIndex, decision === "approved");
      const gate = frontier.ops.find((op) => op.opIndex === row.opIndex);
      if (
        frontier.runStatus !== "waiting" ||
        frontier.compiledPlanId !== row.compiledPlanId ||
        gate?.status !== "waiting" ||
        gate.attemptsStarted !== 0
      ) {
        throw new RuntimeApprovalError("APPROVAL_CONFLICT");
      }
      connection
        .prepare(`UPDATE approvals SET status = ?, response_json = ?, response_hash = ?,
          resolved_at_ms = ? WHERE approval_id = ? AND status = 'pending'`)
        .run(decision, responseJson, responseHash, now, approvalId);
      let readyOrder = Math.max(-1, ...frontier.ops.map((op) => op.readyOrder ?? -1)) + 1;
      const ops = frontier.ops.map((op): RecoveredOpFrontier => {
        if (decision === "rejected") {
          if (["completed", "skipped", "failed", "cancelled"].includes(op.status)) return op;
          return { ...op, status: "cancelled", readyOrder: null, retryNotBeforeMs: null };
        }
        if (op.opIndex === row.opIndex) {
          return { ...op, status: "completed", attemptsStarted: 1, attemptBudgetUsed: 1 };
        }
        if (
          op.status === "pending" &&
          frontier.executionIr.ops[op.opIndex]?.dependencies.includes(row.opIndex)
        ) {
          const remainingDependencies = op.remainingDependencies - 1;
          if (remainingDependencies < 0) throw new RuntimeApprovalError("APPROVAL_CONFLICT");
          return {
            ...op,
            remainingDependencies,
            status: remainingDependencies === 0 ? "ready" : "pending",
            readyOrder: remainingDependencies === 0 ? readyOrder++ : null,
          };
        }
        return op;
      });
      if (decision === "approved") {
        connection
          .prepare(`INSERT INTO node_attempts (
            run_id, op_index, iteration, attempt, logical_effect_id, status, input_refs_json,
            output_refs_json, error_json, usage_json, started_at_ms, finished_at_ms
          ) VALUES (?, ?, 0, 1, ?, 'completed', '{}', ?, NULL, NULL, ?, ?)`)
          .run(
            row.runId,
            row.opIndex,
            row.logicalEffectId,
            canonicalRuntimeJson({
              response: { kind: "inline", value: JSON.parse(responseJson) as SafeJson },
            }),
            row.createdAtMs,
            now,
          );
      } else {
        connection
          .prepare(`UPDATE approvals SET status = 'cancelled', response_json = 'null',
            response_hash = ?, resolved_at_ms = ? WHERE run_id = ? AND status = 'pending'`)
          .run(digest("cancelled"), now, row.runId);
      }
      appendEvent(
        connection,
        row.runId,
        "harness.approval.resolved",
        now,
        { approvalId, decision },
        row.opIndex,
      );
      const edges = frontier.controlEdges.map((edge) => {
        if (
          decision === "approved" &&
          frontier.executionIr.controlEdges[edge.edgeIndex]?.from.op === row.opIndex
        ) {
          return { ...edge, status: "completed" as const };
        }
        return edge;
      });
      checkpoint(connection, { ...frontier, controlEdges: edges }, ops, now);
      const status =
        decision === "rejected"
          ? "cancelled"
          : ops.every((op) => op.status === "completed")
            ? "completed"
            : ops.some((op) => op.status === "waiting")
              ? "waiting"
              : "running";
      connection
        .prepare("UPDATE runs SET status = ?, finished_at_ms = ? WHERE run_id = ?")
        .run(status, status === "cancelled" || status === "completed" ? now : null, row.runId);
      return { approval: publicRecord(load(connection, approvalId)), duplicate: false };
    });
  }

  private now(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RuntimeApprovalError("APPROVAL_INVALID_REQUEST");
    }
    return now;
  }

  private safeJson(value: unknown): string {
    try {
      return this.#redaction.assertSafe(value);
    } catch {
      throw new RuntimeApprovalError("APPROVAL_INVALID_REQUEST");
    }
  }

  private freshToken(): string {
    const token = randomBytes(32).toString("base64url");
    this.#redaction.registerSecret(token);
    return token;
  }

  private frontier(
    connection: DatabaseSync,
    runId: string,
    opIndex: number,
    authorize = true,
  ): RecoveredExecutionFrontier {
    const frontier = reconstructExecutionFrontier(connection, runId);
    if (frontier.runStatus !== "running" && frontier.runStatus !== "waiting") {
      throw new RuntimeApprovalError("APPROVAL_CONFLICT");
    }
    if (
      frontier.preCrashRunningAttempts.length > 0 ||
      frontier.ops.some((op) => op.status === "running" || op.status === "retry-wait")
    ) {
      throw new RuntimeApprovalError("APPROVAL_RUN_NOT_QUIESCENT");
    }
    const ir = frontier.executionIr as unknown as {
      readonly ops: readonly {
        readonly control?: unknown;
        readonly behavior: {
          readonly primitiveFamily: string;
          readonly effect: string;
          readonly requiredCapabilities: readonly string[];
        };
      }[];
      readonly policies: {
        readonly capabilities: {
          readonly required: readonly string[];
          readonly deny: readonly string[];
        };
      };
    };
    const gate = ir.ops[opIndex];
    if (
      gate?.behavior.primitiveFamily !== "interrupt" ||
      gate.behavior.effect !== "none" ||
      ir.ops.some((op) => op.control !== undefined) ||
      frontier.ops.some((op) => op.iteration !== 0)
    ) {
      throw new RuntimeApprovalError("APPROVAL_UNSUPPORTED_GRAPH");
    }
    const intent = ir.policies?.capabilities;
    if (
      intent === undefined ||
      !isStringList(intent.required) ||
      !isStringList(intent.deny) ||
      !isStringList(gate.behavior.requiredCapabilities)
    ) {
      throw new RuntimeApprovalError("APPROVAL_UNSUPPORTED_GRAPH");
    }
    for (const capability of authorize
      ? new Set([...intent.required, ...gate.behavior.requiredCapabilities])
      : []) {
      if (
        intent.deny.includes(capability) ||
        this.#evaluate?.(capability).decision !== "allow"
      ) {
        throw new RuntimeApprovalError("PERMISSION_DENIED");
      }
    }
    return frontier;
  }
}
