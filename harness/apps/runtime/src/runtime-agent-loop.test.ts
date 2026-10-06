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
import {
  createGoal,
  createTodo,
  listGoals,
  reconcileGoalProgress,
  setTodoStatus,
} from "@zet-harness/db/durable-goal-records";
import { createProject } from "@zet-harness/db/durable-project-records";
import { SortableIdGenerator } from "@zet-harness/db/sortable-id";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";
import type {
  HarnessPlugin,
  JsonObject,
  ModelAdapter,
  ModelRequest,
  ModelResult,
  ToolAdapter,
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
      providerStateIdentity: {
        provider: "openai-responses",
        model: "gpt-test",
        scope: "a".repeat(64),
      },
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

async function setup(
  responses: readonly ModelResult[],
  streaming = false,
  externalTools: readonly ToolAdapter[] = [],
  executorOptions: Pick<
    Parameters<typeof createAgentNodeExecutor>[0],
    "providerStatePolicy" | "modelUserParts"
  > = {},
) {
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
  const progress: { textCharacters: number; completed: boolean }[] = [];
  host.models.register(
    streaming
      ? {
          ...model.adapter,
          manifest: {
            ...model.adapter.manifest,
            features: { ...model.adapter.manifest.features, streaming: true },
          },
          generate: () => {
            throw new Error("Streaming must not call buffered generation");
          },
          stream: async function* (request, context) {
            context.signal.throwIfAborted();
            const result = await model.adapter.generate(request, context);
            yield { type: "text-delta", text: "fixture-" };
            yield { type: "text-delta", text: "private-secret" };
            yield { type: "completed", result };
          },
        }
      : model.adapter,
  );

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
    tools: externalTools,
    ...executorOptions,
    onStreamProgress: (update) => {
      progress.push({ textCharacters: update.textCharacters, completed: update.completed });
    },
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

  const run = async (
    maxIterations: number,
    scope: { model?: readonly string[]; tools?: readonly string[] } = {},
  ) => {
    const graph = agentGraph(conversationId, maxIterations);
    const scopedGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => ({
        ...node,
        config: {
          ...node.config,
          ...(node.id === "think" && scope.model !== undefined
            ? { toolAllowlist: [...scope.model] }
            : {}),
          ...(node.id === "act" && scope.tools !== undefined
            ? { toolAllowlist: [...scope.tools] }
            : {}),
        },
      })),
    };
    const compiled = await compileEditorGraph(scopedGraph, { host }, authority);
    if (!compiled.valid) {
      throw new Error(`The agent graph did not compile: ${JSON.stringify(compiled.diagnostics)}`);
    }
    const { runId } = await createRunFromCompiledGraph(database, compiled.compiled);
    return { runId, report: await dispatcher.dispatch(runId) };
  };

  return { database, host, model, projectId, conversationId, executor, run, progress };
}

describe("the bounded agent loop", () => {
  it("passes only the actual model/tools-node intersection as trusted child scope", async () => {
    const scopes: (readonly string[] | undefined)[] = [];
    const tool: ToolAdapter = {
      manifest: {
        id: "plugin.read",
        version: "1",
        title: "Scoped read",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        behavior: {
          primitiveFamily: "effect",
          determinism: "nondeterministic",
          effect: "external-read",
          idempotency: "idempotent",
          recovery: "rerun",
          executionMode: "in-process",
          requiredCapabilities: [],
        },
      },
      invoke: (_input, context) => {
        scopes.push(context.toolScope);
        return Promise.resolve({ value: {} });
      },
    };
    const { run, model } = await setup(
      [callTool("scoped-read", "plugin_read", {}), reply("Done")],
      false,
      [tool],
    );
    expect((await run(4, { model: ["plugin.read"], tools: ["plugin.read"] })).report.status).toBe(
      "completed",
    );
    expect(model.requests[0]?.tools?.map((entry) => entry.name)).toEqual(["plugin_read"]);
    expect(scopes).toEqual([["plugin.read"]]);
  });

  it("a model-node empty allowlist cannot be bypassed by a hallucinated call or broad tools node", async () => {
    const { database, projectId, model, run } = await setup([
      callTool("scope-call", "harness_goals_create", { title: "Must not be created" }),
      reply("Done"),
    ]);
    expect((await run(4, { model: [] })).report.status).toBe("completed");
    expect(model.requests[0]?.tools).toBeUndefined();
    expect(listGoals(database.connection(), projectId)).toHaveLength(0);
  });
  it("a narrower tools-node allowlist denies a call that the model was offered", async () => {
    const { database, projectId, model, run } = await setup([
      callTool("scope-call", "harness_goals_create", { title: "Must not be created" }),
      reply("Done"),
    ]);
    expect((await run(4, { tools: [] })).report.status).toBe("completed");
    expect(model.requests[0]?.tools?.some((tool) => tool.name === "harness_goals_create")).toBe(
      true,
    );
    expect(listGoals(database.connection(), projectId)).toHaveLength(0);
  });

  it("consumes streamed tool turns, stores one final message per step and publishes only counts", async () => {
    const { database, conversationId, model, progress, run } = await setup(
      [
        callTool("stream-call", "harness_goals_create", { title: "Streamed goal" }),
        reply("The goal is saved."),
      ],
      true,
    );
    expect((await run(4)).report.status).toBe("completed");
    expect(model.requests).toHaveLength(2);
    expect(
      readConversationMessages(database.connection(), conversationId).map(
        (message) => message.role,
      ),
    ).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(progress.filter((update) => update.completed)).toHaveLength(2);
    expect(progress.at(-1)).toMatchObject({ textCharacters: 22, completed: true });
    expect(JSON.stringify(progress)).not.toContain("private-secret");
  });

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

    expect(retried.outputs).toEqual({ again: false, blocked: false, finishReason: "stop" });
    expect(model.requests).toHaveLength(1);
    expect(readConversationMessages(database.connection(), conversationId)).toHaveLength(2);
    expect(() =>
      database.connection().prepare(`UPDATE ${AGENT_STEPS_TABLE} SET kind = 'tools'`).run(),
    ).toThrow(/append-only/u);
  });

  it("tells the graph when every unfinished goal of the project is blocked", async () => {
    const { database, projectId, run } = await setup([reply("Everything is waiting on someone.")]);
    const connection = database.connection();
    const ids = new SortableIdGenerator({ now: () => 2_000 });
    const goal = createGoal(connection, { goalId: ids.next(), projectId, title: "Ship", nowMs: 5 });
    const todo = createTodo(connection, {
      todoId: ids.next(),
      goalId: goal.goalId,
      title: "Get sign-off",
      nowMs: 5,
    });
    setTodoStatus(connection, todo.todoId, { status: "blocked", reason: "Legal review", nowMs: 6 });
    expect(reconcileGoalProgress(connection, goal.goalId, 7)).toMatchObject({
      change: "blocked",
      goal: { status: "blocked", blockedBy: "todos" },
    });

    const { runId, report } = await run(2);

    expect(report.status).toBe("completed");
    const row = connection
      .prepare(`SELECT outputs_json FROM ${AGENT_STEPS_TABLE} WHERE run_id = ? AND kind = 'model'`)
      .get(runId) as { readonly outputs_json: string } | undefined;
    expect(JSON.parse(row?.outputs_json ?? "null")).toEqual({
      again: false,
      blocked: true,
      finishReason: "stop",
    });
  });
});

