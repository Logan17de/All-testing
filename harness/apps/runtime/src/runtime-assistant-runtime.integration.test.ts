import type { GraphJsonV1 } from "@zet-harness/graph";
import type { ModelResult, ModelRequest, ToolAdapter } from "@zet-harness/plugin-api";
import { expect, it, vi } from "vitest";
import { createSortableId } from "@zet-harness/db/sortable-id";
import { SQLITE_MEMORY_PATH } from "@zet-harness/db";
import { RuntimeDaemon } from "./runtime-daemon.js";
interface AssistantSnapshot {
  binding: { assistantId: string; epoch: number };
  grants: { chatId: string; permissions: string[] }[];
}
it("real offline daemon guards assistant connections with CSRF, explicit consent and immutable child subsets", async () => {
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path: SQLITE_MEMORY_PATH },
    probePathLimits: false,
  });
  await daemon.start();
  const api = daemon.snapshot().api;
  const base = `http://${api.host}:${String(api.port)}`;
  try {
    const { csrfToken } = (await (await fetch(`${base}/api/session`)).json()) as {
      csrfToken: string;
    };
    const post = (
      path: string,
      action: string,
      params: Record<string, unknown>,
      token = csrfToken,
    ) =>
      fetch(`${base}/api/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zet-csrf": token },
        body: JSON.stringify({ action, params }),
      });
    const sessionResponse = await post("agent", "session/start", { title: "Target fixture" });
    expect(sessionResponse.status).toBe(200);
    const {
      result: { session },
    } = (await sessionResponse.json()) as { result: { session: { id: string } } };
    const metadata = (await (await fetch(`${base}/api/assistant`)).json()) as {
      chats: { id: string; title: string }[];
    };
    expect(metadata.chats.find((chat) => chat.id === session.id)?.title).toBe("Target fixture");
    const created = await post("assistant", "create", {});
    expect(created.status).toBe(200);
    const { result: initial } = (await created.json()) as { result: AssistantSnapshot };
    const assistantId = initial.binding.assistantId;
    expect(initial.grants.some((grant) => grant.chatId === session.id)).toBe(false);
    const params = { assistantId, chatId: session.id, permissions: ["read"], confirm: true };
    expect((await post("assistant", "connect", params, "")).status).toBe(403);
    expect((await post("assistant", "connect", { ...params, confirm: false })).status).toBe(400);
    expect(
      (await post("assistant", "connect", { ...params, chatId: "outside-workspace" })).status,
    ).toBe(400);
    const connected = await post("assistant", "connect", params);
    expect(connected.status).toBe(200);
    const { result: granted } = (await connected.json()) as { result: AssistantSnapshot };
    expect(granted.grants.find((grant) => grant.chatId === session.id)?.permissions).toEqual([
      "read",
    ]);
    expect(
      (
        await post("assistant", "child/create", {
          assistantId,
          grants: [{ chatId: session.id, permissions: ["read", "control"] }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("assistant", "child/create", {
          assistantId,
          grants: [{ chatId: session.id, permissions: ["read"] }],
        })
      ).status,
    ).toBe(200);
    expect(
      (await post("assistant", "disconnect", { assistantId, chatId: session.id })).status,
    ).toBe(200);
    const read = await post("assistant", "read", { assistantId });
    const { result: revoked } = (await read.json()) as { result: AssistantSnapshot };
    expect(revoked.grants.some((grant) => grant.chatId === session.id)).toBe(false);
    expect(revoked.binding.epoch).toBeGreaterThan(granted.binding.epoch);
  } finally {
    await daemon.stop();
  }
});

it.each(["inference", "tool"] as const)(
  "concrete coding executor drops pre-floor history and refuses pending %s after authority cut",
  async (mode) => {
    const { PluginHost, CapabilityPermissionPolicy, createAgentPlugin, createControlFlowPlugin } =
      await import("@zet-harness/core");
    const { SqliteDatabase, runSqliteMigrations } = await import("@zet-harness/db");
    const { saveModelConfig } = await import("@zet-harness/db/durable-model-records");
    const { appendMessage, readConversationMessages } =
      await import("@zet-harness/db/durable-conversation-records");
    const { RUNTIME_DATABASE_MIGRATIONS } = await import("./runtime-daemon.js");
    const { RuntimeCodingService } = await import("./runtime-coding-service.js");
    const { RuntimeHumanApprovals } = await import("./runtime-human-approvals.js");
    const { RuntimeRedactionRegistry } = await import("./runtime-redaction.js");
    const { RuntimeRunDispatcher } = await import("./runtime-run-dispatcher.js");
    const { createAgentNodeExecutor } = await import("./runtime-agent-nodes.js");
    const { createPluginNodeExecutor } = await import("./runtime-plugin-executor.js");
    const db = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    db.open();
    runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
    const host = new PluginHost();
    await host.activate(createControlFlowPlugin());
    await host.activate(createAgentPlugin());
    let current = true;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (result: ModelResult) => void;
    const requests: ModelRequest[] = [];
    let finishTool!: (result: { value: { text: string } }) => void;
    const tool: ToolAdapter = {
      manifest: {
        id: "fixture.assistant.read",
        version: "1",
        title: "Scripted private read",
        inputSchema: { type: "object" },
        outputSchema: true,
        behavior: {
          primitiveFamily: "effect",
          determinism: "nondeterministic",
          effect: "external-read",
          idempotency: "idempotent",
          recovery: "manual",
          executionMode: "in-process",
          requiredCapabilities: [],
        },
      },
      invoke: () => {
        entered();
        return new Promise((resolve) => {
          finishTool = resolve;
        });
      },
    };
    host.models.register({
      manifest: {
        id: "fixture.assistant",
        version: "1",
        title: "Scripted assistant",
        requiredCapabilities: [],
        features: {
          streaming: false,
          tools: true,
          vision: false,
          structuredOutput: false,
          contextWindowTokens: 32000,
        },
      },
      generate: (request) => {
        requests.push(request);
        if (mode === "tool")
          return Promise.resolve({
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "tool-call" as const,
                  callId: "private-read",
                  name: "fixture_assistant_read",
                  arguments: {},
                },
              ],
            },
            finishReason: "tool-calls" as const,
          });
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    saveModelConfig(db.connection(), {
      modelId: "fixture.assistant",
      title: "Fixture",
      profile: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "fixture",
      tools: true,
      contextWindowTokens: 32000,
      nowMs: Date.now(),
    });
    const redaction = new RuntimeRedactionRegistry(),
      authority = new CapabilityPermissionPolicy();
    const approvals = new RuntimeHumanApprovals(db, {
      redaction,
      authority,
      onResolved: () => undefined,
    });
    const dispatcher = new RuntimeRunDispatcher(
      db,
      approvals,
      {
        execute: (execution) =>
          createAgentNodeExecutor({
            database: db,
            models: host.models,
            tools: mode === "tool" ? [tool] : [],
            toolOwner: (candidate) => (candidate === tool ? "fixture.owner" : undefined),
            projectContext: false,
            filterMessagePath: (_ctx, _id, messages) =>
              messages.filter(
                (message) =>
                  !message.parts.some(
                    (part) => part.kind === "text" && part.text.includes("PRE-FLOOR-PRIVATE"),
                  ),
              ),
            assertInvocation: () => {
              if (!current) throw new Error("Assistant authority revoked.");
            },
            configuredModels: () => new Set(["fixture.assistant"]),
            fallback: createPluginNodeExecutor({ host }),
          })(execution),
      },
      redaction,
      authority,
    );
    const coding = new RuntimeCodingService({
      database: db,
      workspace: () => process.cwd(),
      approvals,
      sources: () => ({ host }),
      capabilityAuthority: () => authority,
      redact: (value) => redaction.redact(value),
      dispatch: (runId) => dispatcher.wake(runId),
      cancel: (runId) => dispatcher.cancelRun(runId),
    });
    dispatcher.start();
    try {
      const { session } = (await coding.action("session/start", {
        title: "Assistant context fixture",
      })) as { session: { id: string } };
      appendMessage(db.connection(), {
        messageId: createSortableId(),
        conversationId: session.id,
        role: "user",
        parts: [{ kind: "text", text: "PRE-FLOOR-PRIVATE" }],
        nowMs: Date.now(),
      });
      await coding.action("turn/start", {
        sessionId: session.id,
        text: "CURRENT-ALLOWED",
        modelId: "fixture.assistant",
      });
      await started;
      expect(JSON.stringify(requests[0])).not.toContain("PRE-FLOOR-PRIVATE");
      expect(JSON.stringify(requests[0])).toContain("CURRENT-ALLOWED");
      expect(requests[0]?.tools?.some((tool) => /goal|memory/.test(tool.name))).not.toBe(true);
      current = false;
      if (mode === "tool") finishTool({ value: { text: "ANSWER-AFTER-CUT" } });
      else
        finish({
          message: { role: "assistant", parts: [{ kind: "text", text: "ANSWER-AFTER-CUT" }] },
          finishReason: "stop",
        });
      await dispatcher.stop();
      expect(JSON.stringify(readConversationMessages(db.connection(), session.id))).not.toContain(
        "ANSWER-AFTER-CUT",
      );
    } finally {
      coding.close();
      await dispatcher.stop();
      await host.dispose();
      db.close();
    }
  },
);

it.each(["instructions", "compile", "prompt-commit", "run-commit"] as const)(
  "prepared turn pins its epoch across paused %s and never rebinds stale authority",
  async (stage) => {
    const { PluginHost, CapabilityPermissionPolicy, createAgentPlugin, createControlFlowPlugin } =
      await import("@zet-harness/core");
    const { SqliteDatabase, runSqliteMigrations } = await import("@zet-harness/db");
    const { readConversationMessages } =
      await import("@zet-harness/db/durable-conversation-records");
    const { RUNTIME_DATABASE_MIGRATIONS } = await import("./runtime-daemon.js");
    const { RuntimeCodingService } = await import("./runtime-coding-service.js");
    const { RuntimeHumanApprovals } = await import("./runtime-human-approvals.js");
    const { RuntimeRedactionRegistry } = await import("./runtime-redaction.js");
    const instructions = await import("./runtime-workspace-instructions.js");
    const graphs = await import("./runtime-graphs.js");
    const db = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    db.open();
    runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
    const host = new PluginHost();
    await host.activate(createControlFlowPlugin());
    await host.activate(createAgentPlugin());
    const policy = new CapabilityPermissionPolicy(),
      redaction = new RuntimeRedactionRegistry();
    const approvals = new RuntimeHumanApprovals(db, {
      redaction,
      authority: policy,
      onResolved: () => undefined,
    });
    let epoch = 1,
      prepared = false,
      armed = true,
      commits = 0;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const pause = async () => {
      if (armed) {
        armed = false;
        enter();
        await gate;
      }
    };
    const bind = vi.fn();
    let parentScopes = { model: ["harness.fs.read"], tools: ["harness.fs.list"] };
    const coding = new RuntimeCodingService({
      database: db,
      workspace: () => process.cwd(),
      approvals,
      sources: () => ({ host }),
      capabilityAuthority: () => policy,
      redact: (value) => redaction.redact(value),
      dispatch: () => undefined,
      restrictToolScopes: (_sessionId, own) => ({
        model: parentScopes.model.filter((id) => own.model === null || own.model.includes(id)),
        tools: parentScopes.tools.filter((id) => own.tools === null || own.tools.includes(id)),
      }),
      isModelConfigured: () => true,
      cancel: () => Promise.resolve(),
      prepareTurn: () => {
        const captured = epoch;
        prepared = true;
        return {
          check: () => {
            if (epoch !== captured) throw new Error("Prepared epoch revoked.");
          },
          bind: (runId: string, sessionId: string) => {
            bind(captured, runId, sessionId);
          },
        };
      },
    });
    const originalInstructions = instructions.readWorkspaceInstructions,
      originalCompile = graphs.compileEditorGraph,
      originalCommit = db.commit.bind(db);
    const instructionSpy = vi
      .spyOn(instructions, "readWorkspaceInstructions")
      .mockImplementation(async (...args) => {
        const result = await originalInstructions(...args);
        if (stage === "instructions" && prepared) await pause();
        return result;
      });
    const compileSpy = vi
      .spyOn(graphs, "compileEditorGraph")
      .mockImplementation(async (...args) => {
        const result = await originalCompile(...args);
        if (stage === "compile" && prepared) await pause();
        return result;
      });
    const commitSpy = vi.spyOn(db, "commit").mockImplementation(async (run) => {
      if (prepared) {
        commits++;
        if (
          (stage === "prompt-commit" && commits === 1) ||
          (stage === "run-commit" && commits === 2)
        )
          await pause();
      }
      return originalCommit(run);
    });
    try {
      const { session } = (await coding.action("session/start", {
        title: "Prepared epoch fixture",
      })) as { session: { id: string } };
      const pending = coding.action("turn/start", {
        sessionId: session.id,
        text: "STALE-PROMPT",
        modelId: "fixture",
      });
      const rejection = expect(pending).rejects.toThrow();
      await entered;
      parentScopes = {
        model: ["harness.fs.read", "harness.fs.list"],
        tools: ["harness.fs.read", "harness.fs.list"],
      };
      epoch = 2;
      release();
      await rejection;
      expect(bind).not.toHaveBeenCalled();
      if (stage !== "instructions") {
        const nodes = (compileSpy.mock.calls[0]![0] as GraphJsonV1).nodes;
        expect(nodes.find((node) => node.id === "reply")?.config?.toolAllowlist).toEqual([
          "harness.fs.read",
        ]);
        expect(nodes.find((node) => node.id === "use-tools")?.config?.toolAllowlist).toEqual([
          "harness.fs.list",
        ]);
      }
      expect(Number(db.connection().prepare("SELECT count(*) AS n FROM runs").get()?.n)).toBe(0);
      if (stage !== "run-commit")
        expect(JSON.stringify(readConversationMessages(db.connection(), session.id))).not.toContain(
          "STALE-PROMPT",
        );
      prepared = false;
      await coding.action("turn/start", {
        sessionId: session.id,
        text: "CURRENT-EPOCH",
        modelId: "fixture",
      });
      expect(bind).toHaveBeenCalledTimes(1);
      expect(bind.mock.calls[0]?.[0]).toBe(2);
      const freshNodes = (compileSpy.mock.calls.at(-1)![0] as GraphJsonV1).nodes;
      for (const id of ["reply", "use-tools"])
        expect(freshNodes.find((node) => node.id === id)?.config?.toolAllowlist).toEqual([
          "harness.fs.read",
          "harness.fs.list",
        ]);
    } finally {
      release();
      instructionSpy.mockRestore();
      compileSpy.mockRestore();
      commitSpy.mockRestore();
      coding.close();
      await host.dispose();
      db.close();
    }
  },
);
