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
import { createMemory, listMemories } from "@zet-harness/db/durable-memory-records";
import { createProject } from "@zet-harness/db/durable-project-records";
import { SortableIdGenerator } from "@zet-harness/db/sortable-id";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";
import type {
  AdapterInvocationContext,
  HarnessPlugin,
  JsonObject,
  ModelAdapter,
  ModelRequest,
  ModelResult,
  NodeDefinition,
} from "@zet-harness/plugin-api";

import { actionToolSpecifications } from "./runtime-action-tools.js";
import { createAgentNodeExecutor } from "./runtime-agent-nodes.js";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { compileEditorGraph, createRunFromCompiledGraph } from "./runtime-graphs.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import { MEMORY_ACTION_TOOL_IDS, createMemoryActionTools } from "./runtime-memory-actions.js";
import { createPluginNodeExecutor } from "./runtime-plugin-executor.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";
import { RuntimeRunDispatcher } from "./runtime-run-dispatcher.js";

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

/** A model that answers from a fixed script and remembers what it was asked. */
function scriptedModel(responses: readonly ModelResult[]): {
  readonly adapter: ModelAdapter;
  readonly requests: ModelRequest[];
} {
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

function invocation(logicalEffectId: string, runId: string): AdapterInvocationContext {
  return {
    runId,
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId,
    signal: new AbortController().signal,
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => 0,
    },
  };
}

/** start → loop ─body→ think → act ─repeat→ loop ─done→ finish */
function agentGraph(conversationId: string, config: Record<string, unknown>): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "agent-memory-writes",
    revisionId: `rev-${
      Object.entries(config)
        .map(([key, value]) => `${key}-${String(value)}`)
        .sort()
        .join("-") || "plain"
    }`,
    inputs: [],
    outputs: [{ id: "result", schema: true, source: { nodeId: "finish", port: "done" } }],
    nodes: [
      { id: "start", type: "test.step", version: "1", config: {} },
      { id: "loop", type: LOOP_NODE_TYPE, version: "1", config: { maxIterations: 4 } },
      {
        id: "think",
        type: AGENT_MODEL_NODE_TYPE,
        version: "1",
        config: {
          conversationId,
          systemPrompt: "You keep track of what matters about this project.",
          reserveOutputTokens: 1_000,
          ...config,
        },
      },
      {
        id: "act",
        type: AGENT_TOOLS_NODE_TYPE,
        version: "1",
        config: { conversationId, ...config },
      },
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
    parts: [{ kind: "text", text: "Keep track of how we release." }],
    nowMs: 1,
  });

  const redaction = new RuntimeRedactionRegistry();
  const authority = new CapabilityPermissionPolicy();
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
  dispatchers.push(dispatcher);
  dispatcher.start();

  const remember = (title: string, body: string, nowMs = 2_000): string =>
    createMemory(database.connection(), {
      memoryId: ids.next(),
      projectId,
      title,
      body,
      kind: "fact",
      nowMs,
    }).memoryId;

  const run = async (config: Record<string, unknown> = {}) => {
    const compiled = await compileEditorGraph(
      agentGraph(conversationId, config),
      { host },
      authority,
    );
    if (!compiled.valid) {
      throw new Error(`The agent graph did not compile: ${JSON.stringify(compiled.diagnostics)}`);
    }
    const { runId } = await createRunFromCompiledGraph(database, compiled.compiled);
    return { runId, report: await dispatcher.dispatch(runId) };
  };

  return { database, ids, model, projectId, conversationId, remember, run };
}

function toolResults(
  database: SqliteDatabase,
  conversationId: string,
): readonly Record<string, unknown>[] {
  return readConversationMessages(database.connection(), conversationId)
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.parts)
    .filter((part) => part.kind === "tool-result")
    .map((part) => (part as { readonly value: Record<string, unknown> }).value);
}

