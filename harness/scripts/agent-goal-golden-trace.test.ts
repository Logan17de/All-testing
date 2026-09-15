import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AGENT_MODEL_NODE_TYPE,
  AGENT_TOOLS_NODE_TYPE,
  CapabilityPermissionPolicy,
  LOOP_NODE_TYPE,
  PluginHost,
  createAgentPlugin,
  createControlFlowPlugin,
} from "@zet-harness/core";
import { SQLITE_MEMORY_PATH, SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { listRunAgentSteps } from "@zet-harness/db/durable-agent-step-records";
import {
  appendMessage,
  createConversation,
  readConversationMessages,
  type DurableMessagePart,
} from "@zet-harness/db/durable-conversation-records";
import { createGoal, createTodo, listTodos, readGoal } from "@zet-harness/db/durable-goal-records";
import { createProject } from "@zet-harness/db/durable-project-records";
import { SortableIdGenerator } from "@zet-harness/db/sortable-id";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";
import { createScriptedModelAdapter } from "@zet-harness/models";
import type {
  HarnessPlugin,
  JsonObject,
  ModelAdapter,
  ModelResult,
  NodeDefinition,
} from "@zet-harness/plugin-api";

import { createAgentNodeExecutor } from "../apps/runtime/src/runtime-agent-nodes.js";
import { RUNTIME_DATABASE_MIGRATIONS } from "../apps/runtime/src/runtime-daemon.js";
import {
  compileEditorGraph,
  createRunFromCompiledGraph,
} from "../apps/runtime/src/runtime-graphs.js";
import { RuntimeHumanApprovals } from "../apps/runtime/src/runtime-human-approvals.js";
import { createPluginNodeExecutor } from "../apps/runtime/src/runtime-plugin-executor.js";
import { reconstructExecutionFrontier } from "../apps/runtime/src/runtime-recovery.js";
import { RuntimeRedactionRegistry } from "../apps/runtime/src/runtime-redaction.js";
import { RuntimeRunDispatcher } from "../apps/runtime/src/runtime-run-dispatcher.js";

/**
 * 8.16: the golden trace of one complete, deterministic goal run.
 *
 * A trace keeps what must never drift and drops what legitimately varies (ids,
 * timestamps, hashes, payload values): every durable event by type, node, iteration
 * and attempt; every recorded agent step; every message's role and part kinds; and
 * the final todo and goal states. Two runs in fresh databases must produce the same
 * trace, and it must match the committed golden file. Record a new golden only on
 * purpose, with ZET_UPDATE_GOLDEN=1.
 */

const GOLDEN_PATH = fileURLToPath(new URL("./golden/agent-goal-run.trace.json", import.meta.url));

type EventTrace = readonly [
  type: string,
  node: string | null,
  iteration: number | null,
  attempt: number | null,
];

interface GoldenTrace {
  readonly report: string;
  readonly events: readonly EventTrace[];
  readonly steps: readonly (readonly [node: string, iteration: number, kind: string])[];
  readonly messages: readonly (readonly [role: string, parts: readonly string[]])[];
  readonly todos: readonly (readonly [title: string, status: string])[];
  readonly goal: readonly [status: string, blockedBy: string | null];
}

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
  manifest: { id: "test.golden", name: "Golden trace nodes", version: "1.0.0", apiVersion: 1 },
  activate(context) {
    context.nodes.register(step);
  },
};

const callTool = (callId: string, name: string, args: JsonObject): ModelResult => ({
  message: { role: "assistant", parts: [{ kind: "tool-call", callId, name, arguments: args }] },
  finishReason: "tool-calls",
  usage: { inputTokens: 80, outputTokens: 12 },
});

function agentGraph(conversationId: string): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "golden-goal-run",
    revisionId: "rev-1",
    inputs: [],
    outputs: [{ id: "result", schema: true, source: { nodeId: "finish", port: "done" } }],
    nodes: [
      { id: "start", type: "test.step", version: "1", config: {} },
      { id: "loop", type: LOOP_NODE_TYPE, version: "1", config: { maxIterations: 5 } },
      {
        id: "think",
        type: AGENT_MODEL_NODE_TYPE,
        version: "1",
        config: {
          conversationId,
          systemPrompt: "Finish the next todo.",
          reserveOutputTokens: 1_000,
        },
      },
      { id: "act", type: AGENT_TOOLS_NODE_TYPE, version: "1", config: { conversationId } },
      { id: "finish", type: "test.step", version: "1", config: {} },
    ],
    edges: [
      {
        id: "enter",
        kind: "control",
        from: { nodeId: "start" },
        to: { nodeId: "loop", port: "in" },
      },
      {
        id: "body",
        kind: "control",
        from: { nodeId: "loop", port: "body" },
        to: { nodeId: "think" },
      },
      { id: "then-act", kind: "control", from: { nodeId: "think" }, to: { nodeId: "act" } },
      {
        id: "repeat",
        kind: "control",
        from: { nodeId: "act" },
        to: { nodeId: "loop", port: "repeat" },
      },
      {
        id: "again",
        kind: "data",
        from: { nodeId: "think", port: "again" },
        to: { nodeId: "loop", port: "again" },
      },
      {
        id: "done",
        kind: "control",
        from: { nodeId: "loop", port: "done" },
        to: { nodeId: "finish" },
      },
    ],
    entrypoints: [{ id: "main", nodeId: "start" }],
    policies: {
      maxNodeExecutions: 30,
      maxParallelism: 1,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
  };
}

