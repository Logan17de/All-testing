import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_MODEL_NODE_TYPE,
  CapabilityPermissionPolicy,
  PluginHost,
  createAgentPlugin,
} from "@zet-harness/core";
import { SQLITE_MEMORY_PATH, SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { appendMessage, createConversation } from "@zet-harness/db/durable-conversation-records";
import { createProject } from "@zet-harness/db/durable-project-records";
import { listConversationSummaries } from "@zet-harness/db/durable-summary-records";
import { SortableIdGenerator } from "@zet-harness/db/sortable-id";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";
import type {
  ModelAdapter,
  ModelMessage,
  ModelRequest,
  ModelResult,
} from "@zet-harness/plugin-api";

import { createAgentNodeExecutor } from "./runtime-agent-nodes.js";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { compileEditorGraph, createRunFromCompiledGraph } from "./runtime-graphs.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
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

const SUMMARY_TEXT = "The team agreed to launch on Thursday and to skip the beta.";

/** Answers a summarize request with a summary, and anything else with a short reply. */
function scriptedModel(): { readonly adapter: ModelAdapter; readonly requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
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
      const summarizing = request.messages.some((message) =>
        message.parts.some(
          (part) => part.kind === "text" && part.text.startsWith("Summarize the conversation"),
        ),
      );
      const result: ModelResult = summarizing
        ? {
            message: { role: "assistant", parts: [{ kind: "text", text: SUMMARY_TEXT }] },
            finishReason: "stop",
            usage: { inputTokens: 200, outputTokens: 20 },
          }
        : {
            message: { role: "assistant", parts: [{ kind: "text", text: "Understood." }] },
            finishReason: "stop",
            usage: { inputTokens: 40, outputTokens: 5 },
          };
      return Promise.resolve(result);
    },
  };
  return { adapter, requests };
}

/** Two model steps in one run, so the second sees what the first spent. */
function twoStepGraph(conversationId: string, config: Record<string, unknown>): GraphJsonV1 {
  const node = (id: string) => ({
    id,
    type: AGENT_MODEL_NODE_TYPE,
    version: "1",
    config: {
      conversationId,
      systemPrompt: "You help with this project.",
      reserveOutputTokens: 1_000,
      ...config,
    },
  });
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "agent-summary-two",
    revisionId: `rev-${Object.entries(config)
      .map(([key, value]) => `${key}-${String(value)}`)
      .sort()
      .join("-")}`,
    inputs: [],
    outputs: [{ id: "result", schema: true, source: { nodeId: "second", port: "again" } }],
    nodes: [node("think"), node("second")],
    edges: [{ id: "then", kind: "control", from: { nodeId: "think" }, to: { nodeId: "second" } }],
    entrypoints: [{ id: "main", nodeId: "think" }],
    policies: {
      maxNodeExecutions: 10,
      maxParallelism: 1,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
  };
}

function agentGraph(conversationId: string, config: Record<string, unknown>): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "agent-summary",
    revisionId: `rev-${Object.entries(config)
      .map(([key, value]) => `${key}-${String(value)}`)
      .sort()
      .join("-")}`,
    inputs: [],
    outputs: [{ id: "result", schema: true, source: { nodeId: "think", port: "again" } }],
    nodes: [
      {
        id: "think",
        type: AGENT_MODEL_NODE_TYPE,
        version: "1",
        config: {
          conversationId,
          systemPrompt: "You help with this project.",
          reserveOutputTokens: 1_000,
          ...config,
        },
      },
    ],
    edges: [],
    entrypoints: [{ id: "main", nodeId: "think" }],
    policies: {
      maxNodeExecutions: 10,
      maxParallelism: 1,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
  };
}

async function setup() {
  const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  database.open();
  runSqliteMigrations(database.connection(), RUNTIME_DATABASE_MIGRATIONS);
  databases.push(database);

  const host = new PluginHost();
  hosts.push(host);
  await host.activate(createAgentPlugin());
  const model = scriptedModel();
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

  let parentMessageId: string | undefined;
  const say = (text: string): string => {
    const message = appendMessage(database.connection(), {
      conversationId,
      messageId: ids.next(),
      role: "user",
      parts: [{ kind: "text", text }],
      ...(parentMessageId === undefined ? {} : { parentMessageId }),
      nowMs: 1,
    });
    parentMessageId = message.messageId;
    return message.messageId;
  };

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

  const run = async (config: Record<string, unknown>) => {
    const compiled = await compileEditorGraph(
      agentGraph(conversationId, config),
      { host },
      authority,
    );
    if (!compiled.valid) throw new Error(JSON.stringify(compiled.diagnostics));
    const { runId } = await createRunFromCompiledGraph(database, compiled.compiled);
    return { runId, report: await dispatcher.dispatch(runId) };
  };

  const runTwoSteps = async (config: Record<string, unknown>) => {
    const compiled = await compileEditorGraph(
      twoStepGraph(conversationId, config),
      { host },
      authority,
    );
    if (!compiled.valid) throw new Error(JSON.stringify(compiled.diagnostics));
    const { runId } = await createRunFromCompiledGraph(database, compiled.compiled);
    return { runId, report: await dispatcher.dispatch(runId) };
  };

  return { database, model, conversationId, say, run, runTwoSteps };
}

