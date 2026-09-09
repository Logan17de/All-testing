import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";

import { RUNTIME_DATABASE_MIGRATIONS, RuntimeDaemon } from "./runtime-daemon.js";
import {
  RuntimeHumanApprovals,
  type RuntimeApprovalAuthority,
} from "./runtime-human-approvals.js";
import { RuntimeHttpServer } from "./runtime-http-server.js";
import { reconstructExecutionFrontier } from "./runtime-recovery.js";
import { RuntimeRedactionRegistry, canonicalRuntimeJson } from "./runtime-redaction.js";

const databases: SqliteDatabase[] = [];
const servers: RuntimeHttpServer[] = [];
const directories: string[] = [];

function fixture(
  options: {
    readonly path?: string;
    readonly seed?: boolean;
    readonly capabilities?: readonly string[];
    readonly secondGate?: boolean;
  } = {},
) {
  const database = new SqliteDatabase({ path: options.path ?? ":memory:" });
  database.open();
  databases.push(database);
  runSqliteMigrations(database.connection(), RUNTIME_DATABASE_MIGRATIONS);
  if (options.seed === false) return database;
  const node = (id: string, dependencies: readonly number[], interrupt: boolean) => ({
    sourceNodeId: id,
    type: interrupt ? "harness.human-approval" : "test.effect",
    version: "1",
    config: {},
    inputs: [],
    dependencies,
    behavior: {
      primitiveFamily: interrupt ? "interrupt" : "pure",
      determinism: "nondeterministic",
      effect: "none",
      idempotency: "not-applicable",
      recovery: "manual",
      executionMode: "in-process",
      requiredCapabilities: interrupt ? [...(options.capabilities ?? [])] : [],
    },
  });
  const ir = {
    format: "harness.ir/v1",
    graphInputs: [],
    graphOutputs: [],
    ops: [
      node("approve", [], true),
      node("effect", options.secondGate ? [] : [0], options.secondGate ?? false),
    ],
    controlEdges: [],
    entrypoints: [],
    policies: { capabilities: { required: [], optional: [], deny: [] } },
  };
  const c = database.connection();
  c.prepare(`INSERT INTO graph_sources (document_hash, semantic_hash, hash_algorithm, graph_id,
    revision_id, normalized_document_json, canonical_semantics_json, created_at_ms)
    VALUES ('doc', 'sem', 'sha256', 'graph', 'rev', '{}', '{}', 1)`).run();
  c.prepare(`INSERT INTO compiled_plans (compiled_plan_id, semantic_hash, registry_hash,
    compiler_version, hash_algorithm, ir_hash, execution_ir_json, node_pins_json,
    plugin_pins_json, created_at_ms) VALUES (1, 'sem', 'registry', 'harness.compiler/v1',
    'sha256', 'ir', ?, '[]', '[]', 1)`).run(JSON.stringify(ir));
  c.prepare(`INSERT INTO graph_compilations (document_hash, compiled_plan_id, semantic_hash,
    created_at_ms) VALUES ('doc', 1, 'sem', 1)`).run();
  c.prepare(`INSERT INTO runs (run_id, document_hash, compiled_plan_id, status, parent_run_id,
    fork_metadata_json, created_at_ms, started_at_ms, finished_at_ms)
    VALUES ('run-1', 'doc', 1, 'running', NULL, NULL, 1, 1, NULL)`).run();
  return database;
}

