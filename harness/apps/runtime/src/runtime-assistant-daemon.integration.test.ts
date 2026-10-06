import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { saveModelConfig } from "@zet-harness/db/durable-model-records";
import {
  appendMessage,
  readConversationMessages,
} from "@zet-harness/db/durable-conversation-records";
import { createSortableId } from "@zet-harness/db/sortable-id";
import type {
  JsonObject,
  ModelRequest,
  ModelResult,
  AdapterInvocationContext,
} from "@zet-harness/plugin-api";
import { RuntimeDaemon } from "./runtime-daemon.js";
it("real daemon scripted inference revocation aborts original signal and excludes disconnected source via actual context floor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-daemon-"));
  const databasePath = join(directory, "runtime.sqlite");
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path: databasePath },
    plugins: { directory: join(directory, "plugins") },
    probePathLimits: false,
  });
  await daemon.start();
  const db = new DatabaseSync(databasePath);
  const api = daemon.snapshot().api,
    base = `http://${api.host}:${String(api.port)}`;
  const requests: ModelRequest[] = [];
  let target = "",
    pendingContext: AdapterInvocationContext | undefined,
    finish!: (result: ModelResult) => void,
    entered!: () => void;
  const pendingStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const answer = (text: string): ModelResult => ({
    message: { role: "assistant", parts: [{ kind: "text", text }] },
    finishReason: "stop",
  });
  daemon.plugins!.models.register({
    manifest: {
      id: "fixture.model",
      version: "1",
      title: "Offline scripted fixture",
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
      requests.push(structuredClone(request));
      if (requests.length === 1)
        return Promise.resolve({
          message: {
            role: "assistant",
            parts: [
              {
                kind: "tool-call",
                callId: "source-read",
                name: "harness_assistant_read",
                arguments: { chatId: target },
              },
            ],
          },
          finishReason: "tool-calls",
        });
      if (requests.length === 2) {
        pendingContext = context;
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return Promise.resolve(answer("CURRENT-SAFE-ANSWER"));
    },
  });
  saveModelConfig(db, {
    modelId: "fixture.model",
    title: "Offline fixture",
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
    const post = async (path: string, action: string, params: Record<string, unknown>) => {
      const response = await fetch(`${base}/api/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zet-csrf": csrfToken },
        body: JSON.stringify({ action, params }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { result: Record<string, unknown> };
    };
    const targetCreated = await post("agent", "session/start", { title: "Source fixture" });
    target = (targetCreated.result.session as { id: string }).id;
    appendMessage(db, {
      messageId: createSortableId(),
      conversationId: target,
      role: "user",
      parts: [{ kind: "text", text: "CONNECTED-SOURCE-PRIVATE-CONTENT" }],
      nowMs: Date.now(),
    });
    const created = await post("assistant", "create", {});
    const root = (created.result.binding as { assistantId: string }).assistantId;
    await post("assistant", "connect", {
      assistantId: root,
      chatId: target,
      permissions: ["read"],
      confirm: true,
    });
    const started = await post("agent", "turn/start", {
      sessionId: root,
      text: "Read the authorized source",
      modelId: "fixture.model",
    });
    const turnId = (started.result.turn as { id: string }).id;
    await Promise.race([
      pendingStarted,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Scripted second inference was not reached.")),
          5000,
        );
        timer.unref();
      }),
    ]);
    expect(
      requests[0]?.tools?.filter((tool) => tool.name.startsWith("harness_assistant_")).length,
    ).toBe(9);
    expect(JSON.stringify(requests[1])).toContain("CONNECTED-SOURCE-PRIVATE-CONTENT");
    await post("assistant", "disconnect", { assistantId: root, chatId: target });
    expect(pendingContext?.signal.aborted).toBe(true);
    finish(answer("LATE-REVOKED-ANSWER"));
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = db.prepare("SELECT status FROM runs WHERE run_id=?").get(turnId);
      if (["completed", "failed", "cancelled"].includes(String(row?.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(JSON.stringify(readConversationMessages(db, root))).not.toContain("LATE-REVOKED-ANSWER");
    await post("agent", "turn/start", {
      sessionId: root,
      text: "New isolated task after disconnect",
      modelId: "fixture.model",
    });
    for (let attempt = 0; attempt < 100 && requests.length < 3; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(requests[2])).not.toContain("CONNECTED-SOURCE-PRIVATE-CONTENT");
    expect(JSON.stringify(requests[2])).not.toContain("source-read");
    expect(JSON.stringify(requests[2])).toContain("New isolated task after disconnect");
  } finally {
    finish?.(answer("cleanup"));
    await daemon.stop();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")(
  "production delegated coding child denies chat/DB side channels and writes only after current exact human approval",
  async () => {
    const { readFile, access } = await import("node:fs/promises");
    const { writeSetting } = await import("@zet-harness/db/durable-setting-records");
    const directory = await mkdtemp(join(tmpdir(), "assistant-coding-daemon-"));
    const databasePath = join(directory, "private-state.sqlite");
    const daemon = new RuntimeDaemon({
      api: { port: 0 },
      database: { path: relative(process.cwd(), databasePath) },
      plugins: { directory: join(directory, "plugins") },
      probePathLimits: false,
    });
    await daemon.start();
    const db = new DatabaseSync(databasePath);
    writeSetting(db, "workspace.root", directory, Date.now());
    const api = daemon.snapshot().api,
      base = `http://${api.host}:${String(api.port)}`;
    let root = "",
      child = "",
      source = "",
      fresh = false;
    const requests = new Map<string, ModelRequest[]>();
    const answer = (): ModelResult => ({
      message: { role: "assistant", parts: [{ kind: "text", text: "fixture finished" }] },
      finishReason: "stop",
    });
    const calls = (
      items: {
        id: string;
        name: string;
        args: Record<string, string> | { chatId: string; input: { text: string } };
      }[],
    ): ModelResult => ({
      message: {
        role: "assistant",
        parts: items.map((item) => ({
          kind: "tool-call" as const,
          callId: item.id,
          name: item.name,
          arguments: item.args,
        })),
      },
      finishReason: "tool-calls",
    });
    daemon.plugins!.models.register({
      manifest: {
        id: "fixture.model",
        version: "1",
        title: "Offline coding delegate",
        requiredCapabilities: [],
        features: {
          streaming: false,
          tools: true,
          vision: false,
          structuredOutput: false,
          contextWindowTokens: 32000,
        },
      },
      generate: (request, ctx) => {
        const history = requests.get(ctx.runId) ?? [];
        history.push(structuredClone(request));
        requests.set(ctx.runId, history);
        const actor = db
          .prepare("SELECT target_chat_id FROM assistant_runs WHERE run_id=?")
          .get(ctx.runId)?.target_chat_id;
        if (actor === root)
          return Promise.resolve(
            history.length === 1
              ? calls([
                  {
                    id: "delegate",
                    name: "harness_assistant_delegate",
                    args: { chatId: child, input: { text: "Bounded fixture coding task" } },
                  },
                ])
              : answer(),
          );
        if (fresh)
          return Promise.resolve(
            history.length === 1
              ? calls([
                  {
                    id: "fresh-write",
                    name: "harness_fs_write",
                    args: { path: "approved.txt", content: "exact approved fixture" },
                  },
                ])
              : answer(),
          );
        if (history.length === 1)
          return Promise.resolve(
            calls([
              {
                id: "unauthorized-source",
                name: "harness_assistant_read",
                args: { chatId: source },
              },
            ]),
          );
        if (history.length === 2)
          return Promise.resolve(
            calls(
              ["private-state.sqlite", "private-state.sqlite-wal", "private-state.sqlite-shm"].map(
                (path, index) => ({
                  id: `private-${index}`,
                  name: "harness_fs_read",
                  args: { path },
                }),
              ),
            ),
          );
        if (history.length === 3)
          return Promise.resolve(
            calls(
              ["private-state.sqlite", "private-state.sqlite-wal", "private-state.sqlite-shm"].map(
                (path, index) => ({
                  id: `private-write-${index}`,
                  name: "harness_fs_write",
                  args: { path, content: "forbidden state mutation" },
                }),
              ),
            ),
          );
        if (history.length === 4)
          return Promise.resolve(
            calls([
              {
                id: "cancelled-write",
                name: "harness_fs_write",
                args: { path: "cancelled.txt", content: "must not write" },
              },
            ]),
          );
        return Promise.resolve(answer());
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
      const post = async (path: string, action: string, params: Record<string, unknown>) => {
        const response = await fetch(`${base}/api/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-zet-csrf": csrfToken },
          body: JSON.stringify({ action, params }),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as { result: Record<string, unknown> };
      };
      source = (
        (await post("agent", "session/start", { title: "Not inherited source" })).result
          .session as { id: string }
      ).id;
      appendMessage(db, {
        messageId: createSortableId(),
        conversationId: source,
        role: "user",
        parts: [{ kind: "text", text: "UNINHERITED-PRIVATE-SOURCE" }],
        nowMs: Date.now(),
      });
      root = ((await post("assistant", "create", {})).result.binding as { assistantId: string })
        .assistantId;
      await post("assistant", "connect", {
        assistantId: root,
        chatId: source,
        permissions: ["read"],
        confirm: true,
      });
      child = String(
        (
          await post("assistant", "child/create", {
            assistantId: root,
            title: "Coding child",
            grants: [],
          })
        ).result.chatId,
      );
      await post("agent", "turn/start", {
        sessionId: root,
        text: "Delegate the fixture task",
        modelId: "fixture.model",
        mutationConsent: true,
      });
      type Approval = {
        id: string;
        sessionId: string;
        runId: string;
        tool: string;
        args: Record<string, unknown>;
        requestGeneration: number;
      };
      const waitApproval = async () => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const state = (await (await fetch(`${base}/api/agent`)).json()) as {
            toolApprovals: Approval[];
          };
          const pending = state.toolApprovals.find((item) => item.sessionId === child);
          if (pending) return pending;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Expected coding child approval was not reached.");
      };
      const pending = await waitApproval();
      expect(pending.tool).toBe("harness.fs.write");
      expect(pending.args.path).toBe("cancelled.txt");
      const approvals = (await (await fetch(`${base}/api/agent`)).json()) as {
        toolApprovals: { args: Record<string, unknown> }[];
      };
      expect(
        approvals.toolApprovals.some((item) =>
          String(item.args.path).startsWith("private-state.sqlite"),
        ),
      ).toBe(false);
      const childRun = db
        .prepare("SELECT actor_chat_id,origin FROM assistant_runs WHERE run_id=?")
        .get(pending.runId);
      expect(childRun?.actor_chat_id).toBe(child);
      expect(childRun?.origin).toBe("delegated");
      const childRequests = requests.get(pending.runId)!;
      expect(childRequests[0]?.tools?.some((tool) => tool.name === "harness_fs_write")).toBe(true);
      expect(JSON.stringify(childRequests)).not.toContain("UNINHERITED-PRIVATE-SOURCE");
      const messageParts = readConversationMessages(db, child).flatMap((message) => message.parts);
      for (const callId of [
        "unauthorized-source",
        "private-0",
        "private-1",
        "private-2",
        "private-write-0",
        "private-write-1",
        "private-write-2",
      ]) {
        const result = messageParts.find(
          (part) => part.kind === "tool-result" && part.callId === callId,
        );
        expect(result?.kind === "tool-result" && result.isError).toBe(true);
      }
      await expect(access(join(directory, "cancelled.txt"))).rejects.toThrow();
      await post("assistant", "disconnect", { assistantId: root, chatId: child });
      await expect(access(join(directory, "cancelled.txt"))).rejects.toThrow();
      const stale = await fetch(`${base}/api/agent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zet-csrf": csrfToken },
        body: JSON.stringify({
          action: "tool-approval/respond",
          params: {
            id: pending.id,
            requestGeneration: pending.requestGeneration,
            decision: "approved",
          },
        }),
      });
      expect(stale.status).toBe(400);
      await post("assistant", "connect", {
        assistantId: root,
        chatId: child,
        permissions: ["read", "control"],
        confirm: true,
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = db
          .prepare("SELECT status FROM runs WHERE run_id=?")
          .get(pending.runId)?.status;
        if (["completed", "failed", "cancelled"].includes(String(status))) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      fresh = true;
      await post("agent", "turn/start", {
        sessionId: child,
        text: "Write the explicitly approved fixture",
        modelId: "fixture.model",
        mutationConsent: true,
      });
      const approved = await waitApproval();
      expect(approved.args).toMatchObject({
        path: "approved.txt",
        content: "exact approved fixture",
      });
      await expect(access(join(directory, "approved.txt"))).rejects.toThrow();
      await post("agent", "tool-approval/respond", {
        id: approved.id,
        requestGeneration: approved.requestGeneration,
        decision: "approved",
      });
      let content: string | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          content = await readFile(join(directory, "approved.txt"), "utf8");
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(content).toBe("exact approved fixture");
      await expect(access(join(directory, "cancelled.txt"))).rejects.toThrow();
    } finally {
      await daemon.stop();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(["interrupt", "revoked"] as const)(
  "explicitly connected ordinary native chat %s requires current exact authority",
  async (controlMode) => {
    const { writeSetting } = await import("@zet-harness/db/durable-setting-records");
    const directory = await mkdtemp(join(tmpdir(), "assistant-control-daemon-"));
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
    let root = "",
      target = "",
      other = "",
      targetRun = "",
      otherRun = "",
      forgedRun = "";
    const ordinary = new Map<
      string,
      { context: AdapterInvocationContext; finish: (result: ModelResult) => void }
    >();
    const rootRequests: ModelRequest[] = [];
    let releaseControl: ((result: ModelResult) => void) | undefined;
    let rootPendingContext: AdapterInvocationContext | undefined;
    const answer = (): ModelResult => ({
      message: { role: "assistant", parts: [{ kind: "text", text: "control fixture done" }] },
      finishReason: "stop",
    });
    const tool = (callId: string, name: string, args: Record<string, unknown>): ModelResult => ({
      message: {
        role: "assistant",
        parts: [{ kind: "tool-call", callId, name, arguments: args as JsonObject }],
      },
      finishReason: "tool-calls",
    });
    daemon.plugins!.models.register({
      manifest: {
        id: "fixture.model",
        version: "1",
        title: "Scripted ordinary control",
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
        const actor = db
          .prepare("SELECT target_chat_id FROM assistant_runs WHERE run_id=?")
          .get(context.runId)?.target_chat_id;
        if (actor !== root)
          return new Promise((resolve) =>
            ordinary.set(context.runId, { context, finish: resolve }),
          );
        rootRequests.push(structuredClone(request));
        if (rootRequests.length === 1)
          return Promise.resolve(
            tool("ordinary-status", "harness_assistant_status", { chatId: target }),
          );
        if (rootRequests.length === 2)
          return Promise.resolve(
            tool("wrong-session", "harness_assistant_control", {
              chatId: target,
              input: { action: "interrupt", turnId: otherRun },
            }),
          );
        if (rootRequests.length === 3)
          return Promise.resolve(
            tool("ungranted-target", "harness_assistant_control", {
              chatId: other,
              input: { action: "interrupt", turnId: otherRun },
            }),
          );
        if (rootRequests.length === 4)
          return Promise.resolve(
            tool("spoofed-graph", "harness_assistant_control", {
              chatId: target,
              input: { action: "interrupt", turnId: forgedRun },
            }),
          );
        if (rootRequests.length === 5) {
          if (controlMode === "revoked") {
            rootPendingContext = context;
            return new Promise((resolve) => {
              releaseControl = resolve;
            });
          }
          return Promise.resolve(
            tool("ordinary-interrupt", "harness_assistant_control", {
              chatId: target,
              input: { action: "interrupt", turnId: targetRun },
            }),
          );
        }
        return Promise.resolve(answer());
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
      const post = async (path: string, action: string, params: Record<string, unknown>) => {
        const response = await fetch(`${base}/api/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-zet-csrf": csrfToken },
          body: JSON.stringify({ action, params }),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as { result: Record<string, unknown> };
      };
      target = (
        (await post("agent", "session/start", { title: "Connected ordinary native chat" })).result
          .session as { id: string }
      ).id;
      other = (
        (await post("agent", "session/start", { title: "Unconnected ordinary native chat" })).result
          .session as { id: string }
      ).id;
      targetRun = (
        (
          await post("agent", "turn/start", {
            sessionId: target,
            text: "Paused target inference",
            modelId: "fixture.model",
          })
        ).result.turn as { id: string }
      ).id;
      otherRun = (
        (
          await post("agent", "turn/start", {
            sessionId: other,
            text: "Paused unrelated inference",
            modelId: "fixture.model",
          })
        ).result.turn as { id: string }
      ).id;
      for (let i = 0; i < 200 && !ordinary.has(targetRun); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ordinary.has(targetRun)).toBe(true);
      const { buildWorkflow } = await import("./runtime-workflows.js");
      const forgedGraph = {
        ...buildWorkflow("chat", other, { modelId: "fixture.model" }),
        graphId: `native-chat:${target}`,
        revisionId: `1:${target}`,
      };
      const genericResponse = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zet-csrf": csrfToken },
        body: JSON.stringify({ graph: forgedGraph }),
      });
      expect(genericResponse.status).toBe(201);
      forgedRun = ((await genericResponse.json()) as { runId: string }).runId;
      expect(
        db.prepare("SELECT 1 FROM native_chat_runs WHERE run_id=?").get(forgedRun),
      ).toBeUndefined();
      for (const action of ["turn/read", "turn/interrupt"]) {
        const denied = await fetch(`${base}/api/agent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-zet-csrf": csrfToken },
          body: JSON.stringify({ action, params: { sessionId: target, turnId: forgedRun } }),
        });
        expect(denied.status).toBe(400);
      }
      const linked = await post("agent", "session/graph", { sessionId: target });
      expect(linked.result.runId).toBe(targetRun);
      const readTurn = await post("agent", "turn/read", { sessionId: target, turnId: targetRun });
      expect((readTurn.result.turn as { runId: string }).runId).toBe(targetRun);
      root = ((await post("assistant", "create", {})).result.binding as { assistantId: string })
        .assistantId;
      await post("assistant", "connect", {
        assistantId: root,
        chatId: target,
        permissions: ["read", "control"],
        confirm: true,
      });
      const rootRun = (
        (
          await post("agent", "turn/start", {
            sessionId: root,
            text: "Review and interrupt only the connected target",
            modelId: "fixture.model",
          })
        ).result.turn as { id: string }
      ).id;
      if (controlMode === "revoked") {
        for (let i = 0; i < 200 && !releaseControl; i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(releaseControl).toBeDefined();
        await post("assistant", "disconnect", { assistantId: root, chatId: target });
        expect(rootPendingContext?.signal.aborted).toBe(true);
        releaseControl!(
          tool("ordinary-interrupt", "harness_assistant_control", {
            chatId: target,
            input: { action: "interrupt", turnId: targetRun },
          }),
        );
      }
      for (let i = 0; i < 200; i++) {
        if (
          ["completed", "failed", "cancelled"].includes(
            String(db.prepare("SELECT status FROM runs WHERE run_id=?").get(rootRun)?.status),
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const parts = readConversationMessages(db, root).flatMap((message) => message.parts);
      const status = parts.find(
        (part) => part.kind === "tool-result" && part.callId === "ordinary-status",
      );
      expect(status?.kind === "tool-result" ? JSON.stringify(status.value) : "").toContain(
        targetRun,
      );
      expect(status?.kind === "tool-result" ? JSON.stringify(status.value) : "").not.toContain(
        forgedRun,
      );
      for (const id of ["wrong-session", "ungranted-target", "spoofed-graph"]) {
        const result = parts.find((part) => part.kind === "tool-result" && part.callId === id);
        expect(result?.kind === "tool-result" && result.isError).toBe(true);
      }
      const controlled = parts.find(
        (part) => part.kind === "tool-result" && part.callId === "ordinary-interrupt",
      );
      if (controlMode === "revoked") expect(controlled).toBeUndefined();
      else {
        expect(controlled?.kind).toBe("tool-result");
        expect(controlled?.kind === "tool-result" && controlled.isError).not.toBe(true);
      }
      expect(ordinary.get(targetRun)?.context.signal.aborted).toBe(controlMode === "interrupt");
      expect(
        String(db.prepare("SELECT status FROM runs WHERE run_id=?").get(otherRun)?.status),
      ).not.toBe("cancelled");
    } finally {
      releaseControl?.(answer());
      for (const pending of ordinary.values()) pending.finish(answer());
      await daemon.stop();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(!["linux", "win32"].includes(process.platform))(
  "actual parent tool decision grants only explicit user-delegated rights for a fresh child turn",
  async () => {
    const { writeSetting } = await import("@zet-harness/db/durable-setting-records");
    const directory = await mkdtemp(join(tmpdir(), "assistant-delegated-tools-")),
      databasePath = join(directory, "runtime.sqlite");
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
    let root = "",
      child = "",
      requestId = "";
    const counts = new Map<string, number>();
    const observed = new Map<string, ModelRequest>();
    const scopes = { model: ["harness.fs.read"], tools: ["harness.fs.read"] };
    const answer = (): ModelResult => ({
      message: { role: "assistant", parts: [{ kind: "text", text: "fixture request complete" }] },
      finishReason: "stop",
    });
    daemon.plugins!.models.register({
      manifest: {
        id: "fixture.model",
        version: "1",
        title: "Delegation decision fixture",
        requiredCapabilities: [],
        features: {
          streaming: false,
          tools: true,
          vision: false,
          structuredOutput: false,
          contextWindowTokens: 32000,
        },
      },
      generate: (_request, context) => {
        observed.set(context.runId, structuredClone(_request));
        const n = (counts.get(context.runId) ?? 0) + 1;
        counts.set(context.runId, n);
        const actor = db
          .prepare("SELECT actor_chat_id FROM assistant_runs WHERE run_id=?")
          .get(context.runId)?.actor_chat_id;
        if (
          n !== 1 ||
          (actor === child &&
            !_request.tools?.some((tool) => tool.name === "harness_assistant_tools_request"))
        )
          return Promise.resolve(answer());
        return Promise.resolve({
          message: {
            role: "assistant",
            parts: [
              actor === child
                ? {
                    kind: "tool-call",
                    callId: "request-tools",
                    name: "harness_assistant_tools_request",
                    arguments: { scopes },
                  }
                : {
                    kind: "tool-call",
                    callId: "grant-tools",
                    name: "harness_assistant_tools_decide",
                    arguments: { requestId, decision: "grant" },
                  },
            ],
          },
          finishReason: "tool-calls",
        });
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
      const raw = (action: string, params: Record<string, unknown>, token = csrfToken) =>
        fetch(`${base}/api/assistant`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-zet-csrf": token },
          body: JSON.stringify({ action, params }),
        });
      const post = async (path: string, action: string, params: Record<string, unknown>) => {
        const response = await fetch(`${base}/api/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-zet-csrf": csrfToken },
          body: JSON.stringify({ action, params }),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as { result: Record<string, unknown> };
      };
      root = ((await post("assistant", "create", {})).result.binding as { assistantId: string })
        .assistantId;
      let epoch = Number(
        (await post("assistant", "tools/read", { assistantId: root })).result.epoch,
      );
      expect(
        (
          await raw(
            "tools/authority",
            { assistantId: root, actorChatId: root, scopes, epoch, confirm: true },
            "",
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await raw("tools/authority", {
            assistantId: root,
            actorChatId: root,
            scopes,
            epoch,
            confirm: false,
          })
        ).status,
      ).toBe(400);
      const ceiling = await post("assistant", "tools/authority", {
        assistantId: root,
        actorChatId: root,
        scopes,
        epoch,
        confirm: true,
      });
      epoch = Number(ceiling.result.epoch);
      expect(
        (
          await raw("tools/authority", {
            assistantId: root,
            actorChatId: root,
            scopes,
            epoch: epoch - 1,
            confirm: true,
          })
        ).status,
      ).toBe(400);
      child = String(
        (await post("assistant", "child/create", { assistantId: root, grants: [] })).result.chatId,
      );
      const childRun = (
        (
          await post("agent", "turn/start", {
            sessionId: child,
            text: "Ask parent for read tool access",
            modelId: "fixture.model",
          })
        ).result.turn as { id: string }
      ).id;
      for (let i = 0; i < 200; i++) {
        const row = db
          .prepare(
            "SELECT request_id FROM assistant_tool_requests WHERE child_chat_id=? AND status='pending'",
          )
          .get(child);
        if (row) {
          requestId = String(row.request_id);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(requestId).not.toBe("");
      const queue = await post("assistant", "tools/read", { assistantId: root });
      expect(
        (queue.result.requests as { id: string; requiresUser: boolean }[]).find(
          (item) => item.id === requestId,
        )?.requiresUser,
      ).toBe(false);
      for (let i = 0; i < 200; i++) {
        if (
          ["completed", "failed", "cancelled"].includes(
            String(db.prepare("SELECT status FROM runs WHERE run_id=?").get(childRun)?.status),
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await post("agent", "turn/start", {
        sessionId: root,
        text: "Review and grant the bounded pending child request",
        modelId: "fixture.model",
      });
      for (let i = 0; i < 200; i++) {
        if (
          db.prepare("SELECT status FROM assistant_tool_requests WHERE request_id=?").get(requestId)
            ?.status === "granted"
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(
        db.prepare("SELECT status FROM assistant_tool_requests WHERE request_id=?").get(requestId)
          ?.status,
      ).toBe("granted");
      const current = await post("assistant", "tools/read", { assistantId: root });
      expect(Number(current.result.epoch)).toBeGreaterThan(epoch);
      expect(
        (current.result.actors as { chatId: string; scopes: unknown }[]).find(
          (actor) => actor.chatId === child,
        )?.scopes,
      ).toEqual(scopes);
      expect(
        (current.result.audit as { action: string }[]).some(
          (entry) => entry.action === "child-tools-parent",
        ),
      ).toBe(true);
      const freshChild = (
        (
          await post("agent", "turn/start", {
            sessionId: child,
            text: "Use only the freshly assigned read tool",
            modelId: "fixture.model",
          })
        ).result.turn as { id: string }
      ).id;
      for (let i = 0; i < 200 && !observed.has(freshChild); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(observed.get(freshChild)?.tools?.map((tool) => tool.name)).toEqual([
        "harness_fs_read",
      ]);
      expect(
        (
          await raw("tools/decide", {
            assistantId: root,
            requestId,
            decision: "grant",
            confirm: true,
            epoch,
          })
        ).status,
      ).toBe(400);
    } finally {
      await daemon.stop();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
