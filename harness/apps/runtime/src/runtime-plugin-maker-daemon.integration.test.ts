import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { saveModelConfig } from "@zet-harness/db/durable-model-records";
import { writeSetting } from "@zet-harness/db/durable-setting-records";
import { readConversationMessages } from "@zet-harness/db/durable-conversation-records";
import type { ModelRequest, ModelResult, AdapterInvocationContext } from "@zet-harness/plugin-api";
import { RuntimeDaemon } from "./runtime-daemon.js";
import { createRuntimePluginMaker } from "./runtime-plugin-maker.js";
it("real daemon native plugin maker is quarantined, excludes assistant actors and rejects stale workspace inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "maker-daemon-")),
    nextWorkspace = await mkdtemp(join(tmpdir(), "maker-next-"));
  const databasePath = join(directory, "runtime.sqlite");
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path: databasePath },
    plugins: { directory: join(directory, "plugins") },
    probePathLimits: false,
  });
  await daemon.start();
  const db = new DatabaseSync(databasePath);
  writeSetting(db, "workspace.root", directory, Date.now());
  const api = daemon.snapshot().api,
    base = `http://${api.host}:${String(api.port)}`;
  let ordinary = "",
    root = "",
    child = "",
    phase: "scaffold" | "assistant" | "stale" = "scaffold";
  const requests = new Map<string, ModelRequest[]>();
  let pendingContext: AdapterInvocationContext | undefined,
    finish: ((result: ModelResult) => void) | undefined;
  const answer = (): ModelResult => ({
    message: { role: "assistant", parts: [{ kind: "text", text: "maker fixture done" }] },
    finishReason: "stop",
  });
  const scaffold = (stale = false): ModelResult => ({
    message: {
      role: "assistant",
      parts: [
        {
          kind: "tool-call",
          callId: stale ? "stale-maker" : "maker",
          name: "harness_plugin-maker_scaffold",
          arguments: {
            id: stale ? "fixture.stale" : "fixture.draft",
            name: stale ? "Stale" : "Draft",
          },
        },
      ],
    },
    finishReason: "tool-calls",
  });
  daemon.plugins!.models.register({
    manifest: {
      id: "fixture.model",
      version: "1",
      title: "Offline maker fixture",
      requiredCapabilities: [],
      features: {
        streaming: false,
        tools: true,
        vision: false,
        structuredOutput: false,
        contextWindowTokens: 32000,
      },
    },
    generate: (request, context) => {
      const history = requests.get(context.runId) ?? [];
      history.push(structuredClone(request));
      requests.set(context.runId, history);
      if (phase === "stale") {
        pendingContext = context;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return Promise.resolve(phase === "scaffold" && history.length === 1 ? scaffold() : answer());
    },
  });
  saveModelConfig(db, {
    modelId: "fixture.model",
    title: "Fixture",
    profile: "custom",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
    tools: true,
    contextWindowTokens: 32000,
    nowMs: Date.now(),
  });
  try {
    const { csrfToken } = (await (await fetch(`${base}/api/session`)).json()) as {
      csrfToken: string;
    };
    const raw = (path: string, action: string, params: Record<string, unknown>) =>
      fetch(`${base}/api/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zet-csrf": csrfToken },
        body: JSON.stringify({ action, params }),
      });
    const post = async (path: string, action: string, params: Record<string, unknown>) => {
      const response = await raw(path, action, params);
      expect(response.status).toBe(200);
      return (await response.json()) as { result: Record<string, unknown> };
    };
    const waitTerminal = async (runId: string) => {
      for (let i = 0; i < 200; i++) {
        if (
          ["completed", "failed", "cancelled"].includes(
            String(db.prepare("SELECT status FROM runs WHERE run_id=?").get(runId)?.status),
          )
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Fixture turn did not finish.");
    };
    ordinary = (
      (await post("agent", "session/start", { title: "Maker fixture" })).result.session as {
        id: string;
      }
    ).id;
    const ordinaryRun = (
      (
        await post("agent", "turn/start", {
          sessionId: ordinary,
          text: "Propose a quarantined native plugin",
          modelId: "fixture.model",
        })
      ).result.turn as { id: string }
    ).id;
    await waitTerminal(ordinaryRun);
    expect(
      requests
        .get(ordinaryRun)?.[0]
        ?.tools?.filter((tool) => tool.name.startsWith("harness_plugin-maker_")).length,
    ).toBe(5);
    const result = readConversationMessages(db, ordinary)
      .flatMap((message) => message.parts)
      .find((part) => part.kind === "tool-result" && part.callId === "maker");
    expect(result?.kind).toBe("tool-result");
    const artifact = (result?.kind === "tool-result" ? result.value : null) as {
      result: { hash: string; files: unknown[] };
    };
    expect(artifact.result.hash).toMatch(/^[a-f0-9]{64}$/);
    const inspected = await post("plugin-maker", "inspect", { hash: artifact.result.hash });
    expect(inspected.result.hash).toBe(artifact.result.hash);
    expect((await readdir(directory)).some((name) => name.includes("draft"))).toBe(false);
    phase = "assistant";
    root = ((await post("assistant", "create", {})).result.binding as { assistantId: string })
      .assistantId;
    child = String(
      (await post("assistant", "child/create", { assistantId: root, grants: [] })).result.chatId,
    );
    for (const sessionId of [root, child]) {
      const runId = (
        (
          await post("agent", "turn/start", {
            sessionId,
            text: "Review available tools",
            modelId: "fixture.model",
          })
        ).result.turn as { id: string }
      ).id;
      await waitTerminal(runId);
      expect(
        requests
          .get(runId)?.[0]
          ?.tools?.some((tool) => tool.name.startsWith("harness_plugin-maker_")),
      ).toBe(false);
    }
    phase = "stale";
    const staleRun = (
      (
        await post("agent", "turn/start", {
          sessionId: ordinary,
          text: "Pause before proposing an old-workspace artifact",
          modelId: "fixture.model",
        })
      ).result.turn as { id: string }
    ).id;
    for (let i = 0; i < 200 && !finish; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finish).toBeDefined();
    expect(pendingContext?.signal.aborted).toBe(false);
    // Change the durable workspace without polling the daemon first: its invocation guard must observe revocation itself.
    writeSetting(db, "workspace.root", nextWorkspace, Date.now());
    finish!(scaffold(true));
    await waitTerminal(staleRun);
    const staleHash = createRuntimePluginMaker({ write: () => Promise.resolve() }, {}).scaffold({
      id: "fixture.stale",
      name: "Stale",
    }).hash;
    expect((await raw("plugin-maker", "inspect", { hash: staleHash })).status).toBe(400);
    expect((await raw("plugin-maker", "inspect", { hash: artifact.result.hash })).status).toBe(400);
    expect(await (await fetch(`${base}/api/plugin-maker`)).json()).toMatchObject({
      artifact: null,
      enabled: false,
    });
    expect(await readdir(nextWorkspace)).toEqual([]);
  } finally {
    finish?.(answer());
    await daemon.stop();
    db.close();
    await rm(directory, { recursive: true, force: true });
    await rm(nextWorkspace, { recursive: true, force: true });
  }
});
