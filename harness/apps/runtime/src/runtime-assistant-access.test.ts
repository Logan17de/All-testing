import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createRuntimeAssistantService } from "./runtime-assistant-service.js";
import {
  DURABLE_ASSISTANT_ACCESS_MIGRATION,
  assertAssistantAccess,
  assistantEpoch,
} from "./runtime-assistant-access.js";
it("durable graph epochs and exact permissions survive close/reopen SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "zet-assistant-"));
  const file = join(directory, "graph.sqlite");
  try {
    const db = new DatabaseSync(file);
    db.exec(
      "PRAGMA foreign_keys=ON;CREATE TABLE conversations(conversation_id TEXT PRIMARY KEY);INSERT INTO conversations VALUES('root'),('target');",
    );
    db.exec(DURABLE_ASSISTANT_ACCESS_MIGRATION.sql);
    db.prepare("INSERT INTO assistant_roots VALUES(?,?)").run("root", 3);
    db.prepare("INSERT INTO assistant_actors VALUES(?,?,NULL)").run("root", "root");
    db.prepare("INSERT INTO assistant_edges VALUES(?,?,?,?)").run(
      "root",
      "root",
      "target",
      '["read"]',
    );
    db.prepare("INSERT INTO assistant_runs VALUES(?,?,?,?,?,?)").run(
      "durable_run",
      "root",
      "root",
      "target",
      3,
      "delegated",
    );
    db.close();
    const reopened = new DatabaseSync(file);
    try {
      expect(assistantEpoch(reopened, "root")).toBe(3);
      expect(
        reopened
          .prepare("SELECT epoch,target_chat_id FROM assistant_runs WHERE run_id=?")
          .get("durable_run"),
      ).toEqual({ epoch: 3, target_chat_id: "target" });
      expect(() =>
        assertAssistantAccess(
          reopened,
          { assistantId: "root", actorChatId: "root", epoch: 3 },
          "target",
          "read",
        ),
      ).not.toThrow();
      expect(() =>
        assertAssistantAccess(
          reopened,
          { assistantId: "root", actorChatId: "root", epoch: 2 },
          "target",
          "read",
        ),
      ).toThrow();
      expect(() =>
        assertAssistantAccess(
          reopened,
          { assistantId: "root", actorChatId: "root", epoch: 3 },
          "target",
          "control",
        ),
      ).toThrow();
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("failed transactional invalidation leaves old grant epoch and no new floor after actual restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "zet-assistant-atomic-"));
  const file = join(directory, "graph.sqlite");
  try {
    const db = new DatabaseSync(file);
    db.exec(
      "PRAGMA foreign_keys=ON;CREATE TABLE conversations(conversation_id TEXT PRIMARY KEY);INSERT INTO conversations VALUES('root'),('target');",
    );
    db.exec(DURABLE_ASSISTANT_ACCESS_MIGRATION.sql);
    const authority = {};
    let fail = false;
    const host = {
      read: () => Promise.resolve({}),
      status: () => Promise.resolve({}),
      create: () => Promise.resolve("unused"),
      delegate: () => Promise.resolve({}),
      control: () => Promise.resolve({}),
      revoke: () => {},
      invalidateMemory: (id: string, epoch: number) => {
        service.setContextFloor(id, "root", epoch, "boundary_fixture");
        if (fail) throw new Error("fixture failure");
      },
    };
    const service: ReturnType<typeof createRuntimeAssistantService> = createRuntimeAssistantService(
      db,
      host,
      authority,
    );
    service.createRoot(authority, "root");
    service.connect(authority, "root", "target", ["read", "control"]);
    fail = true;
    expect(() => service.disconnect(authority, "root", "target")).toThrow();
    db.close();
    const reopened = new DatabaseSync(file);
    try {
      expect(assistantEpoch(reopened, "root")).toBe(1);
      expect(() =>
        assertAssistantAccess(
          reopened,
          { assistantId: "root", actorChatId: "root", epoch: 1 },
          "target",
          "read",
        ),
      ).not.toThrow();
      expect(
        reopened.prepare("SELECT count(*) AS n FROM assistant_context_floors WHERE epoch=2").get()
          ?.n,
      ).toBe(0);
      expect(
        reopened
          .prepare("SELECT count(*) AS n FROM assistant_access_audit WHERE action='disconnect'")
          .get()?.n,
      ).toBe(0);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
