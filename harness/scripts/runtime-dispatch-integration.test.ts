import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CapabilityPermissionPolicy,
  PluginHost,
  createHumanApprovalPlugin,
} from "@zet-harness/core";
import { SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import {
  GRAPH_JSON_VERSION,
  canonicalizeGraphJsonV1Semantics,
  checkGraphJsonV1Diagnostics,
  lowerCanonicalGraphJsonV1ToExecutionIr,
  normalizeGraphJsonV1,
  stripGraphJsonV1UiMetadata,
  type ExecutionIrV1,
  type GraphJsonV1,
} from "@zet-harness/graph";
import { PLUGIN_API_VERSION, type NodeDefinition } from "@zet-harness/plugin-api";
import { createMockExecutionIr, createMockExecutionOp } from "@zet-harness/scheduler/testing";
import { RUNTIME_DATABASE_MIGRATIONS, RuntimeDaemon } from "../apps/runtime/src/runtime-daemon.js";
import {
  RuntimeHumanApprovals,
  type RuntimeApprovalAuthority,
} from "../apps/runtime/src/runtime-human-approvals.js";
import { reconstructExecutionFrontier } from "../apps/runtime/src/runtime-recovery.js";
import { RuntimeRedactionRegistry } from "../apps/runtime/src/runtime-redaction.js";
import {
  RuntimeRunDispatcher,
  type RuntimeExecutionOptions,
} from "../apps/runtime/src/runtime-run-dispatcher.js";

const roots: string[] = [];
const daemons: RuntimeDaemon[] = [];
const databases: SqliteDatabase[] = [];
const dispatchers: RuntimeRunDispatcher[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function seed(ir: ExecutionIrV1, path = ":memory:"): SqliteDatabase {
  const database = new SqliteDatabase({ path });
  database.open();
  databases.push(database);
  const c = database.connection();
  runSqliteMigrations(c, RUNTIME_DATABASE_MIGRATIONS);
  c.prepare(
    `INSERT INTO graph_sources (document_hash, semantic_hash, hash_algorithm, graph_id,
    revision_id, normalized_document_json, canonical_semantics_json, created_at_ms)
    VALUES ('doc', 'sem', 'sha256', 'graph', 'rev', '{}', '{}', 1)`,
  ).run();
  c.prepare(
    `INSERT INTO compiled_plans (compiled_plan_id, semantic_hash, registry_hash,
    compiler_version, hash_algorithm, ir_hash, execution_ir_json, node_pins_json,
    plugin_pins_json, created_at_ms) VALUES (1, 'sem', 'registry', 'harness.compiler/v1',
    'sha256', 'ir', ?, '[]', '[]', 1)`,
  ).run(JSON.stringify(ir));
  c.prepare(
    `INSERT INTO graph_compilations (document_hash, compiled_plan_id, semantic_hash,
    created_at_ms) VALUES ('doc', 1, 'sem', 1)`,
  ).run();
  c.prepare(
    `INSERT INTO runs (run_id, document_hash, compiled_plan_id, status, parent_run_id,
    fork_metadata_json, created_at_ms, started_at_ms, finished_at_ms)
    VALUES ('run-1', 'doc', 1, 'pending', NULL, NULL, 1, NULL, NULL)`,
  ).run();
  return database;
}

function attach(
  database: SqliteDatabase,
  options: RuntimeExecutionOptions,
  authority: RuntimeApprovalAuthority = new CapabilityPermissionPolicy(),
) {
  const redaction = new RuntimeRedactionRegistry();
  const approvals = new RuntimeHumanApprovals(database, {
    redaction,
    authority,
    onResolved: (id) => {
      dispatcher.wake(id);
    },
  });
  const dispatcher = new RuntimeRunDispatcher(database, approvals, options, redaction, authority);
  dispatchers.push(dispatcher);
  dispatcher.start();
  return { dispatcher, approvals, redaction };
}

async function compiledGraph(): Promise<ExecutionIrV1> {
  const host = new PluginHost();
  const plain = (type: string, write: boolean): NodeDefinition => ({
    manifest: {
      type,
      version: "1",
      title: type,
      inputs: { value: { schema: true } },
      outputs: { value: { schema: true } },
      configSchema: true,
      behavior: {
        primitiveFamily: write ? "effect" : "pure",
        determinism: "deterministic",
        effect: write ? "external-write" : "none",
        idempotency: write ? "unknown" : "not-applicable",
        recovery: write ? "manual" : "rerun",
        executionMode: "in-process",
        requiredCapabilities: write ? ["fs:write"] : [],
      },
    },
    execute: () => ({ outputs: {} }),
  });
  try {
    await host.activate(createHumanApprovalPlugin());
    await host.activate({
      manifest: {
        id: "test.nodes",
        name: "Nodes",
        version: "1",
        apiVersion: PLUGIN_API_VERSION,
        capabilities: [{ id: "fs:write" }],
      },
      activate(context) {
        context.nodes.register(plain("test.prepare", false));
        context.nodes.register(plain("test.write", true));
      },
    });
    const source: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "dispatch-proof",
      revisionId: "1",
      inputs: [],
      outputs: [{ id: "result", schema: true, source: { nodeId: "c-write", port: "value" } }],
      nodes: [
        { id: "a-prepare", type: "test.prepare", version: "1", config: {} },
        {
          id: "b-human",
          type: "harness.human-approval",
          version: "1",
          config: { prompt: "Write the result?" },
        },
        { id: "c-write", type: "test.write", version: "1", config: {} },
      ],
      edges: [
        {
          id: "prepare-human",
          kind: "control",
          from: { nodeId: "a-prepare" },
          to: { nodeId: "b-human" },
        },
        {
          id: "prepared-value",
          kind: "data",
          from: { nodeId: "a-prepare", port: "value" },
          to: { nodeId: "c-write", port: "value" },
        },
        {
          id: "human-write",
          kind: "control",
          from: { nodeId: "b-human" },
          to: { nodeId: "c-write" },
        },
      ],
      entrypoints: [{ id: "main", nodeId: "a-prepare" }],
    };
    expect(
      checkGraphJsonV1Diagnostics(source, {
        resolver: host.nodes,
        capabilityAuthority: new CapabilityPermissionPolicy({ granted: ["fs:write"] }),
      }),
    ).toEqual({ valid: true, diagnostics: [] });
    const normalized = normalizeGraphJsonV1(source, host.nodes);
    if (!normalized.valid || normalized.normalized === undefined)
      throw new Error("Compiler rejected test graph.");
    return lowerCanonicalGraphJsonV1ToExecutionIr(
      canonicalizeGraphJsonV1Semantics(stripGraphJsonV1UiMetadata(normalized.normalized)),
      host.nodes,
    );
  } finally {
    await host.dispose();
  }
}

async function decideHttp(daemon: RuntimeDaemon, decision: "approved" | "rejected") {
  const base = `http://127.0.0.1:${String(daemon.snapshot().api.port)}`;
  const session = (await (await fetch(`${base}/api/session`)).json()) as { csrfToken: string };
  const list = (await (await fetch(`${base}/api/approvals?runId=run-1`)).json()) as {
    approvals: { approvalId: string }[];
  };
  const path = `${base}/api/approvals/${encodeURIComponent(list.approvals[0]!.approvalId)}`;
  const headers = { "content-type": "application/json", "x-zet-csrf": session.csrfToken };
  const tokenResponse = await fetch(`${path}/token`, { method: "POST", headers, body: "{}" });
  expect(tokenResponse.status).toBe(200);
  const credentials = (await tokenResponse.json()) as { resumeToken: string };
  const body = JSON.stringify({
    resumeToken: credentials.resumeToken,
    decision,
    payload: { checked: true },
  });
  const submit = () => fetch(`${path}/resume`, { method: "POST", headers, body });
  expect((await submit()).status).toBe(200);
  return submit;
}

afterEach(async () => {
  for (const dispatcher of dispatchers.splice(0)) await dispatcher.stop();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const database of databases.splice(0)) {
    await database.drainWrites();
    database.close();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("automatic durable scheduler dispatch", () => {
  it("survives an actual process kill while waiting and auto-wakes in a fresh process", async () => {
    const root = mkdtempSync(join(tmpdir(), "zet-dispatch-kill-"));
    roots.push(root);
    const path = join(root, "runtime.sqlite");
    const log = join(root, "calls.txt");
    seed(await compiledGraph(), path).close();
    const spawn = () =>
      fork(
        fileURLToPath(new URL("./runtime-dispatch-crash-child.mjs", import.meta.url)),
        [path, log],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
    const ready = async (
      child: ChildProcess,
    ): Promise<{ port: number; report: { status: string } }> => {
      const event = await Promise.race([
        once(child, "message"),
        once(child, "exit").then(() => {
          throw new Error("Child exited before readiness.");
        }),
      ]);
      return event[0] as { port: number; report: { status: string } };
    };
    let child = spawn();
    try {
      expect((await ready(child)).report.status).toBe("waiting");
      const killed = once(child, "exit");
      child.kill("SIGKILL");
      await killed;
      child = spawn();
      const restarted = await ready(child);
      expect(restarted.report.status).toBe("waiting");
      const base = `http://127.0.0.1:${String(restarted.port)}`;
      const session = (await (await fetch(`${base}/api/session`)).json()) as { csrfToken: string };
      const list = (await (await fetch(`${base}/api/approvals?runId=run-1`)).json()) as {
        approvals: { approvalId: string }[];
      };
      const url = `${base}/api/approvals/${encodeURIComponent(list.approvals[0]!.approvalId)}`;
      const headers = { "content-type": "application/json", "x-zet-csrf": session.csrfToken };
      const token = (await (
        await fetch(`${url}/token`, { method: "POST", headers, body: "{}" })
      ).json()) as { resumeToken: string };
      const body = JSON.stringify({ resumeToken: token.resumeToken, decision: "approved" });
      for (let repeat = 0; repeat < 3; repeat += 1) {
        expect((await fetch(`${url}/resume`, { method: "POST", headers, body })).status).toBe(200);
      }
      const settled = once(child, "message");
      child.send("settle");
      expect((await settled)[0]).toMatchObject({
        type: "settled",
        report: { status: "completed" },
      });
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["test.prepare", "test.write"]);
      const exited = once(child, "exit");
      child.send("stop");
      await exited;
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  }, 15_000);

  it("compiles → executes → waits → restarts → resumes via HTTP → executes the privileged effect once", async () => {
    const ir = await compiledGraph();
    const root = mkdtempSync(join(tmpdir(), "zet-dispatch-"));
    roots.push(root);
    const path = join(root, "runtime.sqlite");
    const database = seed(ir, path);
    database.close();
    const calls: string[] = [];
    const execute: RuntimeExecutionOptions["execute"] = (context) => {
      calls.push(context.operation.type);
      expect(Object.isFrozen(context.operation)).toBe(true);
      if (context.operation.type === "test.prepare")
        return { outputs: { value: "committed-before-wait" } };
      expect(context.inputs).toEqual([{ port: "value", value: "committed-before-wait" }]);
      return { outputs: { value: "written" } };
    };
    const options = {
      api: { port: 0 },
      database: { path },
      permissionAuthority: new CapabilityPermissionPolicy({ granted: ["fs:write"] }),
      execution: { execute },
    };
    const first = new RuntimeDaemon(options);
    daemons.push(first);
    await first.start();
    expect(await first.waitForRunIdle("run-1")).toMatchObject({ status: "waiting" });
    expect(calls).toEqual(["test.prepare"]);
    await first.stop();
    const second = new RuntimeDaemon(options);
    daemons.push(second);
    await second.start();
    expect(await second.waitForRunIdle("run-1")).toMatchObject({ status: "waiting" });
    const repeat = await decideHttp(second, "approved");
    expect(await second.waitForRunIdle("run-1")).toMatchObject({ status: "completed" });
    await Promise.all([repeat(), repeat(), repeat()]);
    expect(await second.waitForRunIdle("run-1")).toMatchObject({ status: "completed" });
    expect(calls).toEqual(["test.prepare", "test.write"]);
    await second.stop();
    database.open();
    const frontier = reconstructExecutionFrontier(database.connection(), "run-1");
    expect(frontier.ops.map((op) => op.status)).toEqual(["completed", "completed", "completed"]);
    expect(database.connection().prepare("SELECT COUNT(*) AS n FROM node_attempts").get()?.n).toBe(
      3,
    );
  });

  it("never turns human approval into a grant for the downstream effect", async () => {
    const database = seed(await compiledGraph());
    const execute = vi.fn(() => ({ outputs: { value: "prepared" } }));
    const { dispatcher, approvals } = attach(database, { execute });
    expect(await dispatcher.waitForIdle("run-1")).toMatchObject({ status: "waiting" });
    const id = approvals.listPending()[0]!.approvalId;
    const token = await approvals.issueResumeToken(id);
    await approvals.resume({ ...token, decision: "approved" });
    expect(await dispatcher.waitForIdle("run-1")).toMatchObject({
      status: "failed",
      code: "PERMISSION_DENIED",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(
      database
        .connection()
        .prepare("SELECT COUNT(*) AS n FROM node_attempts WHERE op_index = 2")
        .get()?.n,
    ).toBe(0);
  });

  it("coalesces concurrent wake-ups and retains exact retry/effect identity", async () => {
    const ir = createMockExecutionIr([
      createMockExecutionOp("retry", [], { behavior: { retry: { maxAttempts: 3 } } }),
    ]);
    const database = seed(ir);
    const ids: string[] = [];
    const { dispatcher } = attach(database, {
      execute(context) {
        ids.push(context.logicalEffectId);
        if (context.attempt < 3) throw new Error("transient");
        return { outputs: { value: 1 } };
      },
    });
    await Promise.all(Array.from({ length: 12 }, () => dispatcher.dispatch("run-1")));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(reconstructExecutionFrontier(database.connection(), "run-1").ops[0]).toMatchObject({
      attemptsStarted: 3,
      attemptBudgetUsed: 3,
      status: "completed",
    });
  });

  it("does not restore an unclassified pre-crash running external write", async () => {
    const ir = createMockExecutionIr([
      createMockExecutionOp("uncertain", [], {
        behavior: { effect: "external-write", idempotency: "unknown", recovery: "manual" },
      }),
    ]);
    const database = seed(ir);
    const c = database.connection();
    c.prepare("UPDATE runs SET status = 'running', started_at_ms = 1").run();
    c.prepare("INSERT INTO node_invocations VALUES ('run-1', 0, 0, 'persisted-effect', 1)").run();
    c.prepare(
      "INSERT INTO node_attempts (run_id, op_index, iteration, attempt, logical_effect_id, status, input_refs_json, started_at_ms) VALUES ('run-1', 0, 0, 1, 'persisted-effect', 'running', '{}', 1)",
    ).run();
    const execute = vi.fn(() => ({ outputs: {} }));
    const { dispatcher } = attach(database, { execute });
    expect(await dispatcher.waitForIdle("run-1")).toMatchObject({
      status: "recovery-required",
      code: "RUNTIME_RECOVERY_REQUIRED",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps successful work uncommitted and downstream blocked if the completion transaction fails", async () => {
    const ir = createMockExecutionIr([
      createMockExecutionOp("first", []),
      createMockExecutionOp("second", [0]),
    ]);
    const database = seed(ir);
    database.connection().exec(`CREATE TRIGGER fail_completion BEFORE INSERT ON durable_events
      WHEN NEW.event_type = 'harness.attempt.completed' BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    const execute = vi.fn(() => ({ outputs: { value: 1 } }));
    const { dispatcher } = attach(database, { execute });
    expect(await dispatcher.waitForIdle("run-1")).toMatchObject({
      status: "recovery-required",
      code: "RUNTIME_DURABILITY_FAILED",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(
      reconstructExecutionFrontier(database.connection(), "run-1").ops.map((op) => op.status),
    ).toEqual(["running", "pending"]);
    expect(await dispatcher.dispatch("run-1")).toMatchObject({ code: "RUNTIME_RECOVERY_REQUIRED" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("pauses for shutdown without cancelling committed work or starting a dependent", async () => {
    const ir = createMockExecutionIr([
      createMockExecutionOp("first", []),
      createMockExecutionOp("second", [0]),
    ]);
    const database = seed(ir);
    const started = deferred();
    const finish = deferred();
    const execute = vi.fn(async () => {
      started.resolve();
      await finish.promise;
      return { outputs: { value: 1 } };
    });
    const { dispatcher } = attach(database, { execute });
    await started.promise;
    const stopping = dispatcher.stop();
    finish.resolve();
    await stopping;
    expect(execute).toHaveBeenCalledOnce();
    expect(
      reconstructExecutionFrontier(database.connection(), "run-1").ops.map((op) => op.status),
    ).toEqual(["completed", "ready"]);
    const resumedExecute = vi.fn(() => ({ outputs: {} }));
    const second = attach(database, { execute: resumedExecute });
    expect(await second.dispatcher.waitForIdle("run-1")).toMatchObject({ status: "completed" });
    expect(resumedExecute).toHaveBeenCalledOnce();
    expect(resumedExecute.mock.calls).toHaveLength(1);
  });

  it("persists combined internal plus outer retry accounting", async () => {
    const database = seed(
      createMockExecutionIr([
        createMockExecutionOp("budget", [], { behavior: { retry: { maxAttempts: 3 } } }),
      ]),
    );
    const execute = vi.fn((context: Parameters<RuntimeExecutionOptions["execute"]>[0]) => {
      context.retryBudget.reportInternalRetries(2);
      throw new Error("all attempts spent");
    });
    const { dispatcher } = attach(database, { execute });
    expect(await dispatcher.waitForIdle("run-1")).toMatchObject({ status: "failed" });
    expect(execute).toHaveBeenCalledOnce();
    expect(reconstructExecutionFrontier(database.connection(), "run-1").ops[0]).toMatchObject({
      attemptsStarted: 1,
      attemptBudgetUsed: 3,
      status: "failed",
    });
  });
});

describe("dispatcher security and retry boundaries", () => {
  it("honors revocation between retries without spending another durable attempt", async () => {
    const database = seed(
      createMockExecutionIr([
        createMockExecutionOp("restricted", [], {
          behavior: { requiredCapabilities: ["fs:read"], retry: { maxAttempts: 3 } },
        }),
      ]),
    );
    let granted = true;
    const execute = vi.fn(() => {
      granted = false;
      throw new Error("transient");
    });
    const { dispatcher } = attach(
      database,
      { execute },
      {
        evaluate: () => ({ decision: granted ? "allow" : "deny" }),
      },
    );
    expect(await dispatcher.waitForIdle("run-1")).toMatchObject({
      status: "failed",
      code: "PERMISSION_DENIED",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(reconstructExecutionFrontier(database.connection(), "run-1").ops[0]).toMatchObject({
      attemptsStarted: 1,
      attemptBudgetUsed: 1,
      status: "failed",
    });
  });

  it("does not dispatch rejected or duplicate-rejected approvals", async () => {
    const database = seed(await compiledGraph());
    const execute = vi.fn(() => ({ outputs: { value: "prepared" } }));
    const { dispatcher, approvals } = attach(
      database,
      { execute },
      new CapabilityPermissionPolicy({ granted: ["fs:write"] }),
    );
    await dispatcher.waitForIdle("run-1");
    const token = await approvals.issueResumeToken(approvals.listPending()[0]!.approvalId);
    await approvals.resume({ ...token, decision: "rejected" });
    await approvals.resume({ ...token, decision: "rejected" });
    expect(await dispatcher.waitForIdle("run-1")).toMatchObject({ status: "cancelled" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects secret-bearing outputs without logging provider failure material", async () => {
    const database = seed(createMockExecutionIr([createMockExecutionOp("secret", [])]));
    const { dispatcher, redaction } = attach(database, {
      execute: () => ({ outputs: { value: "do-not-persist-this" } }),
    });
    redaction.registerSecret("do-not-persist-this");
    expect(await dispatcher.waitForIdle("run-1")).toMatchObject({ status: "failed" });
    const rows = database
      .connection()
      .prepare("SELECT output_refs_json, error_json FROM node_attempts")
      .all();
    expect(JSON.stringify(rows)).not.toContain("do-not-persist-this");
    expect(rows[0]?.output_refs_json).toBeNull();
  });

  it("drains parallel attempt failures rather than leaving phantom running attempts", async () => {
    const database = seed(
      createMockExecutionIr([createMockExecutionOp("a", []), createMockExecutionOp("b", [])], 2),
    );
    const bothStarted = deferred();
    let started = 0;
    const { dispatcher } = attach(database, {
      execute: async () => {
        if (++started === 2) bothStarted.resolve();
        await bothStarted.promise;
        throw new Error("parallel failure");
      },
    });
    expect(await dispatcher.waitForIdle("run-1")).toMatchObject({ status: "failed" });
    expect(
      reconstructExecutionFrontier(database.connection(), "run-1").preCrashRunningAttempts,
    ).toHaveLength(0);
    expect(
      database
        .connection()
        .prepare("SELECT COUNT(*) AS n FROM node_attempts WHERE status = 'failed'")
        .get()?.n,
    ).toBe(2);
  });
});
