import { afterEach, describe, expect, it } from "vitest";

import {
  CapabilityPermissionPolicy,
  PluginHost,
  createAgentPlugin,
  AGENT_MODEL_NODE_TYPE,
} from "@zet-harness/core";
import { SQLITE_MEMORY_PATH, SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { createConversation } from "@zet-harness/db/durable-conversation-records";
import {
  acquireProjectRunLock,
  readProjectRunLock,
} from "@zet-harness/db/durable-project-lock-records";
import { createProject } from "@zet-harness/db/durable-project-records";
import { SortableIdGenerator } from "@zet-harness/db/sortable-id";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";
import type { HarnessPlugin, NodeDefinition } from "@zet-harness/plugin-api";

import { AgentStepError, createAgentNodeExecutor } from "./runtime-agent-nodes.js";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { compileEditorGraph, createRunFromCompiledGraph } from "./runtime-graphs.js";
import type { RuntimeNodeExecution } from "./runtime-run-dispatcher.js";

const hosts: PluginHost[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const database of databases.splice(0)) database.close();
});

const step: NodeDefinition = {
  manifest: {
    type: "test.step",
    version: "1",
    title: "Step",
    inputs: {},
    outputs: { done: { schema: { type: "boolean" } } },
    configSchema: { type: "object", additionalProperties: false },
    behavior: {
      primitiveFamily: "pure",
      determinism: "deterministic",
      effect: "none",
      idempotency: "not-applicable",
      recovery: "rerun",
      executionMode: "in-process",
      requiredCapabilities: [],
    },
  },
  execute: () => ({ outputs: { done: true } }),
};

const testPlugin: HarnessPlugin = {
  manifest: { id: "test.lock", name: "Lock test nodes", version: "1.0.0", apiVersion: 1 },
  activate(context) {
    context.nodes.register(step);
  },
};

const GRAPH: GraphJsonV1 = {
  schemaVersion: GRAPH_JSON_VERSION,
  graphId: "lock-graph",
  revisionId: "rev-1",
  inputs: [],
  outputs: [{ id: "result", schema: true, source: { nodeId: "only", port: "done" } }],
  nodes: [{ id: "only", type: "test.step", version: "1", config: {} }],
  edges: [],
  entrypoints: [{ id: "main", nodeId: "only" }],
  policies: {
    maxNodeExecutions: 5,
    maxParallelism: 1,
    capabilities: { required: [], optional: [], deny: [] },
  },
  options: { defaultEntrypoint: "main" },
};

async function setup() {
  const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  database.open();
  runSqliteMigrations(database.connection(), RUNTIME_DATABASE_MIGRATIONS);
  databases.push(database);
  const host = new PluginHost();
  hosts.push(host);
  await host.activate(testPlugin);
  await host.activate(createAgentPlugin());

  const ids = new SortableIdGenerator({ now: () => 1_000 });
  const { projectId } = createProject(database.connection(), {
    projectId: ids.next(),
    name: "Locked",
    nowMs: 1,
  });
  const { conversationId } = createConversation(database.connection(), {
    conversationId: ids.next(),
    projectId,
    nowMs: 1,
  });
  const compiled = await compileEditorGraph(GRAPH, { host }, new CapabilityPermissionPolicy());
  if (!compiled.valid) throw new Error(JSON.stringify(compiled.diagnostics));
  const newRun = async () => (await createRunFromCompiledGraph(database, compiled.compiled)).runId;
  const finish = (runId: string, status: "completed" | "failed" | "cancelled") => {
    database
      .connection()
      .prepare(
        "UPDATE runs SET status = ?, started_at_ms = created_at_ms, finished_at_ms = created_at_ms WHERE run_id = ?",
      )
      .run(status, runId);
  };
  return { database, host, projectId, conversationId, newRun, finish };
}

describe("per-project run lock", () => {
  it("gives a project to one active run at a time and passes it on once that run finishes", async () => {
    const { database, projectId, newRun, finish } = await setup();
    const connection = database.connection();
    const [first, second, third] = [await newRun(), await newRun(), await newRun()];

    expect(acquireProjectRunLock(connection, { projectId, runId: first, nowMs: 10 })).toEqual({
      acquired: true,
      runId: first,
      replacedRunId: null,
    });
    expect(acquireProjectRunLock(connection, { projectId, runId: second, nowMs: 11 })).toEqual({
      acquired: false,
      holderRunId: first,
    });
    expect(acquireProjectRunLock(connection, { projectId, runId: first, nowMs: 12 })).toMatchObject(
      {
        acquired: true,
      },
    );

    finish(first, "completed");
    expect(acquireProjectRunLock(connection, { projectId, runId: second, nowMs: 13 })).toEqual({
      acquired: true,
      runId: second,
      replacedRunId: first,
    });
    expect(readProjectRunLock(connection, projectId)).toEqual({
      projectId,
      runId: second,
      acquiredAtMs: 13,
    });

    expect(acquireProjectRunLock(connection, { projectId, runId: third, nowMs: 14 })).toMatchObject(
      {
        acquired: false,
        holderRunId: second,
      },
    );
    finish(second, "cancelled");
    expect(acquireProjectRunLock(connection, { projectId, runId: third, nowMs: 15 })).toMatchObject(
      {
        acquired: true,
        replacedRunId: second,
      },
    );
  });

  it("refuses an agent step while another active run is working on the same project", async () => {
    const { database, host, projectId, conversationId, newRun } = await setup();
    const holder = await newRun();
    const intruder = await newRun();
    await database.commit((connection) =>
      acquireProjectRunLock(connection, { projectId, runId: holder, nowMs: 10 }),
    );

    const execute = createAgentNodeExecutor({
      database,
      models: host.models,
      fallback: () => Promise.reject(new Error("Not an agent node.")),
    });
    const step = execute({
      op: 0,
      iteration: 0,
      attempt: 1,
      runId: intruder,
      logicalEffectId: "zet-effect-v1:intruder",
      inputs: [],
      operation: {
        type: AGENT_MODEL_NODE_TYPE,
        version: "1",
        config: { conversationId, systemPrompt: "Work." },
      },
      signal: new AbortController().signal,
      retryBudget: {
        maxAttempts: 1,
        repeatAuthorized: false,
        usedAttempts: 1,
        remainingAttempts: 0,
        reportInternalRetries: () => 1,
      },
    } as unknown as RuntimeNodeExecution);

    await expect(step).rejects.toBeInstanceOf(AgentStepError);
    await expect(step).rejects.toMatchObject({ code: "AGENT_PROJECT_BUSY" });
    expect(readProjectRunLock(database.connection(), projectId)?.runId).toBe(holder);
  });
});
