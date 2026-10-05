import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CapabilityPermissionPolicy,
  PluginHost,
  createAgentPlugin,
  createControlFlowPlugin,
} from "@zet-harness/core";
import { SqliteDatabase, SQLITE_MEMORY_PATH, runSqliteMigrations } from "@zet-harness/db";
import { saveModelConfig } from "@zet-harness/db/durable-model-records";
import {
  PLUGIN_API_VERSION,
  type ToolAdapter,
  type ModelAdapter,
  type ModelRequest,
} from "@zet-harness/plugin-api";
import { collectInstalledAgentPluginTools } from "./runtime-agent-plugin-tools.js";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { compileEditorGraph, createRunFromCompiledGraph } from "./runtime-graphs.js";
import { buildWorkflow } from "./runtime-workflows.js";
import { RuntimeCodingService } from "./runtime-coding-service.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";
import { createAgentNodeExecutor } from "./runtime-agent-nodes.js";
import { createPluginNodeExecutor } from "./runtime-plugin-executor.js";
import { RuntimeRunDispatcher } from "./runtime-run-dispatcher.js";
import { createRuntimeMutationTools } from "./runtime-coding-mutation-tools.js";
import { createRuntimeCodingFileTools } from "./runtime-coding-file-tools.js";
import { createRuntimeCodingTools } from "./runtime-coding-tools.js";
interface SessionResult {
  session: { id: string; status: string };
}
interface TurnResult {
  turn: { id: string; status: string };
}
describe("standalone coding service (scripted inference only)", () => {
  it("uses durable graph loop, persists sessions, switches models and isolates workspace scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-coding-"));
    const other = await mkdtemp(join(tmpdir(), "native-coding-other-"));
    const db = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    db.open();
    runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
    const host = new PluginHost();
    await host.activate(createControlFlowPlugin());
    await host.activate(createAgentPlugin());
    const requests: ModelRequest[] = [];
    let pluginCall = false;
    const pluginInvoke = vi.fn(() => Promise.resolve({ value: { fixture: true } }));
    const pluginTool: ToolAdapter = {
      manifest: {
        id: "fixture.plugin.read",
        version: "1",
        title: "Fixture plugin read",
        inputSchema: { type: "object" },
        outputSchema: true,
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
      invoke: pluginInvoke,
    };
    await host.activate({
      manifest: {
        id: "fixture.owner",
        name: "Fixture owner",
        version: "1",
        apiVersion: PLUGIN_API_VERSION,
      },
      activate: (context) => context.tools.register(pluginTool),
    });

    let writeTarget: string | undefined;
    let fileCall:
      | {
          name: string;
          arguments: {
            path: string;
            expectedContent?: string;
            edits?: { oldText: string; newText: string }[];
          };
        }
      | undefined;
    const model: ModelAdapter = {
      manifest: {
        id: "fixture.model",
        version: "1",
        title: "Fixture",
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
        if (
          pluginCall &&
          request.messages.at(-1)?.role === "user" &&
          request.tools?.some((tool) => tool.name === "fixture_plugin_read")
        )
          return Promise.resolve({
            message: {
              role: "assistant",
              parts: [
                { kind: "tool-call", callId: "plugin", name: "fixture_plugin_read", arguments: {} },
              ],
            },
            finishReason: "tool-calls",
          });
        if ((writeTarget || fileCall) && request.messages.at(-1)?.role === "user")
          return Promise.resolve({
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "tool-call",
                  callId: "write",
                  name: fileCall?.name ?? "harness_fs_write",
                  arguments: fileCall?.arguments ?? {
                    path: writeTarget!,
                    content: "approved native edit",
                  },
                },
              ],
            },
            finishReason: "tool-calls",
          });
        return Promise.resolve({
          message: {
            role: "assistant",
            parts: [{ kind: "text", text: "Built-in harness fixture answer" }],
          },
          finishReason: "stop",
        });
      },
    };
    host.models.register(model);
    saveModelConfig(db.connection(), {
      modelId: "fixture.model",
      title: "Fixture",
      profile: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "fixture",
      tools: true,
      contextWindowTokens: 32000,
      nowMs: Date.now(),
    });
    host.models.register({ ...model, manifest: { ...model.manifest, id: "fixture.second" } });
    saveModelConfig(db.connection(), {
      modelId: "fixture.second",
      title: "Second",
      profile: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "second",
      tools: true,
      contextWindowTokens: 32000,
      nowMs: Date.now(),
    });
    const redaction = new RuntimeRedactionRegistry();
    const authority = new CapabilityPermissionPolicy();
    const approvals = new RuntimeHumanApprovals(db, {
      redaction,
      authority,
      onResolved: () => undefined,
    });
    const dispatcher: RuntimeRunDispatcher = new RuntimeRunDispatcher(
      db,
      approvals,
      {
        execute: (execution) => {
          const nativeTools = [
            ...createRuntimeCodingTools({ root }),
            ...(coding.toolPolicy(execution.runId)?.mutationConsent
              ? [
                  ...createRuntimeMutationTools({
                    root,
                    approve: (request, context) => coding.approveTool(request, context),
                  }),
                  ...createRuntimeCodingFileTools({
                    root,
                    approve: (request, context) => coding.approveTool(request, context),
                  }),
                ]
              : []),
          ];
          const installed = collectInstalledAgentPluginTools({
            host,
            allows: () => true,
            approve: (request, context) => coding.approveTool(request, context),
          });
          return createAgentNodeExecutor({
            database: db,
            models: host.models,
            tools: [...nativeTools, ...installed.map((entry) => entry.adapter)],
            toolOwner: (tool) =>
              nativeTools.includes(tool)
                ? "harness.native"
                : installed.find((entry) => entry.adapter === tool)?.owner,
            allows: (cap) =>
              cap === "fs:read" || coding.toolPolicy(execution.runId)?.mutationConsent === true,
            configuredModels: () => new Set(["fixture.model", "fixture.second"]),
            fallback: createPluginNodeExecutor({ host }),
          })(execution);
        },
      },
      redaction,
      authority,
    );
    dispatcher.start();
    let selected = root;
    const revokeRun = vi.fn();
    const services = {
      desktopGeneration: () => 7,
      providerIdentity: () => "fixture-account",
      revokeRun,
      database: db,
      workspace: () => selected,
      toolCatalog: () => [
        {
          id: "fixture.plugin.read",
          title: "Fixture plugin read",
          pluginId: "fixture.owner",
          status: "enabled-host-granted",
        },
        { id: "harness.fs.read", title: "Read", pluginId: "harness", status: "granted" },
      ],
      approvals,
      sources: () => ({ host }),
      capabilityAuthority: () => authority,
      redact: (value: unknown) => redaction.redact(value),
      dispatch: (runId: string) => dispatcher.wake(runId),
      cancel: (runId: string) => dispatcher.cancelRun(runId),
    };
    const coding: RuntimeCodingService = new RuntimeCodingService(services);
    try {
      await writeFile(join(root, "AGENTS.md"), "Use focused native graph tools.");
      const created = (await coding.action("session/start", {
        title: "Native session",
      })) as SessionResult;
      const sessionId = created.session.id;
      expect(await coding.action("session/graph", { sessionId })).toEqual({
        sessionId,
        graphId: null,
        graph: null,
      });
      const turn = (await coding.action("turn/start", {
        sessionId,
        text: "Inspect the project",
        modelId: "fixture.model",
      })) as TurnResult;
      expect(coding.toolPolicy(turn.turn.id)).toMatchObject({
        desktopEnabled: false,
        desktopGeneration: undefined,
        explicitModelSelection: true,
        sessionId,
        modelId: "fixture.model",
      });
      const report = await dispatcher.waitForIdle(turn.turn.id);
      expect(coding.toolPolicy(turn.turn.id)).toBeUndefined();
      expect(revokeRun).toHaveBeenCalledWith(turn.turn.id);
      expect(report.status).toBe("completed");
      expect(requests[0]?.messages[0]).toBeDefined();
      expect(JSON.stringify(requests)).toContain("focused native graph tools");
      expect(requests[0]?.tools?.some((t) => t.name.includes("harness_fs_read"))).toBe(true);
      const read = (await coding.action("session/read", { sessionId })) as {
        messages: { role: string; parts: unknown[] }[];
      };
      expect(read.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(requests[0]?.tools?.some((tool) => tool.name === "fixture_plugin_read")).toBe(true);
      pluginCall = true;
      const pluginTurn = (await coding.action("turn/start", {
        sessionId,
        text: "Use installed read plugin",
        modelId: "fixture.model",
      })) as TurnResult;
      expect((await dispatcher.waitForIdle(pluginTurn.turn.id)).status).toBe("completed");
      expect(pluginInvoke).toHaveBeenCalledTimes(1);
      pluginCall = false;
      const firstGraph = (await coding.action("session/graph", { sessionId })) as {
        graphId: string;
        revisionId: string;
        graph: { nodes: { id: string; config: Record<string, unknown> }[] };
      };
      expect(firstGraph.graphId).toBe(`native-chat:${sessionId}`);
      const separate = (await coding.action("session/start", {
        title: "Separate",
      })) as SessionResult;
      expect(
        await coding.action("session/graph", { sessionId: separate.session.id }),
      ).toMatchObject({ graphId: null });
      expect(await coding.action("session/plugins", { sessionId })).toMatchObject({
        restrictions: { model: null, tools: null },
      });
      for (const modelScope of [
        ["harness_fs_read"],
        ["unknown"],
        ["harness.fs.read", "harness.fs.read"],
      ])
        await expect(
          coding.action("session/plugin-scope", { sessionId, model: modelScope, tools: null }),
        ).rejects.toThrow();
      expect(
        await coding.action("session/plugin-scope", {
          sessionId,
          model: ["harness.fs.read"],
          tools: [],
        }),
      ).toMatchObject({ appliesTo: "next-turn" });
      expect(
        await coding.action("session/plugins", { sessionId: separate.session.id }),
      ).toMatchObject({ restrictions: { model: null, tools: null } });
      const scopeRestart = new RuntimeCodingService(services);
      expect(await scopeRestart.action("session/plugins", { sessionId })).toMatchObject({
        restrictions: { model: ["harness.fs.read"], tools: [] },
      });
      expect(
        ((await coding.action("session/graph", { sessionId })) as typeof firstGraph).revisionId,
      ).toBe(firstGraph.revisionId);
      const switched = (await coding.action("turn/start", {
        sessionId,
        text: "New graph snapshot",
        modelId: "fixture.second",
        instructions: "changed instructions",
        desktopEnabled: true,
      })) as TurnResult;
      expect(coding.toolPolicy(switched.turn.id)).toMatchObject({
        desktopEnabled: true,
        desktopGeneration: 7,
        providerIdentity: "fixture-account",
        modelId: "fixture.second",
        sessionId,
      });
      expect((await dispatcher.waitForIdle(switched.turn.id)).status).toBe("completed");
      const nextGraph = (await coding.action("session/graph", { sessionId })) as typeof firstGraph;
      expect(nextGraph.graphId).toBe(firstGraph.graphId);
      expect(nextGraph.graph.nodes.find((node) => node.id === "reply")?.config.modelId).toBe(
        "fixture.second",
      );
      expect(nextGraph.revisionId).not.toBe(firstGraph.revisionId);
      expect(
        nextGraph.graph.nodes.find((node) => node.id === "reply")?.config.toolAllowlist,
      ).toEqual(["harness.fs.read"]);
      expect(
        nextGraph.graph.nodes.find((node) => node.id === "use-tools")?.config.toolAllowlist,
      ).toEqual([]);
      expect(
        nextGraph.graph.nodes.find((node) => node.id === "reply")?.config.systemPrompt,
      ).toContain("changed instructions");
      await coding.action("session/plugin-scope", { sessionId, model: [], tools: [] });
      const noTools = (await coding.action("turn/start", {
        sessionId,
        text: "No tools",
        modelId: "fixture.model",
      })) as TurnResult;
      expect((await dispatcher.waitForIdle(noTools.turn.id)).status).toBe("completed");
      expect(requests.at(-1)?.tools ?? []).toEqual([]);
      expect(pluginInvoke).toHaveBeenCalledTimes(1);
      const another = (await coding.action("session/start", {
        title: "Native second",
      })) as SessionResult;
      const anotherTurn = (await coding.action("turn/start", {
        sessionId: another.session.id,
        text: "Separate native graph",
        modelId: "fixture.model",
      })) as TurnResult;
      expect((await dispatcher.waitForIdle(anotherTurn.turn.id)).status).toBe("completed");
      expect(await coding.action("session/graph", { sessionId: another.session.id })).toMatchObject(
        { graphId: `native-chat:${another.session.id}` },
      );
      const legacy = await compileEditorGraph(
        buildWorkflow("chat", separate.session.id, { modelId: "fixture.model" }),
        { host },
        authority,
      );
      if (!legacy.valid) throw Error("Legacy fixture failed compilation");
      await createRunFromCompiledGraph(db, legacy.compiled);
      expect(
        await coding.action("session/graph", { sessionId: separate.session.id }),
      ).toMatchObject({ graphId: "chat", revisionId: `1:${separate.session.id}` });
      expect(
        ((await coding.action("session/graph", { sessionId })) as typeof firstGraph).graphId,
      ).toBe(`native-chat:${sessionId}`);
      await coding.action("session/plugin-scope", { sessionId, model: null, tools: null });
      await mkdir(join(root, "apps"), { recursive: true });
      await writeFile(join(root, "apps", "AGENTS.md"), "Nested working-directory instructions.");
      const nested = (await coding.action("turn/start", {
        sessionId,
        text: "Inspect nested project",
        modelId: "fixture.model",
        workingDirectory: "apps",
        skillMode: "catalog",
        skillNames: [],
      })) as TurnResult & { instructions: { sources: string[] } };
      expect((await dispatcher.waitForIdle(nested.turn.id)).status).toBe("completed");
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
        "Nested working-directory instructions.",
      );
      expect(nested.instructions.sources).toContain("apps/AGENTS.md");

      for (const params of [
        { workingDirectory: "../outside" },
        { skillMode: "unsafe" },
        { skillNames: [1] },
      ])
        await expect(
          coding.action("turn/start", {
            sessionId,
            text: "invalid",
            modelId: "fixture.model",
            ...params,
          }),
        ).rejects.toThrow();
      const restarted = new RuntimeCodingService(services);
      expect(
        ((await restarted.action("session/resume", { sessionId })) as SessionResult).session.id,
      ).toBe(sessionId);
      expect(coding.snapshot().activeTurns[sessionId]?.status).toBe("completed");
      if (process.platform === "linux") {
        writeTarget = "edited.txt";
        const editing = (await coding.action("turn/start", {
          sessionId,
          text: "Create the file after approval",
          modelId: "fixture.model",
          mutationConsent: true,
        })) as TurnResult;
        await vi.waitFor(() => expect(coding.snapshot().toolApprovals).toHaveLength(1));
        await expect(readFile(join(root, "edited.txt"), "utf8")).rejects.toThrow();
        const pending = coding.snapshot().toolApprovals[0] as {
          id: string;
          requestGeneration: number;
        };
        await expect(
          coding.action("tool-approval/respond", {
            id: pending.id,
            decision: "approved",
            requestGeneration: pending.requestGeneration - 1,
          }),
        ).rejects.toThrow("expired");
        await coding.action("session/plugin-scope", { sessionId, model: [], tools: [] });
        await coding.action("tool-approval/respond", {
          id: pending.id,
          decision: "approved",
          requestGeneration: pending.requestGeneration,
        });
        expect((await dispatcher.waitForIdle(editing.turn.id)).status).toBe("completed");
        expect(await readFile(join(root, "edited.txt"), "utf8")).toBe("approved native edit");
        await coding.action("session/plugin-scope", { sessionId, model: null, tools: null });
        writeTarget = undefined;
        for (const call of [
          { name: "harness_fs_mkdir", arguments: { path: "created" } },
          {
            name: "harness_fs_apply_patch",
            arguments: {
              path: "edited.txt",
              expectedContent: "approved native edit",
              edits: [{ oldText: "native", newText: "patched" }],
            },
          },
        ]) {
          fileCall = call;
          const operation = (await coding.action("turn/start", {
            sessionId,
            text: "Request exact file operation",
            modelId: "fixture.model",
            mutationConsent: true,
          })) as TurnResult;
          await vi.waitFor(() => expect(coding.snapshot().toolApprovals).toHaveLength(1));
          const decision = coding.snapshot().toolApprovals[0] as {
            id: string;
            requestGeneration: number;
          };
          await coding.action("tool-approval/respond", {
            id: decision.id,
            requestGeneration: decision.requestGeneration,
            decision: "approved",
          });
          expect((await dispatcher.waitForIdle(operation.turn.id)).status).toBe("completed");
        }
        expect(await readFile(join(root, "edited.txt"), "utf8")).toBe("approved patched edit");
        fileCall = undefined;
        writeTarget = "denied.txt";
        const denied = (await coding.action("turn/start", {
          sessionId,
          text: "The provider proposes an unauthorized write",
          modelId: "fixture.model",
        })) as TurnResult;
        await dispatcher.waitForIdle(denied.turn.id);
        expect(coding.snapshot().toolApprovals).toEqual([]);
        await expect(readFile(join(root, "denied.txt"), "utf8")).rejects.toThrow();
        writeTarget = undefined;
      }
      await coding.action("session/archive", { sessionId });
      await expect(
        coding.action("turn/start", { sessionId, text: "again", modelId: "fixture.model" }),
      ).rejects.toThrow("Restore");
      await coding.action("session/restore", { sessionId });
      selected = other;
      expect(coding.snapshot().scopeGeneration).toBe(1);
      expect(coding.snapshot().events).toEqual([]);
      await expect(coding.action("session/read", { sessionId })).rejects.toThrow("outside");
      for (const action of ["session/graph", "session/plugins", "session/plugin-scope"])
        await expect(
          coding.action(action, {
            sessionId,
            ...(action === "session/plugin-scope" ? { model: null, tools: null } : {}),
          }),
        ).rejects.toThrow("outside");
      await expect(
        coding.action("turn/interrupt", { sessionId, turnId: turn.turn.id }),
      ).rejects.toThrow("outside");
      expect(await coding.action("session/list")).toEqual({ data: [] });
    } finally {
      coding.close();
      await dispatcher.stop();
      await host.dispose();
      db.close();
      await rm(root, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });
});
