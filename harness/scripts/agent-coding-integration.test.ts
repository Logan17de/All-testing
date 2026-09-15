import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { createGoal, createTodo, readGoal, readTodo } from "@zet-harness/db/durable-goal-records";
import { createProject } from "@zet-harness/db/durable-project-records";
import { SortableIdGenerator } from "@zet-harness/db/sortable-id";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";
import { createScriptedModelAdapter } from "@zet-harness/models";
import type {
  HarnessPlugin,
  JsonObject,
  ModelAdapter,
  ModelRequest,
  ModelResult,
  NodeDefinition,
} from "@zet-harness/plugin-api";
import {
  FS_READ_CAPABILITY,
  FS_WRITE_CAPABILITY,
  createNativeFileSystemTools,
} from "@zet-harness/tools";

import { createAgentNodeExecutor } from "../apps/runtime/src/runtime-agent-nodes.js";
import { RUNTIME_DATABASE_MIGRATIONS } from "../apps/runtime/src/runtime-daemon.js";
import {
  compileEditorGraph,
  createRunFromCompiledGraph,
} from "../apps/runtime/src/runtime-graphs.js";
import { RuntimeHumanApprovals } from "../apps/runtime/src/runtime-human-approvals.js";
import { createPluginNodeExecutor } from "../apps/runtime/src/runtime-plugin-executor.js";
import { RuntimeRedactionRegistry } from "../apps/runtime/src/runtime-redaction.js";
import { RuntimeRunDispatcher } from "../apps/runtime/src/runtime-run-dispatcher.js";

/**
 * 8.15: a multi-step coding task run end to end on the scripted provider.
 *
 * The model is offline and fully scripted, so every turn is deterministic, but
 * everything around it is real: the compiled agent graph, the durable dispatcher
 * and structured loop, the context builder, the goal and todo actions with their
 * 8.13 goal completion, and the native file-system tools writing into a temporary
 * workspace.
 */

const cleanups: (() => Promise<void> | void)[] = [];

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
  manifest: { id: "test.coding", name: "Coding test nodes", version: "1.0.0", apiVersion: 1 },
  activate(context) {
    context.nodes.register(step);
  },
};

function turn(
  calls: readonly { readonly name: string; readonly arguments: JsonObject }[],
): ModelResult {
  return {
    message: {
      role: "assistant",
      parts: calls.map((call, index) => ({
        kind: "tool-call" as const,
        callId: `call-${String(index)}-${call.name}`,
        name: call.name,
        arguments: call.arguments,
      })),
    },
    finishReason: "tool-calls",
    usage: { inputTokens: 120, outputTokens: 40 },
  };
}

/** The scripted provider, with the context window the agent step needs declared. */
function withContextWindow(adapter: ModelAdapter, requests: ModelRequest[]): ModelAdapter {
  return {
    manifest: {
      ...adapter.manifest,
      features: { ...adapter.manifest.features, streaming: false, contextWindowTokens: 64_000 },
    },
    generate: (request, context) => {
      requests.push(structuredClone(request));
      return adapter.generate(request, context);
    },
  };
}