function count(
  database: SqliteDatabase,
  table: "approvals" | "node_attempts" | "durable_events" | "run_checkpoints",
): number {
  return Number(database.connection().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
}

async function suspend(service: RuntimeHumanApprovals, opIndex = 0) {
  const result = await service.suspend({ runId: "run-1", opIndex, request: { prompt: "Proceed?" } });
  if (result.resumeToken === null) throw new Error("Expected a fresh test token.");
  return { approvalId: result.approval.approvalId, resumeToken: result.resumeToken };
}

async function serve(service: RuntimeHumanApprovals, redaction = new RuntimeRedactionRegistry()) {
  const server = new RuntimeHttpServer(
    { port: 0, allowedOrigins: ["http://localhost:3000"] },
    undefined,
    undefined,
    { approvals: service, redaction },
  );
  servers.push(server);
  await server.start();
  return { server, base: `http://127.0.0.1:${String(server.snapshot().port)}` };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const database of databases.splice(0)) {
    await database.drainWrites();
    database.close();
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable human approval transactions", () => {
  it("atomically stores a bound approval, token hash, waiting frontier, and checkpoint", async () => {
    const database = fixture();
    const service = new RuntimeHumanApprovals(database, { now: () => 100 });
    const credentials = await suspend(service);
    const approval = service.get(credentials.approvalId);
    expect(approval).toMatchObject({
      runId: "run-1",
      compiledPlanId: 1,
      opIndex: 0,
      iteration: 0,
      status: "pending",
      createdAtMs: 100,
    });
    expect(Reflect.has(approval, "resumeTokenHash")).toBe(false);
    const row = database.connection().prepare("SELECT * FROM approvals").get();
    expect(row?.resume_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(credentials.resumeToken);
    expect(count(database, "node_attempts")).toBe(0);
    expect(count(database, "run_checkpoints")).toBe(1);
    const frontier = reconstructExecutionFrontier(database.connection(), "run-1");
    expect(frontier.runStatus).toBe("waiting");
    expect(frontier.ops.map((op) => op.status)).toEqual(["waiting", "pending"]);
    expect(frontier.readyQueue).toEqual([]);
  });

  it("coalesces concurrent identical suspension requests without changing identity", async () => {
    const database = fixture();
    const service = new RuntimeHumanApprovals(database);
    const request = { runId: "run-1", opIndex: 0, request: { prompt: "Proceed?" } };
    const [first, second] = await Promise.all([service.suspend(request), service.suspend(request)]);
    expect(second.approval).toEqual(first.approval);
    expect(second).toMatchObject({ resumeToken: null, duplicate: true });
    expect(count(database, "approvals")).toBe(1);
    expect(count(database, "run_checkpoints")).toBe(1);
  });

  it("snapshots caller input before queued writes run", async () => {
    const database = fixture();
    const service = new RuntimeHumanApprovals(database);
    const input = { runId: "run-1", opIndex: 0, request: { prompt: "original" } };
    const pending = service.suspend(input);
    input.runId = "another-run";
    input.request.prompt = "changed";
    expect((await pending).approval.requestJson).toBe('{"prompt":"original"}');
  });

  it("survives a file-backed shutdown and completes the gate only once after reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zet-human-restart-"));
    directories.push(directory);
    const path = join(directory, "runtime.sqlite");
    const first = fixture({ path });
    const credentials = await suspend(new RuntimeHumanApprovals(first, { now: () => 100 }));
    first.close();
    const reopened = fixture({ path, seed: false });
    const service = new RuntimeHumanApprovals(reopened, { now: () => 200 });
    expect(service.listPending()).toHaveLength(1);
    expect(reconstructExecutionFrontier(reopened.connection(), "run-1").runStatus).toBe("waiting");
    const [a, b] = await Promise.all([
      service.resume({ ...credentials, decision: "approved", payload: { b: 2, a: 1 } }),
      service.resume({ ...credentials, decision: "approved", payload: { a: 1, b: 2 } }),
    ]);
    expect([a.duplicate, b.duplicate]).toEqual([false, true]);
    expect(count(reopened, "node_attempts")).toBe(1);
    expect(count(reopened, "run_checkpoints")).toBe(2);
    const frontier = reconstructExecutionFrontier(reopened.connection(), "run-1");
    expect(frontier.runStatus).toBe("running");
    expect(frontier.ops.map((op) => op.status)).toEqual(["completed", "ready"]);
    expect(frontier.readyQueue.map((op) => op.opIndex)).toEqual([1]);
    expect(frontier.ops[0]?.attemptsStarted).toBe(1);
    const outputs = reopened
      .connection()
      .prepare("SELECT output_refs_json FROM node_attempts")
      .get();
    expect(JSON.parse(String(outputs?.output_refs_json))).toEqual({
      response: { kind: "inline", value: { a: 1, b: 2 } },
    });
    await expect(service.resume({ ...credentials, decision: "rejected" })).rejects.toMatchObject({
      code: "APPROVAL_CONFLICT",
    });
    await expect(
      service.resume({ ...credentials, decision: "approved", payload: { a: 999 } }),
    ).rejects.toMatchObject({ code: "APPROVAL_CONFLICT" });
  });

  it("rotates lost tokens without persisting or accepting the old token", async () => {
    const database = fixture();
    const service = new RuntimeHumanApprovals(database);
    const old = await suspend(service);
    const current = await service.issueResumeToken(old.approvalId);
    expect(current.resumeToken).not.toBe(old.resumeToken);
    await expect(service.resume({ ...old, decision: "approved" })).rejects.toMatchObject({
      code: "APPROVAL_INVALID_TOKEN",
    });
    await expect(service.resume({ ...current, decision: "approved" })).resolves.toMatchObject({
      duplicate: false,
    });
    const journal = database.connection().prepare("SELECT payload_json FROM durable_events").all();
    expect(JSON.stringify(journal)).not.toContain(current.resumeToken);
    expect(JSON.stringify(journal)).not.toContain(old.resumeToken);
  });

  it("rejects expired approvals without consuming their tokens or releasing work", async () => {
    const database = fixture();
    let now = 100;
    const service = new RuntimeHumanApprovals(database, { now: () => now });
    const initial = await service.suspend({
      runId: "run-1",
      opIndex: 0,
      request: null,
      expiresAtMs: 101,
    });
    now = 101;
    await expect(
      service.resume({
        approvalId: initial.approval.approvalId,
        resumeToken: initial.resumeToken!,
        decision: "approved",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    expect(service.get(initial.approval.approvalId).status).toBe("pending");
    expect(count(database, "node_attempts")).toBe(0);
  });

  it("re-checks pinned host authority and never treats a human payload as a grant", async () => {
    const database = fixture({ capabilities: ["project:approve"] });
    let granted = true;
    const authority: RuntimeApprovalAuthority = {
      evaluate: () => ({ decision: granted ? "allow" : "deny" }),
    };
    const service = new RuntimeHumanApprovals(database, { authority });
    const credentials = await suspend(service);
    granted = false;
    authority.evaluate = () => ({ decision: "allow" });
    await expect(
      service.resume({
        ...credentials,
        decision: "approved",
        payload: { granted: ["project:approve"] },
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      remediation: "request-host-authorization",
    });
    expect(count(database, "node_attempts")).toBe(0);
    // Rejecting a request reduces authority and remains possible after revocation.
    await expect(service.resume({ ...credentials, decision: "rejected" })).resolves.toMatchObject({
      duplicate: false,
    });
    expect(reconstructExecutionFrontier(database.connection(), "run-1").runStatus).toBe("cancelled");
  });

  it("cancels sibling waits on rejection without pretending any gate executed", async () => {
    const database = fixture({ secondGate: true });
    const service = new RuntimeHumanApprovals(database);
    const first = await suspend(service, 0);
    const second = await suspend(service, 1);
    await service.resume({ ...first, decision: "rejected" });
    expect(service.get(second.approvalId).status).toBe("cancelled");
    expect(service.listPending()).toEqual([]);
    expect(count(database, "node_attempts")).toBe(0);
    expect(
      reconstructExecutionFrontier(database.connection(), "run-1").ops.map((op) => op.status),
    ).toEqual(["cancelled", "cancelled"]);
  });

  it("rolls back decision, output, events and frontier together when checkpoint writing fails", async () => {
    const database = fixture();
    const service = new RuntimeHumanApprovals(database);
    const credentials = await suspend(service);
    const eventsBefore = count(database, "durable_events");
    database.connection().exec(`CREATE TRIGGER inject_resume_failure BEFORE INSERT ON checkpoint_op_frontier
      WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END`);
    await expect(service.resume({ ...credentials, decision: "approved" })).rejects.toThrow(
      "injected checkpoint failure",
    );
    expect(service.get(credentials.approvalId).status).toBe("pending");
    expect(count(database, "node_attempts")).toBe(0);
    expect(count(database, "durable_events")).toBe(eventsBefore);
    expect(count(database, "run_checkpoints")).toBe(1);
    database.connection().exec("DROP TRIGGER inject_resume_failure");
    await expect(service.resume({ ...credentials, decision: "approved" })).resolves.toMatchObject({
      duplicate: false,
    });
  });

  it("refuses to checkpoint a run containing active execution", async () => {
    const database = fixture({ secondGate: true });
    database
      .connection()
      .prepare(`INSERT INTO durable_events (run_id, event_type, event_schema_version,
        op_index, iteration, attempt, occurred_at_ms, payload_json)
        VALUES ('run-1', 'harness.frontier.op', 1, 1, 0, NULL, 10, ?)`)
      .run(
        canonicalRuntimeJson({
          status: "running",
          remainingDependencies: 0,
          attemptsStarted: 1,
          attemptBudgetUsed: 1,
          readyOrder: null,
          retryNotBeforeMs: null,
        }),
      );
    await expect(suspend(new RuntimeHumanApprovals(database))).rejects.toMatchObject({
      code: "APPROVAL_RUN_NOT_QUIESCENT",
    });
    expect(count(database, "approvals")).toBe(0);
  });

  it("rejects protected material before mutation and retains immutable audit records", async () => {
    const database = fixture();
    const redaction = new RuntimeRedactionRegistry();
    redaction.registerSecret("private-material");
    const service = new RuntimeHumanApprovals(database, { redaction });
    expect(() =>
      service.suspend({ runId: "run-1", opIndex: 0, request: { prompt: "private-material" } }),
    ).toThrow("protected material");
    const credentials = await suspend(service);
    expect(() =>
      service.resume({ ...credentials, decision: "approved", payload: { comment: "private-material" } }),
    ).toThrow("protected material");
    expect(() => database.connection().exec("UPDATE approvals SET op_index = 1")).toThrow("immutable");
    expect(() => database.connection().exec("DELETE FROM approvals")).toThrow("retained");
    await service.resume({ ...credentials, decision: "approved" });
    expect(() => database.connection().exec("UPDATE approvals SET response_json = '{}' ")).toThrow("immutable");
  });
});

describe("protected approval HTTP surface", () => {
  it("protects session, reads, CORS and host routing before exposing approval data", async () => {
    const service = new RuntimeHumanApprovals(fixture());
    await suspend(service);
    const { base } = await serve(service);
    const hostileHeaders: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { host: "evil.example", "x-forwarded-host": "127.0.0.1" },
    ];
    for (const headers of hostileHeaders) {
      const response = await fetch(`${base}/api/session`, { headers });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("csrfToken");
    }
    const allowed = await fetch(`${base}/api/approvals`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const preflight = await fetch(`${base}/api/approvals`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000" },
    });
    expect(preflight.status).toBe(204);
  });

  it("requires CSRF and JSON, validates exact fields, and exposes duplicate-safe resume", async () => {
    const database = fixture();
    const service = new RuntimeHumanApprovals(database);
    const credentials = await suspend(service);
    const { base } = await serve(service);
    const session = (await (await fetch(`${base}/api/session`)).json()) as { csrfToken: string };
    const path = `${base}/api/approvals/${encodeURIComponent(credentials.approvalId)}/resume`;
    const body = {
      resumeToken: credentials.resumeToken,
      decision: "approved",
      payload: { message: "yes" },
    };
    const missing = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(missing.status).toBe(403);
    const text = await fetch(path, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-zet-csrf": session.csrfToken },
      body: JSON.stringify(body),
    });
    expect(text.status).toBe(415);
    const headers = { "content-type": "application/json", "x-zet-csrf": session.csrfToken };
    const extra = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, grant: true }),
    });
    expect(extra.status).toBe(400);
    const malformed = await fetch(path, { method: "POST", headers, body: "{" });
    expect(malformed.status).toBe(400);
    const tooLarge = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, payload: "x".repeat(70_000) }),
    });
    expect(tooLarge.status).toBe(413);
    expect(count(database, "node_attempts")).toBe(0);
    for (const duplicate of [false, true]) {
      const response = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ duplicate });
    }
    expect(count(database, "node_attempts")).toBe(1);
  });

  it("delivers replacement resume tokens only through a protected POST", async () => {
    const service = new RuntimeHumanApprovals(fixture());
    const credentials = await suspend(service);
    const { base } = await serve(service);
    const path = `${base}/api/approvals/${encodeURIComponent(credentials.approvalId)}/token`;
    expect((await fetch(path)).status).toBe(405);
    const { csrfToken } = (await (await fetch(`${base}/api/session`)).json()) as { csrfToken: string };
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zet-csrf": csrfToken },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const next = (await response.json()) as { resumeToken: string };
    expect(next.resumeToken).not.toBe(credentials.resumeToken);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("redacts stream payloads before they enter the daemon replay buffer", async () => {
    const redaction = new RuntimeRedactionRegistry();
    redaction.registerSecret("private-value");
    const daemon = new RuntimeDaemon({ api: { port: 0 }, database: { path: ":memory:" }, redaction });
    try {
      await daemon.start();
      const event = daemon.publishEvent("test.safe", {
        detail: "saw private-value",
        apiKey: "another-value",
      });
      expect(event.data).not.toContain("private-value");
      expect(event.data).not.toContain("another-value");
    } finally {
      await daemon.stop();
    }
  });
});
