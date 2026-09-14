import { afterEach, describe, expect, it } from "vitest";

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
import { AGENT_STEPS_TABLE } from "@zet-harness/db/durable-agent-step-records";
import {
  appendMessage,
  createConversation,
  readConversationMessages,
} from "@zet-harness/db/durable-conversation-records";
import { listGoals } from "@zet-harness/db/durable-goal-records";
import { createProject } from "@zet-harness/db/durable-project-records";
import { SortableIdGenerator } from "@zet-harness/db/sortable-id";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";
import type {
  HarnessPlugin,
  JsonObject,
  ModelAdapter,
  ModelRequest,
  ModelResult,
  NodeDefinition,
} from "@zet-harness/plugin-api";

import { createAgentNodeExecutor } from "./runtime-agent-nodes.js";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { compileEditorGraph, createRunFromCompiledGraph } from "./runtime-graphs.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import { createPluginNodeExecutor } from "./runtime-plugin-executor.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";
import { RuntimeRunDispatcher, type RuntimeNodeExecution } from "./runtime-run-dispatcher.js";

const hosts: PluginHost[] = [];
const databases: SqliteDatabase[] = [];
const dispatchers: RuntimeRunDispatcher[] = [];

afterEach(async () => {
  for (const dispatcher of dispatchers.splice(0)) await dispatcher.stop();
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
  manifest: { id: "test.agent", name: "Agent test nodes", version: "1.0.0", apiVersion: 1 },
  activate(context) {
    context.nodes.register(step);
  },
};

interface ScriptedModel {
  readonly adapter: ModelAdapter;
  readonly requests: ModelRequest[];
}

/** A model that answers from a fixed script and remembers what it was asked. */
function scriptedModel(responses: readonly ModelResult[]): ScriptedModel {
  const requests: ModelRequest[] = [];
  let cursor = 0;
  const adapter: ModelAdapter = {
    manifest: {
      id: "test.model",
      version: "1",
      title: "Scripted model",
      requiredCapabilities: [],
      features: {
        streaming: false,
        tools: true,
        vision: false,
        structuredOutput: false,
        contextWindowTokens: 32_000,
      },
    },
    generate: (request) => {
      requests.push(structuredClone(request));
      const response = responses[cursor];
      cursor += 1;
      return response === undefined
        ? Promise.reject(new Error("The model script is exhausted."))
        : Promise.resolve(structuredClone(response));
    },
  };
  return { adapter, requests };
}

const callTool = (callId: string, name: string, args: JsonObject): ModelResult => ({
  message: { role: "assistant", parts: [{ kind: "tool-call", callId, name, arguments: args }] },
  finishReason: "tool-calls",
  usage: { inputTokens: 50, outputTokens: 10 },
});

const reply = (text: string): ModelResult => ({
  message: { role: "assistant", parts: [{ kind: "text", text }] },
  finishReason: "stop",
  usage: { inputTokens: 60, outputTokens: 5 },
});

/** start → loop ─body→ think → act ─repeat→ loop (think.again → loop.again) ─done→ finish */
function agentGraph(conversationId: string, maxIterations: number): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "agent-loop",
    revisionId: `rev-${String(maxIterations)}`,
    inputs: [],
    outputs: [{ id: "result", schema: true, source: { nodeId: "finish", port: "done" } }],
    nodes: [
      { id: "start", type: "test.step", version: "1", config: {} },
      { id: "loop", type: LOOP_NODE_TYPE, version: "1", config: { maxIterations } },
      {
        id: "think",
        type: AGENT_MODEL_NODE_TYPE,
        version: "1",
        config: {
          conversationId,
          systemPrompt: "You plan work as goals and todos.",
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
      maxNodeExecutions: 50,
      maxParallelism: 1,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
  };
}

async function setup(responses: readonly ModelResult[]) {
  const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  database.open();
  runSqliteMigrations(database.connection(), RUNTIME_DATABASE_MIGRATIONS);
  databases.push(database);

  const host = new PluginHost();
  hosts.push(host);
  await host.activate(testPlugin);
  await host.activate(createControlFlowPlugin());
  await host.activate(createAgentPlugin());
  const model = scriptedModel(responses);
  host.models.register(model.adapter);

  const ids = new SortableIdGenerator({ now: () => 1_000 });
  const { projectId } = createProject(database.connection(), {
    projectId: ids.next(),
    name: "Launch",
    nowMs: 1,
  });
  const { conversationId } = createConversation(database.connection(), {
    conversationId: ids.next(),
    projectId,
    nowMs: 1,
  });
  appendMessage(database.connection(), {
    messageId: ids.next(),
    conversationId,
    role: "user",
    parts: [{ kind: "text", text: "Plan the launch." }],
    nowMs: 1,
  });

  const redaction = new RuntimeRedactionRegistry();
  const authority = new CapabilityPermissionPolicy();
  const approvals = new RuntimeHumanApprovals(database, {
    redaction,
    authority,
    onResolved: () => undefined,
  });
  const executor = createAgentNodeExecutor({
    database,
    models: host.models,
    createId: () => ids.next(),
    fallback: createPluginNodeExecutor({ host }),
  });
  const dispatcher = new RuntimeRunDispatcher(
    database,
    approvals,
    { execute: executor },
    redaction,
    authority,
  );
  dispatchers.push(dispatcher);
  dispatcher.start();

  const run = async (maxIterations: number) => {
    const compiled = await compileEditorGraph(
      agentGraph(conversationId, maxIterations),
      { host },
      authority,
    );
    if (!compiled.valid) {
      throw new Error(`The agent graph did not compile: ${JSON.stringify(compiled.diagnostics)}`);
    }
    const { runId } = await createRunFromCompiledGraph(database, compiled.compiled);
    return { runId, report: await dispatcher.dispatch(runId) };
  };

  return { database, host, model, projectId, conversationId, executor, run };
}

describe("the bounded agent loop", () => {
  it("runs model→tool→model inside a structured loop and plans work through goal actions", async () => {
    const { database, model, projectId, conversationId, run } = await setup([
      callTool("call-1", "harness_goals_create", { title: "Launch the site", priority: 10 }),
      reply("I created the launch goal."),
    ]);

    const { runId, report } = await run(4);

    expect(report.status).toBe("completed");
    expect(model.requests).toHaveLength(2);
    expect(listGoals(database.connection(), projectId).map((goal) => goal.title)).toEqual([
      "Launch the site",
    ]);

    const messages = readConversationMessages(database.connection(), conversationId);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages.slice(1).every((message) => message.runId === runId)).toBe(true);
    expect(messages[1]).toMatchObject({
      model: "test.model@1",
      usage: { inputTokens: 50, outputTokens: 10 },
      parentMessageId: messages[0]?.messageId,
    });
    expect(messages[2]?.parts[0]).toMatchObject({
      kind: "tool-result",
      callId: "call-1",
      value: { ok: true, goal: { title: "Launch the site" } },
    });
    expect(messages[3]?.parentMessageId).toBe(messages[2]?.messageId);

    const second = model.requests[1];
    expect(second?.messages.at(-1)).toMatchObject({ role: "tool" });
    expect(JSON.stringify(second?.messages[1])).toContain("Launch the site");
    expect(second?.tools?.map((tool) => tool.name)).toContain("harness_goals_create");
  });

  it("stops at the loop's hard bound when the model keeps calling tools", async () => {
    const keepGoing = (index: number) =>
      callTool(`call-${String(index)}`, "harness_goals_list", {});
    const { database, model, conversationId, run } = await setup([
      keepGoing(1),
      keepGoing(2),
      keepGoing(3),
      keepGoing(4),
    ]);

    const { report } = await run(3);

    expect(report.status).toBe("completed");
    expect(model.requests).toHaveLength(3);
    expect(readConversationMessages(database.connection(), conversationId)).toHaveLength(1 + 3 * 2);
  });

  it("answers a retried step from its record instead of calling the model or appending again", async () => {
    const { database, model, conversationId, executor, run } = await setup([
      reply("Nothing to do."),
    ]);
    const { runId, report } = await run(2);
    expect(report.status).toBe("completed");

    const recorded = database
      .connection()
      .prepare(`SELECT * FROM ${AGENT_STEPS_TABLE} WHERE run_id = ? AND kind = 'model'`)
      .get(runId) as
      | {
          readonly logical_effect_id: string;
          readonly op_index: number;
          readonly iteration: number;
        }
      | undefined;
    if (recorded === undefined) throw new Error("The model step was not recorded.");

    const retried = await executor({
      op: recorded.op_index,
      iteration: recorded.iteration,
      attempt: 2,
      runId,
      logicalEffectId: recorded.logical_effect_id,
      inputs: [],
      operation: {
        type: AGENT_MODEL_NODE_TYPE,
        version: "1",
        config: { conversationId, systemPrompt: "You plan work as goals and todos." },
      },
      signal: new AbortController().signal,
      retryBudget: {
        maxAttempts: 2,
        repeatAuthorized: true,
        usedAttempts: 2,
        remainingAttempts: 0,
        reportInternalRetries: () => 2,
      },
    } as unknown as RuntimeNodeExecution);

    expect(retried.outputs).toEqual({ again: false, finishReason: "stop" });
    expect(model.requests).toHaveLength(1);
    expect(readConversationMessages(database.connection(), conversationId)).toHaveLength(2);
    expect(() =>
      database.connection().prepare(`UPDATE ${AGENT_STEPS_TABLE} SET kind = 'tools'`).run(),
    ).toThrow(/append-only/u);
  });
});
