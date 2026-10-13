import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterInvocationContext, JsonObject } from "@zet-harness/plugin-api";
import { DURABLE_ASSISTANT_ACCESS_MIGRATION } from "./runtime-assistant-access.js";
import { DURABLE_ASSISTANT_TOOL_ACCESS_MIGRATION } from "./runtime-assistant-tool-access.js";
import {
  DURABLE_NATIVE_CHAT_SCOPES_MIGRATION,
  readNativeChatToolScopes,
} from "./runtime-coding-plugin-scopes.js";
import { createRuntimeAssistantService } from "./runtime-assistant-service.js";
import { createRuntimeAssistantTools } from "./runtime-assistant-tools.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const read = { model: ["harness.fs.read"], tools: ["harness.fs.read"] };
function context(runId = "parent-run"): AdapterInvocationContext {
  return {
    runId,
    signal: new AbortController().signal,
    toolScope: ["harness.fs.read"],
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "adapter-routing",
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => 0,
    },
  };
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE conversations(conversation_id TEXT PRIMARY KEY);INSERT INTO conversations VALUES('root'),('target'),('child');",
  );
  db.exec(DURABLE_NATIVE_CHAT_SCOPES_MIGRATION.sql);
  db.exec(DURABLE_ASSISTANT_ACCESS_MIGRATION.sql);
  db.exec(DURABLE_ASSISTANT_TOOL_ACCESS_MIGRATION.sql);
  const user = {};
  const host = {
    read: vi.fn(() => Promise.resolve({ text: "isolated fixture" })),
    status: vi.fn(() => Promise.resolve({ status: "idle" })),
    create: vi.fn(() => Promise.resolve("child")),
    delegate: vi.fn(() => Promise.resolve({ runId: "fake-delegate" })),
    control: vi.fn(() => Promise.resolve({ stopped: true })),
    revoke: vi.fn(),
    invalidateMemory: vi.fn(),
    toolCatalog: () => ["harness.fs.read", "harness.fs.write"],
    parentToolAuthority: vi.fn((_binding, ctx: AdapterInvocationContext) =>
      ctx.runId === "parent-run" && ctx.toolScope?.includes("harness.fs.read")
        ? structuredClone(read)
        : undefined,
    ),
  };
  const service = createRuntimeAssistantService(db, host, user);
  service.createRoot(user, "root");
  service.connect(user, "root", "target", ["read", "control"]);
  const binding = service.setToolAuthority(user, "root", "root", read);
  service.bindRun("parent-run", binding, "root");
  const invoke = (action: string, input: JsonObject, b = binding, ctx = context()) => {
    const tool = createRuntimeAssistantTools(service, b).find(
      (item) => item.manifest.id === `harness.assistant.${action}`,
    );
    if (!tool) throw Error("missing adapter");
    return tool
      .invoke(input, ctx)
      .then((result) => ({ ...result, value: result.value as { result: unknown } }));
  };
  return { db, host, service, binding, invoke };
}

