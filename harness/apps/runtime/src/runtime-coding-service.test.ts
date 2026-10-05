import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import type { ModelAdapter, ModelRequest } from "@zet-harness/plugin-api";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { RuntimeCodingService } from "./runtime-coding-service.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";
import { createAgentNodeExecutor } from "./runtime-agent-nodes.js";
import { createPluginNodeExecutor } from "./runtime-plugin-executor.js";
import { RuntimeRunDispatcher } from "./runtime-run-dispatcher.js";
import { createRuntimeMutationTools } from "./runtime-coding-mutation-tools.js";
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
    let writeTarget: string | undefined;
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
        if (writeTarget && request.messages.at(-1)?.role === "user")
          return Promise.resolve({
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "tool-call",
                  callId: "write",
                  name: "harness_fs_write",
                  arguments: { path: writeTarget, content: "approved native edit" },
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
        execute: (execution) =>
          createAgentNodeExecutor({
            database: db,
            models: host.models,
            tools: [
              ...createRuntimeCodingTools({ root }),
              ...(coding.toolPolicy(execution.runId)?.mutationConsent
                ? createRuntimeMutationTools({
                    root,
                    approve: (request, context) => coding.approveTool(request, context),
                  })
                : []),
            ],
            allows: (cap) =>
              cap === "fs:read" || coding.toolPolicy(execution.runId)?.mutationConsent === true,
            configuredModels: () => new Set(["fixture.model"]),
            fallback: createPluginNodeExecutor({ host }),
          })(execution),
      },
      redaction,
      authority,
    );
    dispatcher.start();
    let selected = root;
    const services = {
      database: db,
      workspace: () => selected,
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
      const turn = (await coding.action("turn/start", {
        sessionId,
        text: "Inspect the project",
        modelId: "fixture.model",
      })) as TurnResult;
      const report = await dispatcher.waitForIdle(turn.turn.id);
      expect(report.status).toBe("completed");
      expect(requests[0]?.messages[0]).toBeDefined();
      expect(JSON.stringify(requests)).toContain("focused native graph tools");
      expect(requests[0]?.tools?.some((t) => t.name.includes("harness_fs_read"))).toBe(true);
      const read = (await coding.action("session/read", { sessionId })) as {
        messages: { role: string; parts: unknown[] }[];
      };
      expect(read.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
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
        await coding.action("tool-approval/respond", {
          id: pending.id,
          decision: "approved",
          requestGeneration: pending.requestGeneration,
        });
        expect((await dispatcher.waitForIdle(editing.turn.id)).status).toBe("completed");
        expect(await readFile(join(root, "edited.txt"), "utf8")).toBe("approved native edit");
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