function textOf(messages: readonly ModelMessage[]): string {
  return messages
    .flatMap((message) => message.parts.map((part) => (part.kind === "text" ? part.text : "")))
    .join("\n");
}

function usageOf(database: SqliteDatabase, runId: string): Record<string, unknown> {
  const row = database
    .connection()
    .prepare("SELECT usage_json AS usage FROM node_attempts WHERE run_id = ? ORDER BY attempt DESC")
    .get(runId) as { readonly usage: string };
  return JSON.parse(row.usage) as Record<string, unknown>;
}

describe("summarizing a conversation only when it no longer fits (9.7)", () => {
  it("leaves a conversation that fits alone", async () => {
    const { database, model, conversationId, say, run } = await setup();
    say("Plan the launch.");

    const { runId, report } = await run({ maxContextBytes: 20_000 });

    expect(report.status).toBe("completed");
    expect(model.requests).toHaveLength(1);
    expect(listConversationSummaries(database.connection(), conversationId)).toEqual([]);
    expect(usageOf(database, runId)["summary"]).toMatchObject({ used: false, wrote: false });
  });

  it("folds the oldest messages into a stored summary when they no longer fit", async () => {
    const { database, model, conversationId, say, run } = await setup();
    say(`First: ${"a".repeat(600)}`);
    say(`Second: ${"b".repeat(600)}`);
    const third = say("Third: what is left to do?");

    const { runId, report } = await run({ maxContextBytes: 1_200 });

    expect(report.status).toBe("completed");
    // One call to summarize, then the step's own call.
    expect(model.requests).toHaveLength(2);
    expect(textOf(model.requests[0]!.messages)).toContain("Summarize the conversation");

    const summaries = listConversationSummaries(database.connection(), conversationId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      summary: SUMMARY_TEXT,
      model: "test.model@1",
      runId,
      usage: { inputTokens: 200, outputTokens: 20 },
    });
    expect(summaries[0]!.throughMessageId).not.toBe(third);

    // The step itself was given the summary in place of the messages it covers.
    const sent = textOf(model.requests[1]!.messages);
    expect(sent).toContain("earlier messages of this conversation");
    expect(sent).toContain(SUMMARY_TEXT);
    expect(sent).toContain("Third: what is left to do?");
    expect(usageOf(database, runId)["summary"]).toMatchObject({
      used: true,
      wrote: true,
      throughMessageId: summaries[0]!.throughMessageId,
    });
  });

  it("reuses a stored summary on the next step instead of writing another", async () => {
    const { database, model, conversationId, say, run } = await setup();
    say(`First: ${"a".repeat(600)}`);
    say(`Second: ${"b".repeat(600)}`);
    say("Third: what is left to do?");

    await run({ maxContextBytes: 1_200 });
    expect(model.requests).toHaveLength(2);

    const second = await run({ maxContextBytes: 1_201 });

    expect(second.report.status).toBe("completed");
    // Only the step's own call: the summary it already paid for still covers those messages.
    expect(model.requests).toHaveLength(3);
    expect(listConversationSummaries(database.connection(), conversationId)).toHaveLength(1);
    expect(textOf(model.requests[2]!.messages)).toContain(SUMMARY_TEXT);
    expect(usageOf(database, second.runId)["summary"]).toMatchObject({ used: true, wrote: false });
  });

  it("counts a summary's tokens against the run's token budget", async () => {
    const { database, model, conversationId, say, runTwoSteps } = await setup();
    say(`First: ${"a".repeat(600)}`);
    say(`Second: ${"b".repeat(600)}`);
    say("Third: what is left to do?");

    // The first step summarizes (220 tokens) and replies (45). The second step is then
    // over a 100-token limit that the stored messages alone would never have reached.
    const { report } = await runTwoSteps({ maxContextBytes: 1_200, maxTokens: 100 });

    expect(report.status).toBe("failed");
    expect(model.requests).toHaveLength(2);
    expect(listConversationSummaries(database.connection(), conversationId)[0]?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 20,
    });
  });
});
