import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AdapterInvocationContext } from "@zet-harness/plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssistantAccessDenied,
  DURABLE_ASSISTANT_ACCESS_MIGRATION,
} from "./runtime-assistant-access.js";
import {
  createRuntimeAssistantService,
  type RuntimeAssistantHost,
  type RuntimeAssistantService,
} from "./runtime-assistant-service.js";
import { createRuntimeAssistantTools } from "./runtime-assistant-tools.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

/** Real on-disk SQLite and production service/tools; no model or external host calls. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "assistant-security-"));
  const path = join(directory, "state.sqlite");
  let db = new DatabaseSync(path);
  cleanup.push(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    CREATE TABLE conversations(conversation_id TEXT PRIMARY KEY);
    INSERT INTO conversations VALUES('root'),('source'),('child');
  `);
  db.exec(DURABLE_ASSISTANT_ACCESS_MIGRATION.sql);
  const authority = {};
  let service: RuntimeAssistantService;
  const host = {
    read: vi.fn((chatId: string) => Promise.resolve({ chatId, text: "authorized source content" })),
    status: vi.fn(() => Promise.resolve({ status: "idle" })),
    create: vi.fn(() => Promise.resolve("child")),
    delegate: vi.fn(() => Promise.resolve({ runId: "host-run" })),
    control: vi.fn(() => Promise.resolve({ stopped: true })),
    revoke: vi.fn<RuntimeAssistantHost["revoke"]>(),
    invalidateMemory: vi.fn<RuntimeAssistantHost["invalidateMemory"]>(),
  } satisfies RuntimeAssistantHost;
  service = createRuntimeAssistantService(db, host, authority);
  service.createRoot(authority, "root");
  return {
    get db() {
      return db;
    },
    get service() {
      return service;
    },
    authority,
    host,
    signal: new AbortController().signal,
    reopen() {
      db.close();
      db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys=ON");
      service = createRuntimeAssistantService(db, host, authority);
    },
    writeFloors(id: string, epoch: number) {
      for (const chatId of service.revocationChatIds(id))
        service.setContextFloor(id, chatId, epoch, `${chatId}_boundary_${epoch}`);
    },
  };
}

function context(runId: string): AdapterInvocationContext {
  return {
    runId,
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: `${runId}:effect`,
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

describe("assistant security across tool invocation and durable restart", () => {
  it("executes a delegated empty-grant child with child authority, never parent authority", async () => {
    const f = fixture();
    const parent = f.service.connect(f.authority, "root", "source", ["read", "control"]);
    await f.service.createChild(parent, [], f.signal);
    f.service.bindRun("child_run", parent, "child", "delegated");
    f.reopen();

    const run = f.service.bindingForRun("child_run");
    expect(run.binding.actorChatId).toBe("child");
    const tools = createRuntimeAssistantTools(f.service, run.binding);
    await expect(
      tools
        .find((tool) => tool.manifest.id === "harness.assistant.read")!
        .invoke({ chatId: "source" }, context("child_run")),
    ).rejects.toBeInstanceOf(AssistantAccessDenied);
    expect(f.host.read).not.toHaveBeenCalled();
    expect(f.service.snapshot(run.binding).grants.map((grant) => grant.chatId)).toEqual(["child"]);
    await expect(
      f.service.read(f.service.issueBinding("root"), "source", f.signal),
    ).resolves.toMatchObject({
      chatId: "source",
    });
  });

  it("rejects historical parent-bound delegated rows after reopening the database", async () => {
    const f = fixture();
    const parent = f.service.connect(f.authority, "root", "source", ["read", "control"]);
    await f.service.createChild(parent, [], f.signal);
    f.db
      .prepare("INSERT INTO assistant_runs VALUES(?,?,?,?,?,?)")
      .run("legacy_run", "root", "root", "child", parent.epoch, "delegated");
    f.reopen();
    expect(() => f.service.bindingForRun("legacy_run")).toThrow(AssistantAccessDenied);
  });

  it("refuses connected-chat promotion until its incoming grant is explicitly removed", async () => {
    const f = fixture();
    f.service.connect(f.authority, "root", "source", ["read", "control"]);
    expect(() => f.service.createRoot(f.authority, "source")).toThrow(AssistantAccessDenied);
    f.reopen();
    expect(f.db.prepare("SELECT assistant_id FROM assistant_roots").all()).toEqual([
      expect.objectContaining({ assistant_id: "root" }),
    ]);
    f.service.disconnect(f.authority, "root", "source");
    f.service.createRoot(f.authority, "source");
    await expect(
      f.service.read(f.service.issueBinding("root"), "source", f.signal),
    ).rejects.toThrow(AssistantAccessDenied);
    expect(() => f.service.connect(f.authority, "root", "source", ["read"])).toThrow(
      AssistantAccessDenied,
    );
  });

  it("rolls back a partial invalidation, then persists complete revocation and floors across restart", async () => {
    const f = fixture();
    const parent = f.service.connect(f.authority, "root", "source", ["read", "control"]);
    await f.service.createChild(parent, [], f.signal);
    f.service.bindRun("child_run", parent, "child", "delegated");
    const auditCount = f.db.prepare("SELECT count(*) AS n FROM assistant_access_audit").get()!.n;
    f.host.revoke.mockClear();
    f.host.invalidateMemory.mockImplementation((id, epoch) => {
      f.service.setContextFloor(id, "root", epoch, "partial_boundary");
      throw new Error("injected interruption between floor writes");
    });
    expect(() => f.service.disconnect(f.authority, "root", "source")).toThrow(
      "injected interruption",
    );
    f.reopen();

    expect(f.service.issueBinding("root")).toEqual(parent);
    expect(f.service.snapshot(parent).grants.some((grant) => grant.chatId === "source")).toBe(true);
    expect(f.db.prepare("SELECT count(*) AS n FROM assistant_context_floors").get()!.n).toBe(0);
    expect(f.db.prepare("SELECT count(*) AS n FROM assistant_access_audit").get()!.n).toBe(
      auditCount,
    );
    expect(f.host.revoke).not.toHaveBeenCalled();

    f.host.invalidateMemory.mockImplementation((id, epoch) => f.writeFloors(id, epoch));
    const next = f.service.disconnect(f.authority, "root", "source");
    f.reopen();
    expect(f.service.contextFloor(f.service.issueBinding("root"))).toBe(
      `root_boundary_${next.epoch}`,
    );
    expect(f.service.contextFloor(f.service.issueBinding("root", "child"))).toBe(
      `child_boundary_${next.epoch}`,
    );
    expect(() => f.service.bindingForRun("child_run")).toThrow(AssistantAccessDenied);
    await expect(
      f.service.read(f.service.issueBinding("root"), "source", f.signal),
    ).rejects.toThrow(AssistantAccessDenied);
  });

  it("retains revoked grants and context floors if post-commit cancellation fails", () => {
    const f = fixture();
    const parent = f.service.connect(f.authority, "root", "source", ["read", "control"]);
    f.host.invalidateMemory.mockImplementation((id, epoch) => f.writeFloors(id, epoch));
    f.host.revoke.mockImplementation(() => {
      throw new Error("injected host cancellation failure");
    });
    expect(() => f.service.disconnect(f.authority, "root", "source")).toThrow(
      "cancellation failure",
    );
    f.reopen();
    const next = f.service.issueBinding("root");
    expect(next.epoch).toBe(parent.epoch + 1);
    expect(f.service.contextFloor(next)).toBe(`root_boundary_${next.epoch}`);
    expect(f.service.snapshot(next).grants.some((grant) => grant.chatId === "source")).toBe(false);
    expect(() => f.service.snapshot(parent)).toThrow(AssistantAccessDenied);
  });
});
