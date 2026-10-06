import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import type { AdapterInvocationContext } from "@zet-harness/plugin-api";
import { createRuntimeAssistantService } from "./runtime-assistant-service.js";
import { DURABLE_ASSISTANT_ACCESS_MIGRATION } from "./runtime-assistant-access.js";
import { DURABLE_ASSISTANT_TOOL_ACCESS_MIGRATION } from "./runtime-assistant-tool-access.js";
import {
  DURABLE_NATIVE_CHAT_SCOPES_MIGRATION,
  readNativeChatToolScopes,
} from "./runtime-coding-plugin-scopes.js";
function context(): AdapterInvocationContext {
  return {
    runId: "parent-run",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "parent-decision",
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
const read = { model: ["harness.fs.read"], tools: ["harness.fs.read"] },
  write = { model: ["harness.fs.write"], tools: ["harness.fs.write"] };
function fixture(db = new DatabaseSync(":memory:"), initialize = true) {
  if (initialize) {
    db.exec(
      "PRAGMA foreign_keys=ON;CREATE TABLE conversations(conversation_id TEXT PRIMARY KEY);INSERT INTO conversations VALUES('root'),('child'),('sibling'),('grandchild');",
    );
    db.exec(DURABLE_NATIVE_CHAT_SCOPES_MIGRATION.sql);
    db.exec(DURABLE_ASSISTANT_ACCESS_MIGRATION.sql);
    db.exec(DURABLE_ASSISTANT_TOOL_ACCESS_MIGRATION.sql);
  }
  const user = {};
  let next = "child",
    proof = true;
  let authority = { model: ["harness.fs.read"], tools: ["harness.fs.read"] };
  const revoke = vi.fn(),
    invalidateMemory = vi.fn();
  const service = createRuntimeAssistantService(
    db,
    {
      read: () => Promise.resolve({}),
      status: () => Promise.resolve({}),
      create: () => Promise.resolve(next),
      delegate: () => Promise.resolve({}),
      control: () => Promise.resolve({}),
      revoke,
      invalidateMemory,
      toolCatalog: () => [
        "harness.fs.read",
        "harness.fs.write",
        "harness.fs.list",
        "harness.browser.navigate",
      ],
      parentToolAuthority: (_binding, ctx) =>
        proof && ctx.runId === "parent-run" ? structuredClone(authority) : undefined,
    },
    user,
  );
  if (initialize) service.createRoot(user, "root");
  return {
    db,
    user,
    service,
    revoke,
    invalidateMemory,
    setNext: (value: string) => {
      next = value;
    },
    setProof: (value: boolean) => {
      proof = value;
    },
    setAuthority: (value: typeof authority) => {
      authority = value;
    },
  };
}
it("child request routes only direct parent; parent grant needs explicit user ceiling and frozen invocation authority", async () => {
  const f = fixture();
  try {
    await f.service.createChild(f.service.issueBinding("root"), [], new AbortController().signal);
    let b = f.service.issueBinding("root"),
      child = f.service.issueBinding("root", "child");
    const request = f.service.requestTools(child, read, context().signal);
    expect(request.parentChatId).toBe("root");
    expect(request.requiresUser).toBe(true);
    expect(() => f.service.decideTools(b, request.id, "grant", context())).toThrow();
    b = f.service.setToolAuthority(f.user, "root", "root", read);
    expect(() => f.service.decideTools(b, request.id, "grant", context())).toThrow(); // old-epoch request invalid
    child = f.service.issueBinding("root", "child");
    const current = f.service.requestTools(child, read, context().signal);
    f.setProof(false);
    expect(() => f.service.decideTools(b, current.id, "grant", context())).toThrow();
    f.setProof(true);
    const assigned = f.service.decideTools(b, current.id, "grant", context());
    expect(assigned.epoch).toBe(b.epoch + 1);
    expect(readNativeChatToolScopes(f.db, "child")).toEqual(read);
    expect(f.revoke).toHaveBeenLastCalledWith("root", assigned.epoch);
    expect(f.invalidateMemory).toHaveBeenLastCalledWith("root", assigned.epoch);
    expect(() => f.service.snapshot(child)).toThrow();
    expect(() => f.service.decideTools(assigned, current.id, "grant", context())).toThrow();
    expect(
      f.service.toolAccessSnapshot(assigned).requests.find((row) => row.id === current.id)?.status,
    ).toBe("granted");
    expect(
      f.service
        .toolAccessSnapshot(assigned)
        .audit.some((row) => row.action === "child-tools-parent"),
    ).toBe(true);
  } finally {
    f.db.close();
  }
});
it("excess, sensitive, wildcard/null and wrong-parent requests cannot self-escalate; denial preserves restrictions", async () => {
  const f = fixture();
  try {
    let b = f.service.setToolAuthority(f.user, "root", "root", read);
    await f.service.createChild(b, [], context().signal);
    f.setNext("sibling");
    await f.service.createChild(b, [], context().signal);
    const child = f.service.issueBinding("root", "child"),
      sibling = f.service.issueBinding("root", "sibling");
    expect(() =>
      f.service.requestTools(child, { model: null, tools: null }, context().signal),
    ).toThrow();
    expect(() =>
      f.service.requestTools(child, { model: ["*"], tools: ["*"] }, context().signal),
    ).toThrow();
    const request = f.service.requestTools(child, write, context().signal);
    expect(request.requiresUser).toBe(true);
    expect(() => f.service.decideTools(sibling, request.id, "grant", context())).toThrow();
    expect(() => f.service.decideTools(b, request.id, "grant", context())).toThrow();
    const before = readNativeChatToolScopes(f.db, "child");
    f.service.decideTools(b, request.id, "deny", context());
    expect(readNativeChatToolScopes(f.db, "child")).toEqual(before);
    const sensitive = f.service.requestTools(
      child,
      { model: ["harness.browser.navigate"], tools: ["harness.browser.navigate"] },
      context().signal,
    );
    expect(sensitive.requiresUser).toBe(true);
    expect(() =>
      f.service.setToolAuthority(f.user, "root", "root", {
        model: ["harness.browser.navigate"],
        tools: [],
      }),
    ).toThrow();
    expect(() => f.service.decideTools(b, sensitive.id, "grant", context())).toThrow();
    b = f.service.decideToolsUser(f.user, "root", sensitive.id, "grant");
    expect(readNativeChatToolScopes(f.db, "child").model).toEqual(["harness.browser.navigate"]); // restriction only, creates no host capability
    expect(() => f.service.assignChildTools({}, "root", "child", read)).toThrow();
    expect(() => f.service.decideToolsUser(f.user, "root", sensitive.id, "grant")).toThrow();
    expect(b.epoch).toBeGreaterThan(child.epoch);
  } finally {
    f.db.close();
  }
});
it("shrinking parent delegation ceiling revokes parent-issued child rights without reopening them later", async () => {
  const f = fixture();
  try {
    f.setAuthority({
      model: [...read.model, ...write.model],
      tools: [...read.tools, ...write.tools],
    });
    let b = f.service.setToolAuthority(f.user, "root", "root", {
      model: [...read.model, ...write.model],
      tools: [...read.tools, ...write.tools],
    });
    await f.service.createChild(b, [], context().signal);
    const request = f.service.requestTools(
      f.service.issueBinding("root", "child"),
      write,
      context().signal,
    );
    b = f.service.decideTools(b, request.id, "grant", context());
    b = f.service.setToolAuthority(f.user, "root", "root", read);
    expect(readNativeChatToolScopes(f.db, "child")).toEqual({ model: [], tools: [] });
    f.service.setToolAuthority(f.user, "root", "root", {
      model: [...read.model, ...write.model],
      tools: [...read.tools, ...write.tools],
    });
    expect(readNativeChatToolScopes(f.db, "child")).toEqual({ model: [], tools: [] });
    expect(f.revoke).toHaveBeenCalled();
    expect(() => f.service.snapshot(b)).toThrow();
  } finally {
    f.db.close();
  }
});
it("requests, finite authority, decisions and audit survive disk restart while disconnect/cancellation fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-tool-access-"));
  const file = join(directory, "access.sqlite");
  let f = fixture(new DatabaseSync(file));
  try {
    const b = f.service.setToolAuthority(f.user, "root", "root", read);
    await f.service.createChild(b, [], context().signal);
    const request = f.service.requestTools(
      f.service.issueBinding("root", "child"),
      read,
      context().signal,
    );
    f.db.close();
    f = fixture(new DatabaseSync(file), false);
    expect(f.service.pendingToolRequests(f.service.issueBinding("root"))[0]?.id).toBe(request.id);
    const aborted = context();
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      f.service.decideTools(f.service.issueBinding("root"), request.id, "grant", {
        ...aborted,
        signal: controller.signal,
      }),
    ).toThrow();
    f.service.disconnect(f.user, "root", "child");
    expect(() =>
      f.service.decideTools(f.service.issueBinding("root"), request.id, "grant", context()),
    ).toThrow();
    expect(f.service.toolAccessSnapshot(f.service.issueBinding("root")).requests[0]?.status).toBe(
      "stale",
    );
    expect(
      f.service
        .toolAccessSnapshot(f.service.issueBinding("root"))
        .audit.some((row) => row.action === "tools-request"),
    ).toBe(true);
  } finally {
    f.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("failed context invalidation rolls back requested grant, scope, provenance and epoch atomically", async () => {
  const f = fixture();
  try {
    const root = f.service.setToolAuthority(f.user, "root", "root", read);
    await f.service.createChild(root, [], context().signal);
    const request = f.service.requestTools(
      f.service.issueBinding("root", "child"),
      read,
      context().signal,
    );
    const before = readNativeChatToolScopes(f.db, "child"),
      epoch = root.epoch;
    f.invalidateMemory.mockImplementation(() => {
      throw new Error("Cannot invalidate context.");
    });
    expect(() => f.service.decideTools(root, request.id, "grant", context())).toThrow(
      "Cannot invalidate",
    );
    expect(f.service.issueBinding("root").epoch).toBe(epoch);
    expect(readNativeChatToolScopes(f.db, "child")).toEqual(before);
    expect(
      f.db.prepare("SELECT status FROM assistant_tool_requests WHERE request_id=?").get(request.id)
        ?.status,
    ).toBe("pending");
    expect(
      f.db.prepare("SELECT 1 FROM assistant_tool_assignments WHERE child_chat_id='child'").get(),
    ).toBeUndefined();
  } finally {
    f.db.close();
  }
});
it("model request and deny adapters enforce exact schemas and cannot grant without the host proof", async () => {
  const { createRuntimeAssistantTools } = await import("./runtime-assistant-tools.js");
  const f = fixture();
  try {
    const root = f.service.setToolAuthority(f.user, "root", "root", read);
    await f.service.createChild(root, [], context().signal);
    const childTools = createRuntimeAssistantTools(
      f.service,
      f.service.issueBinding("root", "child"),
    );
    const rootTools = createRuntimeAssistantTools(f.service, root);
    const requestTool = childTools.find((tool) => tool.manifest.id.endsWith(".tools_request"))!;
    await expect(
      requestTool.invoke({ scopes: { model: null, tools: null } }, context()),
    ).rejects.toThrow();
    await requestTool.invoke({ scopes: read }, context());
    const request = f.service.pendingToolRequests(root)[0]!;
    const decide = rootTools.find((tool) => tool.manifest.id.endsWith(".tools_decide"))!;
    f.setProof(false);
    await expect(
      decide.invoke({ requestId: request.id, decision: "grant" }, context()),
    ).rejects.toThrow();
    await expect(
      decide.invoke({ requestId: request.id, decision: "deny", unexpected: true }, context()),
    ).rejects.toThrow();
    await decide.invoke({ requestId: request.id, decision: "deny" }, context());
    expect(f.service.pendingToolRequests(root)).toEqual([]);
  } finally {
    f.db.close();
  }
});