function agentGraph(conversationId: string): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "coding-agent",
    revisionId: "rev-1",
    inputs: [],
    outputs: [{ id: "result", schema: true, source: { nodeId: "finish", port: "done" } }],
    nodes: [
      { id: "start", type: "test.step", version: "1", config: {} },
      { id: "loop", type: LOOP_NODE_TYPE, version: "1", config: { maxIterations: 8 } },
      {
        id: "think",
        type: AGENT_MODEL_NODE_TYPE,
        version: "1",
        config: {
          conversationId,
          systemPrompt: "You are a careful coding agent. Work through the todos in order.",
          reserveOutputTokens: 2_000,
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
      maxNodeExecutions: 40,
      maxParallelism: 1,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
  };
}

const FIRST_DRAFT = 'export const greet = (name: string) => "Hello " + name;\n';
const FINAL_MODULE =
  "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n";
const TEST_FILE =
  'import { greet } from "./greet";\n\nif (greet("Ada") !== "Hello, Ada!") throw new Error("greet");\n';

describe("multi-step coding agent on the scripted provider", () => {
  it("plans, edits files and completes its goal through the durable agent loop", async () => {
    // The real path: a Windows 8.3 short temp path fails the tools' containment check.
    const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), "zet-agent-coding-")));
    cleanups.push(() => {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
    });

    const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    database.open();
    runSqliteMigrations(database.connection(), RUNTIME_DATABASE_MIGRATIONS);
    cleanups.push(() => {
      database.close();
    });

    const ids = new SortableIdGenerator({ now: () => 1_000 });
    const connection = database.connection();
    const { projectId } = createProject(connection, {
      projectId: ids.next(),
      name: "Greeting library",
      workspacePath: workspace,
      nowMs: 1,
    });
    const { conversationId } = createConversation(connection, {
      conversationId: ids.next(),
      projectId,
      title: "Add a greeting module",
      nowMs: 1,
    });
    const { goalId } = createGoal(connection, {
      goalId: ids.next(),
      projectId,
      conversationId,
      title: "Ship greet()",
      priority: 5,
      nowMs: 1,
    });
    const moduleTodo = createTodo(connection, {
      todoId: ids.next(),
      goalId,
      title: "Write src/greet.ts",
      nowMs: 1,
    });
    const testTodo = createTodo(connection, {
      todoId: ids.next(),
      goalId,
      title: "Write src/greet.check.ts",
      dependsOn: [moduleTodo.todoId],
      nowMs: 1,
    });
    appendMessage(connection, {
      messageId: ids.next(),
      conversationId,
      role: "user",
      parts: [{ kind: "text", text: "Add a greet(name) module with a check file." }],
      nowMs: 1,
    });

    const script: ModelResult[] = [
      turn([
        {
          name: "harness_todos_set-status",
          arguments: { todoId: moduleTodo.todoId, status: "in_progress" },
        },
        {
          name: "harness_fs_write",
          arguments: { path: "src/greet.ts", content: FIRST_DRAFT, createDirectories: true },
        },
      ]),
      turn([{ name: "harness_fs_read", arguments: { path: "src/greet.ts" } }]),
      turn([
        {
          name: "harness_fs_write",
          arguments: { path: "src/greet.ts", content: FINAL_MODULE, overwrite: true },
        },
        {
          name: "harness_todos_set-status",
          arguments: { todoId: moduleTodo.todoId, status: "done" },
        },
      ]),
      turn([
        {
          name: "harness_todos_set-status",
          arguments: { todoId: testTodo.todoId, status: "in_progress" },
        },
        { name: "harness_fs_write", arguments: { path: "src/greet.check.ts", content: TEST_FILE } },
      ]),
      turn([
        {
          name: "harness_todos_set-status",
          arguments: { todoId: testTodo.todoId, status: "done" },
        },
      ]),
      {
        message: {
          role: "assistant",
          parts: [
            { kind: "text", text: "greet() and its check are written, and the goal is done." },
          ],
        },
        finishReason: "stop",
        usage: { inputTokens: 200, outputTokens: 20 },
      },
    ];
    const requests: ModelRequest[] = [];
    const scripted = createScriptedModelAdapter(script);

    const host = new PluginHost();
    cleanups.push(() => host.dispose());
    await host.activate(testPlugin);
    await host.activate(createControlFlowPlugin());
    await host.activate(createAgentPlugin());
    host.models.register(withContextWindow(scripted, requests));
    const fileSystem = createNativeFileSystemTools({ root: workspace, enableWrite: true });

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
          tools: fileSystem.adapters,
          allows: (capability) =>
            capability === FS_READ_CAPABILITY || capability === FS_WRITE_CAPABILITY,
          createId: () => ids.next(),
          fallback: createPluginNodeExecutor({ host }),
        }),
      },
      redaction,
      authority,
    );
    cleanups.push(() => dispatcher.stop());
    dispatcher.start();

    const compiled = await compileEditorGraph(agentGraph(conversationId), { host }, authority);
    if (!compiled.valid) {
      throw new Error(`The coding graph did not compile: ${JSON.stringify(compiled.diagnostics)}`);
    }
    const { runId } = await createRunFromCompiledGraph(database, compiled.compiled);
    const report = await dispatcher.dispatch(runId);

    expect(report.status).toBe("completed");
    expect(scripted.callsConsumed).toBe(script.length);

    const messages = readConversationMessages(connection, conversationId);
    const results = messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.parts);
    const failed = results.filter((part) => part.kind !== "tool-result" || part.isError === true);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(results).toHaveLength(8);

    expect(readFileSync(join(workspace, "src", "greet.ts"), "utf8")).toBe(FINAL_MODULE);
    expect(readFileSync(join(workspace, "src", "greet.check.ts"), "utf8")).toBe(TEST_FILE);

    expect(readTodo(connection, moduleTodo.todoId)?.status).toBe("done");
    expect(readTodo(connection, testTodo.todoId)?.status).toBe("done");
    expect(readGoal(connection, goalId)).toMatchObject({ status: "completed", blockedBy: null });

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      ...Array.from({ length: 5 }, () => ["assistant", "tool"]).flat(),
      "assistant",
    ]);
    expect(messages.slice(1).every((message) => message.runId === runId)).toBe(true);

    // The third turn was planned with the first draft's contents in view.
    expect(JSON.stringify(requests[2]?.messages)).toContain('Hello \\" + name');
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["harness_fs_write", "harness_fs_read", "harness_todos_set-status"]),
    );
  });
});
