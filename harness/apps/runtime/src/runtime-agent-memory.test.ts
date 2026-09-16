import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_MODEL_NODE_TYPE,
  CapabilityPermissionPolicy,
  PluginHost,
  createAgentPlugin,
} from "@zet-harness/core";
import { SQLITE_MEMORY_PATH, SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { appendMessage, createConversation } from "@zet-harness/db/durable-conversation-records";
import { createMemory } from "@zet-harness/db/durable-memory-records";
import { createProject } from "@zet-harness/db/durable-project-records";
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

const reply: ModelResult = {
  message: { role: "assistant", parts: [{ kind: "text", text: "Understood." }] },
  finishReason: "stop",
  usage: { inputTokens: 40, outputTokens: 5 },
};

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
        // The agent always offers the project's goal actions, so a model needs tools.
        tools: true,
        vision: false,
        structuredOutput: false,
        contextWindowTokens: 32_000,
      },
    },
    generate: (request) => {
      requests.push(structuredClone(request));
      return Promise.resolve(structuredClone(reply));
    },
  };
  return { adapter, requests };
}

/** One agent model step, so the test reads exactly one built context. */
function agentGraph(conversationId: string, config: Record<string, unknown> = {}): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "agent-memory",
    revisionId: `rev-${
      Object.entries(config)
        .map(([key, value]) => `${key}-${String(value)}`)
        .sort()
        .join("-") || "plain"
    }`,
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
  appendMessage(database.connection(), {
    messageId: ids.next(),
    conversationId,
    role: "user",
    parts: [{ kind: "text", text: "What should I do next?" }],
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

  const remember = (title: string, body: string, pinned = false, nowMs = 2_000): void => {
    createMemory(database.connection(), {
      memoryId: ids.next(),
      projectId,
      title,
      body,
      kind: pinned ? "preference" : "fact",
      pinned,
      nowMs,
    });
  };

  const run = async (config?: Record<string, unknown>) => {
    const compiled = await compileEditorGraph(
      agentGraph(conversationId, config),
      { host },
      authority,
    );
    if (!compiled.valid) throw new Error(JSON.stringify(compiled.diagnostics));
    const { runId } = await createRunFromCompiledGraph(database, compiled.compiled);
    return { runId, report: await dispatcher.dispatch(runId) };
  };

  return { database, model, projectId, conversationId, remember, run };
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

describe("what an agent is told a project remembers (9.6)", () => {
  it("offers pinned memories first, then recent ones, and accounts for them", async () => {
    const { database, model, remember, run } = await setup();
    remember("Weekly demo", "The team demos on Wednesdays.", false, 2_000);
    remember("Prefers short replies", "A few lines unless asked for detail.", true, 1_500);
    remember("Staging URL", "https://staging.example", false, 3_000);

    const { runId, report } = await run();
    expect(report.status).toBe("completed");

    const request = model.requests[0];
    expect(request).toBeDefined();
    const text = textOf(request!.messages);
    expect(text).toContain("What this project remembers, pinned first");
    // Pinned first, then most recently changed.
    expect(text.indexOf("Prefers short replies")).toBeLessThan(text.indexOf("Staging URL"));
    expect(text.indexOf("Staging URL")).toBeLessThan(text.indexOf("Weekly demo"));
    expect(text).toContain("[preference, pinned] Prefers short replies");

    const usage = usageOf(database, runId);
    expect(usage["memory"]).toEqual({ offered: 3, included: true });
    const sections = (usage["context"] as { readonly sections: { readonly id: string }[] })
      .sections;
    expect(sections.map((section) => section.id)).toContain("memory");
    expect(sections.find((section) => section.id === "memory")).toMatchObject({
      required: false,
      keptMessages: 1,
    });
  });

  it("says nothing about memory when the project remembers nothing", async () => {
    const { database, model, run } = await setup();
    const { runId } = await run();

    expect(textOf(model.requests[0]!.messages)).not.toContain("this project remembers");
    expect(usageOf(database, runId)["memory"]).toEqual({ offered: 0, included: false });
  });

  it("drops memories, not the conversation or the goals, when the context is tight", async () => {
    const { database, model, remember, run } = await setup();
    remember("A long memory", "x".repeat(2_000), true, 2_000);

    // A byte cap that fits the required sections and the conversation, but not the memories.
    const { runId, report } = await run({ maxContextBytes: 700 });
    expect(report.status).toBe("completed");

    const text = textOf(model.requests[0]!.messages);
    expect(text).toContain("You help with this project.");
    expect(text).toContain("What should I do next?");
    expect(text).not.toContain("A long memory");
    expect(usageOf(database, runId)["memory"]).toEqual({ offered: 1, included: false });
  });

  it("offers no memories when the step asks for none, and honours a smaller limit", async () => {
    const { database, model, remember, run } = await setup();
    remember("First", "One.", false, 2_000);
    remember("Second", "Two.", false, 3_000);

    const none = await run({ maxMemories: 0 });
    expect(usageOf(database, none.runId)["memory"]).toEqual({ offered: 0, included: false });
    expect(textOf(model.requests[0]!.messages)).not.toContain("this project remembers");

    const one = await run({ maxMemories: 1 });
    expect(usageOf(database, one.runId)["memory"]).toEqual({ offered: 1, included: true });
    const text = textOf(model.requests[1]!.messages);
    expect(text).toContain("Second");
    expect(text).not.toContain("First");
  });
});
