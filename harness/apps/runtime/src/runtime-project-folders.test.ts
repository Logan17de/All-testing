import { describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PluginHost,
  CapabilityPermissionPolicy,
  createAgentPlugin,
  createControlFlowPlugin,
} from "@zet-harness/core";
import { SqliteDatabase, SQLITE_MEMORY_PATH, runSqliteMigrations } from "@zet-harness/db";
import { createProject, updateProject } from "@zet-harness/db/durable-project-records";
import { writeSetting } from "@zet-harness/db/durable-setting-records";
import { createSortableId } from "@zet-harness/db/sortable-id";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { RuntimeCodingService } from "./runtime-coding-service.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";

describe("trusted project folders for coding chats (no native execution)", () => {
  it("uses each stored folder, lists all chats, and keeps historical reads after default changes", async () => {
    const folderA = await realpath(await mkdtemp(join(tmpdir(), "chat-folder-a-")));
    const folderB = await realpath(await mkdtemp(join(tmpdir(), "chat-folder-b-")));
    const db = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    db.open();
    runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
    const host = new PluginHost();
    await host.activate(createAgentPlugin());
    await host.activate(createControlFlowPlugin());
    host.models.register({
      manifest: {
        id: "fixture.model",
        version: "1",
        title: "Fixture",
        requiredCapabilities: [],
        features: {
          contextWindowTokens: 8192,
          streaming: false,
          tools: false,
          vision: false,
          structuredOutput: false,
        },
      },
      generate: () =>
        Promise.resolve({
          message: { role: "assistant", parts: [{ kind: "text", text: "fixture" }] },
          finishReason: "stop",
        }),
    });
    let selected: string | undefined = folderA;
    const service = new RuntimeCodingService({
      database: db,
      workspace: () => selected,
      workspaceTrusted: () => true,
      approvals: new RuntimeHumanApprovals(db, {
        redaction: new RuntimeRedactionRegistry(),
        authority: new CapabilityPermissionPolicy(),
        onResolved: () => undefined,
      }),
      cancel: () => Promise.resolve(),
      dispatch: undefined,
      redact: (value) => value,
      sources: () => ({ host }),
      isModelConfigured: () => true,
      capabilityAuthority: () => new CapabilityPermissionPolicy(),
    });
    try {
      const project = createProject(db.connection(), {
        projectId: createSortableId(),
        name: "Other folder",
        workspacePath: folderB,
        nowMs: 1,
      });
      writeSetting(db.connection(), `project.trusted.${project.projectId}`, folderB, 1);
      const created = (await service.action("session/start", { projectId: project.projectId })) as {
        session: { id: string; projectId: string };
      };
      const defaultChat = (await service.action("session/start", {})) as {
        session: { id: string; projectId: string };
      };
      expect(created.session.projectId).toBe(project.projectId);
      const turn = (await service.action("turn/start", {
        sessionId: created.session.id,
        text: "Use project folder",
        modelId: "fixture.model",
      })) as { turn: { id: string } };
      expect(service.toolPolicy(turn.turn.id)?.root).toBe(folderB);
      const list = (await service.action("session/list", {})) as { data: { id: string }[] };
      expect(list.data.map((entry) => entry.id)).toEqual(
        expect.arrayContaining([created.session.id, defaultChat.session.id]),
      );
      const newer = Date.now() + 10_000;
      db.connection()
        .prepare("UPDATE conversations SET updated_at_ms=? WHERE conversation_id=?")
        .run(newer, defaultChat.session.id);
      const recent = (await service.action("session/list", {})) as {
        data: { id: string; updatedAt: number }[];
      };
      expect(recent.data.map((entry) => entry.id)).toEqual([
        defaultChat.session.id,
        created.session.id,
      ]);
      expect(recent.data[0]?.updatedAt).toBe(newer);
      db.connection()
        .prepare("UPDATE conversations SET updated_at_ms=? WHERE conversation_id=?")
        .run(newer, created.session.id);
      const tied = (await service.action("session/list", {})) as { data: { id: string }[] };
      expect(tied.data.map((entry) => entry.id)).toEqual(
        [created.session.id, defaultChat.session.id].sort().reverse(),
      );
      updateProject(db.connection(), project.projectId, { workspacePath: folderA, nowMs: 2 });
      writeSetting(db.connection(), `project.trusted.${project.projectId}`, folderA, 2);
      expect(service.toolPolicy(turn.turn.id)).toBeUndefined();
      selected = undefined;
      expect(
        await service.action("session/read", { sessionId: created.session.id }),
      ).toHaveProperty("session.id", created.session.id);
      await expect(service.action("session/start", {})).rejects.toThrow("default folder");
      await service.drainCancellations();
    } finally {
      service.close();
      await service.drainCancellations();
      await host.dispose();
      db.close();
      await rm(folderA, { recursive: true, force: true });
      await rm(folderB, { recursive: true, force: true });
    }
  });
  it("does not trust an old project merely because its path was saved", async () => {
    const db = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    db.open();
    runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
    const service = new RuntimeCodingService({
      database: db,
      workspace: () => undefined,
      workspaceTrusted: () => false,
      approvals: new RuntimeHumanApprovals(db, {
        redaction: new RuntimeRedactionRegistry(),
        authority: new CapabilityPermissionPolicy(),
        onResolved: () => undefined,
      }),
      cancel: () => Promise.resolve(),
      dispatch: undefined,
      redact: (value) => value,
      sources: () => ({}),
      capabilityAuthority: () => new CapabilityPermissionPolicy(),
    });
    try {
      const project = createProject(db.connection(), {
        projectId: createSortableId(),
        name: "Old",
        workspacePath: await realpath(tmpdir()),
        nowMs: 1,
      });
      await expect(
        service.action("session/start", { projectId: project.projectId }),
      ).rejects.toThrow("trust");
      await expect(service.action("session/start", {})).rejects.toThrow("default folder");
    } finally {
      service.close();
      db.close();
    }
  });
});
