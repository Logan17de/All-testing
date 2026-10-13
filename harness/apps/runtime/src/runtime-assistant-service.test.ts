import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DURABLE_ASSISTANT_ACCESS_MIGRATION,
  AssistantAccessDenied,
} from "./runtime-assistant-access.js";
import { createRuntimeAssistantService } from "./runtime-assistant-service.js";
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
export function assistantFixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE conversations(conversation_id TEXT PRIMARY KEY);INSERT INTO conversations VALUES('root'),('existing'),('other'),('child');",
  );
  db.exec(DURABLE_ASSISTANT_ACCESS_MIGRATION.sql);
  const authority = {};
  const host = {
    read: vi.fn(() => Promise.resolve({ text: "linked-only" })),
    status: vi.fn(() => Promise.resolve({ status: "idle" })),
    create: vi.fn(() => Promise.resolve("child")),
    delegate: vi.fn(() => Promise.resolve({ runId: "run" })),
    control: vi.fn(() => Promise.resolve({ stopped: true })),
    revoke: vi.fn(),
    invalidateMemory: vi.fn(),
  };
  const service = createRuntimeAssistantService(db, host, authority);
  service.createRoot(authority, "root");
  return { db, authority, host, service, signal: new AbortController().signal };
}
describe("durable assistant authority (host fixtures; no model/provider calls)", () => {
  it("defaults existing chats denied and only explicit user identity connects", async () => {
    const f = assistantFixture();
    const b = f.service.issueBinding("root");
    await expect(f.service.read(b, "existing", f.signal)).rejects.toBeInstanceOf(
      AssistantAccessDenied,
    );
    expect(() => f.service.connect({}, "root", "existing", ["read"])).toThrow();
    const next = f.service.connect(f.authority, "root", "existing", ["read"]);
    await expect(f.service.read(next, "existing", f.signal)).resolves.toEqual({
      text: "linked-only",
    });
    await expect(f.service.control(next, "existing", {}, f.signal)).rejects.toThrow();
    expect(() => f.service.snapshot(b)).toThrow();
    expect(f.db.prepare("SELECT count(*) AS n FROM assistant_access_audit").get()?.n).toBe(3);
  });
  it("revokes pending retrieval and invalidates all old graph bindings", async () => {
    const f = assistantFixture();
    const b = f.service.connect(f.authority, "root", "existing", ["read", "control"]);
    let release!: (v: { text: string }) => void;
    f.host.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.service.read(b, "existing", f.signal);
    f.service.disconnect(f.authority, "root", "existing");
    release({ text: "must-not-return" });
    await expect(pending).rejects.toThrow();
    expect(f.host.revoke).toHaveBeenLastCalledWith("root", 2);
    expect(f.host.invalidateMemory).toHaveBeenLastCalledWith("root", 2);
  });
  it("created children inherit exact subset and creator can read/control created chat", async () => {
    const f = assistantFixture();
    const b = f.service.connect(f.authority, "root", "existing", ["read"]);
    await expect(
      f.service.createChild(b, [{ chatId: "other", permissions: ["read"] }], f.signal),
    ).rejects.toThrow();
    expect(f.host.create).not.toHaveBeenCalled();
    const child = await f.service.createChild(
      b,
      [{ chatId: "existing", permissions: ["read"] }],
      f.signal,
    );
    await expect(f.service.read(child, "existing", f.signal)).resolves.toBeDefined();
    await expect(f.service.control(child, "existing", {}, f.signal)).rejects.toThrow();
    await expect(f.service.control(b, "child", {}, f.signal)).resolves.toBeDefined();
    expect(f.service.actorChatIds("root")).toEqual(["child", "root"]);
    f.service.disconnect(f.authority, "root", "child");
    expect(() => f.service.issueBinding("root", "child")).toThrow();
    const reconnected = f.service.connect(f.authority, "root", "child", ["read", "control"]);
    await expect(f.service.read(reconnected, "child", f.signal)).resolves.toBeDefined();
    const resumedChild = f.service.issueBinding("root", "child");
    await expect(f.service.read(resumedChild, "existing", f.signal)).rejects.toThrow();
    f.service.bindRun("resumed_child", resumedChild, "child");
    expect(f.service.assertRunAccess("resumed_child").targetChatId).toBe("child");
  });
  it("rejects aliases, self edges and connected assistant cycles", () => {
    const f = assistantFixture();
    expect(() => f.service.connect(f.authority, "root", "../existing", ["read"])).toThrow();
    expect(() => f.service.connect(f.authority, "root", "root", ["read"])).toThrow();
    f.service.createRoot(f.authority, "other");
    expect(() => f.service.connect(f.authority, "root", "other", ["read"])).toThrow();
  });
  it("reducing root grants clamps inherited child permissions without re-expansion", async () => {
    const f = assistantFixture();
    const root = f.service.connect(f.authority, "root", "existing", ["read", "control"]);
    await f.service.createChild(
      root,
      [{ chatId: "existing", permissions: ["read", "control"] }],
      f.signal,
    );
    f.service.connect(f.authority, "root", "existing", ["read"]);
    const child = f.service.issueBinding("root", "child");
    await expect(f.service.control(child, "existing", {}, f.signal)).rejects.toThrow();
    await expect(f.service.read(child, "existing", f.signal)).resolves.toBeDefined();
    f.service.connect(f.authority, "root", "existing", ["read", "control"]);
    await expect(
      f.service.control(f.service.issueBinding("root", "child"), "existing", {}, f.signal),
    ).rejects.toThrow();
  });
  it("durable run binding rejects revoked epochs and context floors are epoch-specific", () => {
    const f = assistantFixture();
    const b = f.service.connect(f.authority, "root", "existing", ["read", "control"]);
    f.service.bindRun("run_bound", b, "existing", "user");
    expect(f.service.assertRunAccess("run_bound").targetChatId).toBe("existing");
    f.service.setContextFloor("root", "root", b.epoch, "message_boundary");
    expect(f.service.contextFloor(b)).toBe("message_boundary");
    const next = f.service.disconnect(f.authority, "root", "existing");
    expect(() => f.service.assertRunAccess("run_bound")).toThrow();
    expect(f.service.contextFloor(next)).toBeNull();
  });
  it("preserves structural root access and refuses cross-graph actor reassignment", async () => {
    const f = assistantFixture();
    const root = f.service.issueBinding("root");
    expect(() => f.service.disconnect(f.authority, "root", "root")).toThrow();
    expect(f.service.issueBinding("root")).toEqual(root);
    await expect(f.service.read(root, "root", f.signal)).resolves.toBeDefined();
    await f.service.createChild(root, [], f.signal);
    expect(() => f.service.createRoot(f.authority, "child")).toThrow();
    expect(f.db.prepare("SELECT count(*) AS n FROM assistant_roots").get()?.n).toBe(1);
    expect(f.service.issueBinding("root", "child").assistantId).toBe("root");
  });
  it("refuses copied ancestor authority before child creation and permits read-only context floors", async () => {
    const f = assistantFixture();
    const root = f.service.connect(f.authority, "root", "existing", ["read"]);
    await expect(
      f.service.createChild(root, [{ chatId: "root", permissions: ["read"] }], f.signal),
    ).rejects.toThrow();
    expect(f.host.create).not.toHaveBeenCalled();
    expect(f.service.contextFloor(root, "existing")).toBeNull();
  });
  it("attenuates delegated child runs and refuses delegation to ordinary connected chats", async () => {
    const f = assistantFixture();
    const parent = f.service.connect(f.authority, "root", "existing", ["read", "control"]);
    await f.service.createChild(parent, [{ chatId: "existing", permissions: ["read"] }], f.signal);
    expect(() => f.service.bindRun("bad_delegate", parent, "existing", "delegated")).toThrow();
    f.service.bindRun("child_delegate", parent, "child", "delegated");
    const delegated = f.service.bindingForRun("child_delegate");
    expect(delegated.binding.actorChatId).toBe("child");
    await expect(f.service.control(delegated.binding, "existing", {}, f.signal)).rejects.toThrow();
  });
  it("rejects converting an incoming connected target to a new root", () => {
    const f = assistantFixture();
    f.service.connect(f.authority, "root", "existing", ["read"]);
    expect(() => f.service.createRoot(f.authority, "existing")).toThrow();
    expect(f.db.prepare("SELECT count(*) AS n FROM assistant_roots").get()?.n).toBe(1);
  });
  it("rolls back grant epoch audit and context floors when invalidation fails", () => {
    const f = assistantFixture();
    const before = f.service.connect(f.authority, "root", "existing", ["read", "control"]);
    f.host.revoke.mockClear();
    f.host.invalidateMemory.mockImplementation(() => {
      f.service.setContextFloor("root", "root", before.epoch + 1, "new_boundary");
      throw new Error("fixture floor failure");
    });
    expect(() => f.service.disconnect(f.authority, "root", "existing")).toThrow(
      "fixture floor failure",
    );
    expect(f.service.issueBinding("root")).toEqual(before);
    expect(f.service.snapshot(before).grants.some((g) => g.chatId === "existing")).toBe(true);
    expect(f.db.prepare("SELECT count(*) AS n FROM assistant_context_floors").get()?.n).toBe(0);
    expect(f.host.revoke).not.toHaveBeenCalled();
  });
});