describe("an agent writing what a project remembers (9.6)", () => {
  it("writes a memory of its own, marked as this run's, and is told it next time", async () => {
    const { database, model, projectId, conversationId, run } = await setup([
      callTool("call-1", "harness_memory_remember", {
        title: "Ship on Fridays",
        body: "Releases go out on Friday mornings, after the weekly review.",
        kind: "decision",
        pinned: true,
      }),
      reply("Noted."),
    ]);

    const { runId, report } = await run();
    expect(report.status).toBe("completed");

    const memories = listMemories(database.connection(), projectId, {});
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      title: "Ship on Fridays",
      kind: "decision",
      pinned: true,
      source: "agent",
      sourceRunId: runId,
    });

    // The tool answered the model with the memory it wrote.
    expect(toolResults(database, conversationId)[0]).toMatchObject({
      ok: true,
      memory: { title: "Ship on Fridays", source: "agent" },
    });

    // And the next step of the same run is told what it decided to remember.
    const second = model.requests[1];
    expect(second).toBeDefined();
    const text = second!.messages
      .flatMap((message) => message.parts.map((part) => (part.kind === "text" ? part.text : "")))
      .join("\n");
    expect(text).toContain("What this project remembers, pinned first");
    expect(text).toContain("[decision, pinned] Ship on Fridays");
  });

  it("corrects a memory a person wrote, and refuses one from another project", async () => {
    // The script is filled in after setup, because it names the memory the person wrote.
    const script: ModelResult[] = [];
    const { database, projectId, conversationId, remember, run } = await setup(script);
    const memoryId = remember("Staging URL", "https://staging.example");
    script.push(
      callTool("call-1", "harness_memory_update", {
        memoryId: "01890a5d-ac96-774b-bcce-b302099a8057",
        pinned: true,
      }),
      callTool("call-2", "harness_memory_update", {
        memoryId,
        title: "Staging site",
        pinned: true,
      }),
      reply("Fixed."),
    );

    const { report } = await run();
    expect(report.status).toBe("completed");

    const results = toolResults(database, conversationId);
    expect(results[0]).toMatchObject({
      ok: false,
      error: { code: "MEMORY_NOT_FOUND", field: "memoryId" },
    });
    expect(results[1]).toMatchObject({ ok: true, memory: { title: "Staging site" } });
    expect(listMemories(database.connection(), projectId, {})).toHaveLength(1);
    expect(listMemories(database.connection(), projectId, {})[0]).toMatchObject({
      memoryId,
      title: "Staging site",
      pinned: true,
      // Correcting a memory does not make it the agent's; it keeps who wrote it.
      source: "person",
      sourceRunId: null,
    });
  });

  it("offers no way to forget, and nothing at all to a step that sees no memory", async () => {
    const { database, projectId, conversationId, run } = await setup([
      callTool("call-1", "harness_memory_remember", { title: "Never", body: "Written." }),
      reply("I could not."),
    ]);

    const names = actionToolSpecifications(
      createMemoryActionTools({ database, projectId, runId: "run-test" }),
    ).map((specification) => specification.name);
    expect(names).toEqual([
      "harness_memory_list",
      "harness_memory_remember",
      "harness_memory_update",
    ]);
    expect(names.some((name) => name.includes("forget"))).toBe(false);

    const { report } = await run({ maxMemories: 0 });
    expect(report.status).toBe("completed");
    expect(toolResults(database, conversationId)[0]).toMatchObject({
      ok: false,
      error: { code: "TOOL_NOT_AVAILABLE" },
    });
    expect(listMemories(database.connection(), projectId, {})).toHaveLength(0);
  });

  it("writes once when a step is retried with the same logical effect", async () => {
    const { database, ids, projectId, run } = await setup([reply("Nothing to do.")]);
    const { runId } = await run();

    const tools = createMemoryActionTools({
      database,
      projectId,
      runId,
      now: () => 5_000,
      createId: () => ids.next(),
    });
    const remember = tools.find((tool) => tool.manifest.id === MEMORY_ACTION_TOOL_IDS.remember);
    expect(remember).toBeDefined();
    const input = { title: "Ship on Fridays", body: "After the weekly review." };
    const first = await remember!.invoke(input, invocation("zet-effect-v1:retry", runId));
    const second = await remember!.invoke(input, invocation("zet-effect-v1:retry", runId));

    expect(second.value).toEqual(first.value);
    expect(listMemories(database.connection(), projectId, {})).toHaveLength(1);
  });
});