function partTrace(part: DurableMessagePart): string {
  switch (part.kind) {
    case "tool-call":
      return `tool-call:${part.name}`;
    case "tool-result": {
      const value = part.value as { readonly ok?: unknown } | null;
      return `tool-result:${value !== null && value.ok === true ? "ok" : "refused"}`;
    }
    default:
      return part.kind;
  }
}

/** Run one complete goal in a fresh database and reduce it to its trace. */
async function runGoal(): Promise<GoldenTrace> {
  const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  database.open();
  const host = new PluginHost();
  let dispatcher: RuntimeRunDispatcher | undefined;
  try {
    runSqliteMigrations(database.connection(), RUNTIME_DATABASE_MIGRATIONS);
    const connection = database.connection();
    const ids = new SortableIdGenerator({ now: () => 1_000 });
    const { projectId } = createProject(connection, {
      projectId: ids.next(),
      name: "Golden",
      nowMs: 1,
    });
    const { conversationId } = createConversation(connection, {
      conversationId: ids.next(),
      projectId,
      nowMs: 1,
    });
    const { goalId } = createGoal(connection, {
      goalId: ids.next(),
      projectId,
      title: "Ship it",
      nowMs: 1,
    });
    const { todoId } = createTodo(connection, {
      todoId: ids.next(),
      goalId,
      title: "Do the work",
      nowMs: 1,
    });
    appendMessage(connection, {
      messageId: ids.next(),
      conversationId,
      role: "user",
      parts: [{ kind: "text", text: "Please finish the goal." }],
      nowMs: 1,
    });

    const scripted = createScriptedModelAdapter([
      callTool("call-start", "harness_todos_set-status", { todoId, status: "in_progress" }),
      callTool("call-done", "harness_todos_set-status", { todoId, status: "done" }),
      {
        message: { role: "assistant", parts: [{ kind: "text", text: "The goal is done." }] },
        finishReason: "stop",
        usage: { inputTokens: 90, outputTokens: 6 },
      },
    ]);
    const model: ModelAdapter = {
      manifest: {
        ...scripted.manifest,
        // generate only: the wrapper does not forward streaming.
        features: { ...scripted.manifest.features, streaming: false, contextWindowTokens: 16_000 },
      },
      generate: (request, context) => scripted.generate(request, context),
    };

    await host.activate(testPlugin);
    await host.activate(createControlFlowPlugin());
    await host.activate(createAgentPlugin());
    host.models.register(model);

    const authority = new CapabilityPermissionPolicy();
    const redaction = new RuntimeRedactionRegistry();
    const approvals = new RuntimeHumanApprovals(database, {
      redaction,
      authority,
      onResolved: () => undefined,
    });
    dispatcher = new RuntimeRunDispatcher(
      database,
      approvals,
      {
        execute: createAgentNodeExecutor({
          database,
          models: host.models,
          createId: () => ids.next(),
          fallback: createPluginNodeExecutor({ host }),
        }),
      },
      redaction,
      authority,
    );
    dispatcher.start();

    const compiled = await compileEditorGraph(agentGraph(conversationId), { host }, authority);
    if (!compiled.valid) {
      throw new Error(`The golden graph did not compile: ${JSON.stringify(compiled.diagnostics)}`);
    }
    const { runId } = await createRunFromCompiledGraph(database, compiled.compiled);
    const report = await dispatcher.dispatch(runId);

    const ir = reconstructExecutionFrontier(connection, runId).executionIr as unknown as {
      readonly ops: readonly { readonly sourceNodeId: string }[];
    };
    const nodeOf = (opIndex: number | null): string | null =>
      opIndex === null ? null : (ir.ops[opIndex]?.sourceNodeId ?? `op-${String(opIndex)}`);
    const rows = connection
      .prepare(
        `SELECT event_type AS type, op_index AS opIndex, iteration, attempt
         FROM durable_events WHERE run_id = ? ORDER BY event_id`,
      )
      .all(runId) as unknown as readonly {
      readonly type: string;
      readonly opIndex: number | null;
      readonly iteration: number | null;
      readonly attempt: number | null;
    }[];
    const goal = readGoal(connection, goalId);

    return {
      report: report.status,
      events: rows.map((row): EventTrace => [
        row.type,
        nodeOf(row.opIndex),
        row.iteration,
        row.attempt,
      ]),
      steps: listRunAgentSteps(connection, runId).map(
        (recorded) => [nodeOf(recorded.opIndex) ?? "", recorded.iteration, recorded.kind] as const,
      ),
      messages: readConversationMessages(connection, conversationId).map(
        (message) => [message.role, message.parts.map(partTrace)] as const,
      ),
      todos: listTodos(connection, goalId).map((todo) => [todo.title, todo.status] as const),
      goal: [goal?.status ?? "missing", goal?.blockedBy ?? null],
    };
  } finally {
    await dispatcher?.stop();
    await host.dispose();
    database.close();
  }
}

describe("golden trace of a complete goal run", () => {
  it("repeats exactly and matches the recorded golden trace", async () => {
    const first = await runGoal();
    const second = await runGoal();
    expect(second).toEqual(first);

    expect(first.report).toBe("completed");
    expect(first.goal).toEqual(["completed", null]);
    expect(first.todos).toEqual([["Do the work", "done"]]);

    if (process.env["ZET_UPDATE_GOLDEN"] === "1") {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(first, null, 2)}\n`, "utf8");
    }
    expect(existsSync(GOLDEN_PATH), "Record the golden trace with ZET_UPDATE_GOLDEN=1.").toBe(true);
    expect(first).toEqual(JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as unknown);
  });
});