it("persists ordered opaque reasoning with tool calls and replays it into the next model step", async () => {
  const state = {
    kind: "provider-state" as const,
    provider: "openai-responses" as const,
    model: "gpt-test",
    scope: "a".repeat(64),
    id: "rs_loop",
    encryptedContent: "opaque-loop-fixture",
  };
  const call = callTool("state-call", "harness_goals_list", {});
  const first: ModelResult = {
    ...call,
    message: { role: "assistant", parts: [state, ...call.message.parts] },
  };
  const { run, model, database, conversationId } = await setup([first, reply("Done")]);
  expect((await run(3)).report.status).toBe("completed");
  const replay = model.requests[1]!.messages.filter((message) =>
    message.parts.some(
      (part) =>
        part.kind === "provider-state" || part.kind === "tool-call" || part.kind === "tool-result",
    ),
  );
  expect(replay.map((message) => message.parts.map((part) => part.kind))).toEqual([
    ["provider-state", "tool-call"],
    ["tool-result"],
  ]);
  expect(
    readConversationMessages(database.connection(), conversationId).some((message) =>
      message.parts.some((part) => part.kind === "provider-state"),
    ),
  ).toBe(true);
});

it("defaults to account-bound state refusal and records explicit host reset without losing visible history", async () => {
  const state = {
    kind: "provider-state" as const,
    provider: "openai-responses" as const,
    model: "gpt-test",
    scope: "b".repeat(64),
    id: "rs_foreign",
    encryptedContent: "opaque-foreign-fixture",
  };
  const denied = await setup([reply("should not run")]);
  const ids = new SortableIdGenerator({ now: () => 6000 });
  appendMessage(denied.database.connection(), {
    messageId: ids.next(),
    conversationId: denied.conversationId,
    role: "assistant",
    parts: [state, { kind: "text", text: "Visible prior answer" }],
    nowMs: 10,
  });
  expect((await denied.run(2)).report.status).toBe("failed");
  expect(denied.model.requests).toHaveLength(0);
  const allowed = await setup([reply("Continued")], false, [], {
    providerStatePolicy: () => "omit-incompatible",
  });
  appendMessage(allowed.database.connection(), {
    messageId: ids.next(),
    conversationId: allowed.conversationId,
    role: "assistant",
    parts: [state, { kind: "text", text: "Visible prior answer" }],
    nowMs: 10,
  });
  const completed = await allowed.run(2);
  expect(completed.report.status).toBe("completed");
  const request = allowed.model.requests[0]!;
  expect(
    request.messages
      .flatMap((message) => message.parts)
      .some((part) => part.kind === "provider-state"),
  ).toBe(false);
  expect(JSON.stringify(request)).toContain("Visible prior answer");
  expect(JSON.stringify(request)).toContain("explicitly authorized model/account switch");
  const usage = allowed.database
    .connection()
    .prepare(`SELECT usage_json FROM ${AGENT_STEPS_TABLE} WHERE run_id=? AND kind='model'`)
    .get(completed.runId) as { usage_json: string };
  expect(JSON.parse(usage.usage_json)).toMatchObject({
    providerState: { droppedProviderStateCount: 1 },
  });
});
it("adds host image refs only to the main model request with actual offered canonical scope, never durability", async () => {
  let offered: readonly string[] | undefined;
  const f = await setup([reply("Inspected")], false, [], {
    modelUserParts: (context) => {
      offered = context.toolScope;
      return [{ kind: "image", artifactRef: "artifact:ephemeral-fixture", mediaType: "image/png" }];
    },
  });
  expect((await f.run(2, { model: ["harness.goals.list"] })).report.status).toBe("completed");
  expect(offered).toEqual(["harness.goals.list"]);
  expect(f.model.requests[0]!.messages.at(-1)?.parts).toEqual([
    { kind: "image", artifactRef: "artifact:ephemeral-fixture", mediaType: "image/png" },
  ]);
  expect(
    JSON.stringify(readConversationMessages(f.database.connection(), f.conversationId)),
  ).not.toContain("ephemeral-fixture");
});