describe("all assistant adapter routes (isolated SQLite, fake host only)", () => {
  it("invokes list/read/status/delegate/control/create with exact connected grants", async () => {
    const f = fixture();
    const listed = await f.invoke("list", {});
    expect(listed.value).toHaveProperty("result");
    expect(f.service.snapshot(f.binding).grants).toContainEqual({
      chatId: "target",
      permissions: ["read", "control"],
    });
    expect((await f.invoke("read", { chatId: "target" })).value).toEqual({
      result: { text: "isolated fixture" },
    });
    expect((await f.invoke("status", { chatId: "target" })).value).toEqual({
      result: { status: "idle" },
    });
    expect(
      (await f.invoke("delegate", { chatId: "target", input: { task: "fixture task" } })).value,
    ).toEqual({ result: { runId: "fake-delegate" } });
    expect(
      (await f.invoke("control", { chatId: "target", input: { action: "stop" } })).value,
    ).toEqual({ result: { stopped: true } });
    const child = await f.invoke("create", {
      grants: [{ chatId: "target", permissions: ["read"] }],
    });
    expect(child.value).toHaveProperty("result.actorChatId", "child");
    expect(f.host.read).toHaveBeenCalledTimes(1);
    expect(f.host.status).toHaveBeenCalledTimes(1);
    expect(f.host.delegate).toHaveBeenCalledWith(
      "target",
      { task: "fixture task" },
      expect.any(AbortSignal),
      f.binding,
    );
    expect(f.host.control).toHaveBeenCalledWith(
      "target",
      { action: "stop" },
      expect.any(AbortSignal),
      f.binding,
    );
    expect(f.host.create).toHaveBeenCalledTimes(1);
    expect(f.service.snapshot(f.service.issueBinding("root", "child")).grants).toContainEqual({
      chatId: "target",
      permissions: ["read"],
    });
  });

  it("invokes tools_request/tools_requests/tools_decide deny and grant as durable restriction effects", async () => {
    const f = fixture();
    await f.invoke("create", { grants: [] });
    const child = f.service.issueBinding("root", "child");
    f.service.bindRun("child-run", child, "child");
    const requested = await f.invoke(
      "tools_request",
      { scopes: read },
      child,
      context("child-run"),
    );
    const request = requested.value.result as {
      id: string;
      parentChatId: string;
      requiresUser: boolean;
    };
    expect(request.parentChatId).toBe("root");
    expect(request.requiresUser).toBe(false);
    expect((await f.invoke("tools_requests", {})).value.result).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    const before = readNativeChatToolScopes(f.db, "child");
    await f.invoke("tools_decide", { requestId: request.id, decision: "deny" });
    expect(readNativeChatToolScopes(f.db, "child")).toEqual(before);
    expect(
      f.service.toolAccessSnapshot(f.binding).requests.find((row) => row.id === request.id)?.status,
    ).toBe("denied");
    const second = await f.invoke("tools_request", { scopes: read }, child, context("child-run"));
    const id = (second.value.result as { id: string }).id;
    const granted = await f.invoke("tools_decide", { requestId: id, decision: "grant" });
    expect(granted.value).toHaveProperty("result.epoch", f.binding.epoch + 1);
    expect(readNativeChatToolScopes(f.db, "child")).toEqual(read);
    expect(f.host.revoke).toHaveBeenLastCalledWith("root", f.binding.epoch + 1);
    expect(f.host.invalidateMemory).toHaveBeenLastCalledWith("root", f.binding.epoch + 1);
    await expect(f.invoke("list", {})).rejects.toThrow();
    expect(f.host.read).not.toHaveBeenCalled();
    expect(f.host.delegate).not.toHaveBeenCalled();
  });

  it("adapter grants reject scopes beyond user ceiling and invocation authority", async () => {
    const f = fixture();
    await f.invoke("create", { grants: [] });
    const child = f.service.issueBinding("root", "child");
    const requested = await f.invoke(
      "tools_request",
      { scopes: { model: ["harness.fs.write"], tools: [] } },
      child,
      context("child-run"),
    );
    const request = requested.value.result as { id: string; requiresUser: boolean };
    expect(request.requiresUser).toBe(true);
    await expect(
      f.invoke("tools_decide", { requestId: request.id, decision: "grant" }),
    ).rejects.toThrow();
    await f.invoke("tools_decide", { requestId: request.id, decision: "deny" });
    const allowed = await f.invoke("tools_request", { scopes: read }, child, context("child-run"));
    await expect(
      f.invoke(
        "tools_decide",
        { requestId: (allowed.value.result as { id: string }).id, decision: "grant" },
        f.binding,
        context("wrong-run"),
      ),
    ).rejects.toThrow();
    expect(
      f.service
        .toolAccessSnapshot(f.binding)
        .requests.find((row) => row.id === (allowed.value.result as { id: string }).id)?.status ===
        "pending",
    ).toBe(true);
    expect(f.host.revoke).toHaveBeenCalledTimes(2); // Fixture-only explicit connection and user ceiling setup.
  });
});
