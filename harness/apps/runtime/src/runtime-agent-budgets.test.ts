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
import {
  appendMessage,
  createConversation,
  readConversationMessages,
} from "@zet-harness/db/durable-conversation-records";
import { createProject } from "@zet-harness/db/durable-project-records";
import { SortableIdGenerator } from "@zet-harness/db/sortable-id";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";
import type {
  AdapterUsage,
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
import { RuntimeRunDispatcher } from "./runtime-run-dispatcher.js";

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
  manifest: { id: "test.budgets", name: "Budget test nodes", version: "1.0.0", apiVersion: 1 },
  activate(context) {
    context.nodes.register(step);
  },
};

/** A model that always asks for the given tool calls, reporting the given usage. */
function busyModel(
  calls: number,
  usage: AdapterUsage,
): { readonly adapter: ModelAdapter; readonly requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const result = (): ModelResult => ({
    message: {
      role: "assistant",
      parts: Array.from({ length: calls }, (_, index) => ({
        kind: "tool-call" as const,
        callId: `call-${String(requests.length)}-${String(index)}`,
        name: "harness_goals_list",
        arguments: {},
      })),
    },
    finishReason: "tool-calls",
    usage,
  });
  const adapter: ModelAdapter = {
    manifest: {
      id: "test.model",
      version: "1",
      title: "Busy model",
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
      return Promise.resolve(result());
    },
  };
  return { adapter, requests };
}

function budgetGraph(conversationId: string, think: JsonObject, act: JsonObject): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "budget-graph",
    revisionId: `rev-${JSON.stringify(think)}-${JSON.stringify(act)}`.replace(
      /[^A-Za-z0-9._-]/gu,
      "_",
    ),
    inputs: [],
    outputs: [{ id: "result", schema: true, source: { nodeId: "finish", port: "done" } }],
    nodes: [
      { id: "start", type: "test.step", version: "1", config: {} },
      { id: "loop", type: LOOP_NODE_TYPE, version: "1", config: { maxIterations: 6 } },
      {
        id: "think",
        type: AGENT_MODEL_NODE_TYPE,
        version: "1",
        config: {
          conversationId,
          systemPrompt: "Keep going.",
          reserveOutputTokens: 1_000,
          ...think,
        },
      },
      { id: "act", type: AGENT_TOOLS_NODE_TYPE, version: "1", config: { conversationId, ...act } },
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
      maxNodeExecutions: 40,
      maxParallelism: 1,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
  };
}

async function runWithBudgets(
  model: { readonly adapter: ModelAdapter },
  think: JsonObject,
  act: JsonObject = {},
) {
  const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  database.open();
  cleanups.push(() => {
    database.close();
  });
  runSqliteMigrations(database.connection(), RUNTIME_DATABASE_MIGRATIONS);

  const host = new PluginHost();
  cleanups.push(() => host.dispose());
  await host.activate(testPlugin);
  await host.activate(createControlFlowPlugin());
  await host.activate(createAgentPlugin());
  host.models.register(model.adapter);

  const ids = new SortableIdGenerator({ now: () => 1_000 });
  const { projectId } = createProject(database.connection(), {
    projectId: ids.next(),
    name: "Budget",
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
    parts: [{ kind: "text", text: "Work until you are stopped." }],
    nowMs: 1,
  });

  const authority = new CapabilityPermissionPolicy();
  const redaction = new RuntimeRedactionRegistry();
  const approvals = new RuntimeHumanApprovals(database, {
    redaction,
    authority,
    onResolved: () => undefined,
  });
  const dispatcher = new RuntimeRunDispatcher(
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
  cleanups.push(() => dispatcher.stop());
  dispatcher.start();

  const compiled = await compileEditorGraph(
    budgetGraph(conversationId, think, act),
    { host },
    authority,
  );
  if (!compiled.valid) {
    throw new Error(`The budget graph did not compile: ${JSON.stringify(compiled.diagnostics)}`);
  }
  const { runId } = await createRunFromCompiledGraph(database, compiled.compiled);
  const report = await dispatcher.dispatch(runId);
  return {
    report,
    messages: readConversationMessages(database.connection(), conversationId),
  };
}

describe("run-wide budgets for agent work (8.2)", () => {
  it("stops the run once it has made its limit of model calls", async () => {
    const model = busyModel(1, { inputTokens: 10, outputTokens: 1 });
    const { report } = await runWithBudgets(model, { maxModelCalls: 2 });

    expect(report.status).toBe("failed");
    expect(model.requests).toHaveLength(2);
  });

  it("refuses a tools step whose calls would pass the run's tool-call limit, before running any", async () => {
    const model = busyModel(2, { inputTokens: 10, outputTokens: 1 });
    const { report, messages } = await runWithBudgets(model, {}, { maxToolCalls: 3 });

    expect(report.status).toBe("failed");
    expect(model.requests).toHaveLength(2);
    const toolMessages = messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.parts).toHaveLength(2);
  });

  it("stops the run once provider-reported tokens reach the limit", async () => {
    const model = busyModel(1, { inputTokens: 60, outputTokens: 10 });
    const { report } = await runWithBudgets(model, { maxTokens: 100 });

    expect(report.status).toBe("failed");
    expect(model.requests).toHaveLength(2);
  });

  it("stops the run once reported cost reaches the limit, counted exactly and in one currency", async () => {
    const priced = busyModel(1, {
      inputTokens: 10,
      outputTokens: 1,
      cost: { amountDecimal: "0.03", currency: "USD" },
    });
    const spent = await runWithBudgets(priced, {
      maxCost: { amountDecimal: "0.05", currency: "USD" },
    });
    expect(spent.report.status).toBe("failed");
    expect(priced.requests).toHaveLength(2);

    const foreign = busyModel(1, {
      inputTokens: 10,
      outputTokens: 1,
      cost: { amountDecimal: "0.01", currency: "EUR" },
    });
    const mismatched = await runWithBudgets(foreign, {
      maxCost: { amountDecimal: "100", currency: "USD" },
    });
    expect(mismatched.report.status).toBe("failed");
    expect(foreign.requests).toHaveLength(1);
  });

  it("leaves a run that stays within every limit alone", async () => {
    const model = busyModel(1, {
      inputTokens: 10,
      outputTokens: 1,
      cost: { amountDecimal: "0.001", currency: "USD" },
    });
    const { report } = await runWithBudgets(
      model,
      { maxModelCalls: 6, maxTokens: 1_000, maxCost: { amountDecimal: "1", currency: "USD" } },
      { maxToolCalls: 6 },
    );

    expect(report.status).toBe("completed");
    expect(model.requests).toHaveLength(6);
  });
});
