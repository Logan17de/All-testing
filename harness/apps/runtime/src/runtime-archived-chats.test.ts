import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginHost } from "@zet-harness/core";
import { SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { createSortableId } from "@zet-harness/db/sortable-id";
import { createProject } from "@zet-harness/db/durable-project-records";
import {
  appendMessage,
  archiveConversation,
  createConversation,
  readConversation,
  restoreConversation,
} from "@zet-harness/db/durable-conversation-records";
import { createGoal } from "@zet-harness/db/durable-goal-records";
import { RUNTIME_DATABASE_MIGRATIONS, RuntimeDaemon } from "./runtime-daemon.js";
import { RuntimeCodingService } from "./runtime-coding-service.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import {
  archivedRetentionCutoff,
  deleteArchivedChat,
  readArchivedRetentionDays,
  writeArchivedRetentionDays,
} from "./runtime-archived-chats.js";

const DAY_MS = 86_400_000;
const fixtures: { db: SqliteDatabase; service: RuntimeCodingService }[] = [];
function fixture(path = ":memory:") {
  const db = new SqliteDatabase({ path });
  db.open();
  runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
  const service = new RuntimeCodingService({
    database: db,
    workspace: () => undefined,
    sources: () => ({ host: new PluginHost() }),
    capabilityAuthority: () => ({ evaluate: () => ({ decision: "allow" as const }) }),
    redact: (value) => value,
    dispatch: undefined,
    cancel: async () => {},
    approvals: new RuntimeHumanApprovals(db),
  });
  fixtures.push({ db, service });
  return { db, service };
}
function chat(db: DatabaseSync, title = "Fixture") {
  const project = createProject(db, { projectId: createSortableId(), name: title, nowMs: 1 });
  return createConversation(db, {
    conversationId: createSortableId(),
    projectId: project.projectId,
    title,
    nowMs: 1,
  });
}
function run(
  db: DatabaseSync,
  sessionId: string,
  status = "completed",
  graphId = `native-chat:${sessionId}`,
) {
  const runId = createSortableId();
  const hash = createSortableId();
  const semantic = createSortableId();
  db.prepare(
    "INSERT INTO graph_sources(document_hash,semantic_hash,hash_algorithm,graph_id,revision_id,normalized_document_json,canonical_semantics_json,created_at_ms) VALUES(?,?,'sha256',?,?,?,'{}',1)",
  ).run(
    hash,
    semantic,
    graphId,
    runId,
    JSON.stringify({
      config: { conversationId: sessionId },
      instructions: "private chat instructions",
    }),
  );
  const inserted = db
    .prepare(
      "INSERT INTO compiled_plans(semantic_hash,registry_hash,compiler_version,hash_algorithm,ir_hash,execution_ir_json,node_pins_json,plugin_pins_json,created_at_ms) VALUES(?,'registry','1','sha256','ir','{}','[]','[]',1)",
    )
    .run(semantic);
  const planId = Number(inserted.lastInsertRowid);
  db.prepare("INSERT INTO graph_compilations VALUES(?,?,?,1)").run(hash, planId, semantic);
  db.prepare(
    "INSERT INTO runs(run_id,document_hash,compiled_plan_id,status,created_at_ms) VALUES(?,?,?,?,1)",
  ).run(runId, hash, planId, status);
  db.prepare("INSERT INTO native_chat_runs VALUES(?,?)").run(runId, sessionId);
  return { runId, hash, planId };
}
afterEach(async () => {
  vi.useRealTimers();
  for (const { db, service } of fixtures.splice(0)) {
    service.stopArchiveMaintenance();
    service.close();
    await db.drainWrites();
    db.close();
  }
});

describe("archived chat retention and permanent deletion", () => {
  it("defaults to never, validates all inputs, and fails closed for a corrupt saved policy", async () => {
    const { db, service } = fixture();
    expect(await service.action("session/retention/read")).toEqual({ retention: { days: -1 } });
    for (const days of [0, -2, 1.5, "30", NaN, Infinity, undefined, Number.MAX_SAFE_INTEGER + 1])
      await expect(service.action("session/retention/update", { days })).rejects.toThrow(
        "positive whole",
      );
    expect(
      await service.action("session/retention/update", { days: Number.MAX_SAFE_INTEGER }),
    ).toEqual({ retention: { days: Number.MAX_SAFE_INTEGER }, deletedCount: 0 });
    expect(archivedRetentionCutoff(Number.MAX_SAFE_INTEGER, Date.now())).toBeUndefined();
    db.connection().prepare("UPDATE app_settings SET value_json='0'").run();
    expect(readArchivedRetentionDays(db.connection())).toBe(-1);
    await expect(
      service.action("session/retention/update", { days: 2, unexpected: true }),
    ).rejects.toThrow("Unsupported");
  });

  it("uses archive age, restores safely, and starts a fresh age after rearchiving", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100 * DAY_MS);
    const { db, service } = fixture();
    const old = chat(db.connection(), "Old archive");
    const recent = chat(db.connection(), "Recent archive");
    const restored = chat(db.connection(), "Restored");
    const neverArchived = chat(db.connection(), "Active");
    archiveConversation(db.connection(), old.conversationId, 80 * DAY_MS);
    archiveConversation(db.connection(), old.conversationId, 99 * DAY_MS);
    expect(readConversation(db.connection(), old.conversationId)?.archivedAtMs).toBe(80 * DAY_MS);
    archiveConversation(db.connection(), recent.conversationId, 99 * DAY_MS);
    archiveConversation(db.connection(), restored.conversationId, 80 * DAY_MS);
    restoreConversation(db.connection(), restored.conversationId, 98 * DAY_MS);
    expect(readConversation(db.connection(), restored.conversationId)?.archivedAtMs).toBeNull();
    archiveConversation(db.connection(), restored.conversationId, 100 * DAY_MS);
    expect(await service.purgeArchivedSessions()).toEqual({ deletedCount: 0 });
    expect(await service.action("session/retention/update", { days: 10 })).toEqual({
      retention: { days: 10 },
      deletedCount: 1,
    });
    expect(readConversation(db.connection(), old.conversationId)).toBeUndefined();
    for (const id of [recent.conversationId, restored.conversationId, neverArchived.conversationId])
      expect(readConversation(db.connection(), id)).toBeDefined();
    vi.setSystemTime(110 * DAY_MS);
    expect(await service.purgeArchivedSessions()).toEqual({ deletedCount: 2 });
    expect(readConversation(db.connection(), neverArchived.conversationId)).toBeDefined();
  });

  it("purges during startup and periodically, and disabling the policy stops automatic deletion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100 * DAY_MS);
    const { db, service } = fixture();
    const old = chat(db.connection());
    archiveConversation(db.connection(), old.conversationId, 80 * DAY_MS);
    writeArchivedRetentionDays(db.connection(), 10);
    await service.startArchiveMaintenance();
    expect(readConversation(db.connection(), old.conversationId)).toBeUndefined();
    const next = chat(db.connection());
    archiveConversation(db.connection(), next.conversationId, 100 * DAY_MS - 10 * DAY_MS + 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readConversation(db.connection(), next.conversationId)).toBeUndefined();
    await service.action("session/retention/update", { days: -1 });
    const kept = chat(db.connection());
    archiveConversation(db.connection(), kept.conversationId, 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readConversation(db.connection(), kept.conversationId)).toBeDefined();
  });

  it("persists the policy across a real file reopen and runtime startup", async () => {
    const folder = await mkdtemp(join(tmpdir(), "archived-chats-"));
    const path = join(folder, "isolated.sqlite");
    const first = fixture(path);
    const saved = chat(first.db.connection());
    archiveConversation(first.db.connection(), saved.conversationId, 1);
    writeArchivedRetentionDays(first.db.connection(), 1);
    first.service.close();
    first.db.close();
    const daemon = new RuntimeDaemon({
      database: { path },
      api: { host: "127.0.0.1", port: 0 },
      probePathLimits: false,
    });
    try {
      await daemon.start();
      const inspect = new SqliteDatabase({ path });
      inspect.open();
      try {
        expect(readArchivedRetentionDays(inspect.connection())).toBe(1);
        expect(readConversation(inspect.connection(), saved.conversationId)).toBeUndefined();
      } finally {
        inspect.close();
      }
    } finally {
      await daemon.stop();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("keeps HTTP deletion and retention behind the existing CSRF and origin checks", async () => {
    const folder = await mkdtemp(join(tmpdir(), "archived-http-"));
    const path = join(folder, "isolated.sqlite");
    const first = fixture(path);
    const session = chat(first.db.connection());
    archiveConversation(first.db.connection(), session.conversationId, 1);
    first.service.close();
    first.db.close();
    const daemon = new RuntimeDaemon({
      database: { path },
      api: { host: "127.0.0.1", port: 0 },
      probePathLimits: false,
    });
    try {
      await daemon.start();
      const base = `http://127.0.0.1:${daemon.snapshot().api.port}`;
      const tokenResponse = await fetch(`${base}/api/session`);
      const token = ((await tokenResponse.json()) as { csrfToken: string }).csrfToken;
      const deletion = { action: "session/delete", params: { sessionId: session.conversationId } };
      for (const body of [deletion, { action: "session/retention/update", params: { days: 1 } }]) {
        expect(
          (
            await fetch(`${base}/api/agent`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await fetch(`${base}/api/agent`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-zet-csrf": token,
                origin: "https://untrusted.example",
              },
              body: JSON.stringify(body),
            })
          ).status,
        ).toBe(403);
      }
      const read = await fetch(`${base}/api/agent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zet-csrf": token },
        body: JSON.stringify({ action: "session/retention/read" }),
      });
      expect(await read.json()).toEqual({ result: { retention: { days: -1 } } });
      const removed = await fetch(`${base}/api/agent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zet-csrf": token },
        body: JSON.stringify(deletion),
      });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({
        result: { deleted: true, sessionId: session.conversationId },
      });
      const invalid = await fetch(`${base}/api/agent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zet-csrf": token },
        body: JSON.stringify({ action: "session/retention/update", params: { days: 0 } }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_ARCHIVED_RETENTION" } });
    } finally {
      await daemon.stop();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("deletes every saved branch and execution dependency while preserving unrelated project data", async () => {
    const { db, service } = fixture();
    const connection = db.connection();
    const session = chat(connection);
    const other = chat(connection, "Other project");
    const owned = run(connection, session.conversationId);
    const surviving = run(connection, other.conversationId);
    connection
      .prepare("UPDATE runs SET parent_run_id=?,fork_metadata_json='{}' WHERE run_id=?")
      .run(owned.runId, surviving.runId);
    const parentId = "ffffffff-ffff-7fff-bfff-ffffffffffff";
    const parent = appendMessage(connection, {
      messageId: parentId,
      conversationId: session.conversationId,
      role: "user",
      parts: [{ kind: "text", text: "Secret question" }],
      nowMs: 2,
    });
    for (let index = 0; index < 2; index++)
      appendMessage(connection, {
        messageId: createSortableId(),
        conversationId: session.conversationId,
        parentMessageId: parent.messageId,
        role: "assistant",
        parts: [{ kind: "text", text: "Secret answer" }],
        runId: owned.runId,
        nowMs: 3,
      });
    connection
      .prepare("INSERT INTO agent_steps VALUES(?, ?,0,0,'model',?,?,'{}',NULL,3)")
      .run("effect", owned.runId, session.conversationId, parent.messageId);
    connection
      .prepare(
        "INSERT INTO conversation_summaries(summary_id,conversation_id,through_message_id,summary,message_count,run_id,created_at_ms) VALUES(?,?,?,'Secret summary',1,?,3)",
      )
      .run(createSortableId(), session.conversationId, parent.messageId, owned.runId);
    connection.prepare("INSERT INTO node_invocations VALUES(?,0,0,'effect',1)").run(owned.runId);
    connection
      .prepare(
        "INSERT INTO node_attempts(run_id,op_index,iteration,attempt,logical_effect_id,status,input_refs_json,output_refs_json,started_at_ms,finished_at_ms) VALUES(?,0,0,1,'effect','completed','{}','{}',1,2)",
      )
      .run(owned.runId);
    const event = connection
      .prepare(
        "INSERT INTO durable_events(run_id,event_type,event_schema_version,occurred_at_ms,payload_json) VALUES(?,'fixture',1,2,'{}')",
      )
      .run(owned.runId);
    const checkpoint = connection
      .prepare(
        "INSERT INTO run_checkpoints(run_id,through_event_id,checkpoint_schema_version,created_at_ms) VALUES(?,?,1,2)",
      )
      .run(owned.runId, Number(event.lastInsertRowid));
    const checkpointId = Number(checkpoint.lastInsertRowid);
    connection
      .prepare(
        "INSERT INTO checkpoint_op_frontier(checkpoint_id,op_index,iteration,status,remaining_dependencies,attempts_started,attempt_budget_used) VALUES(?,0,0,'completed',0,1,1)",
      )
      .run(checkpointId);
    connection
      .prepare("INSERT INTO checkpoint_control_edges VALUES(?,0,0,'completed')")
      .run(checkpointId);
    connection
      .prepare("INSERT INTO checkpoint_router_selections VALUES(?,0,0,'main')")
      .run(checkpointId);
    connection
      .prepare(
        "INSERT INTO approvals(approval_id,run_id,compiled_plan_id,op_index,iteration,logical_effect_id,checkpoint_id,status,request_json,resume_token_hash,created_at_ms) VALUES('approval',?,?,0,0,'effect',?,'pending','{}',?,1)",
      )
      .run(owned.runId, owned.planId, checkpointId, "a".repeat(64));
    connection
      .prepare(
        "INSERT INTO file_changes(run_id,op_index,iteration,logical_effect_id,attempt,workspace_path,change_kind,after_sha256,bytes_written,recorded_at_ms) VALUES(?,0,0,'effect',1,'keep.txt','created',?,1,2)",
      )
      .run(owned.runId, "a".repeat(64));
    const goal = createGoal(connection, {
      goalId: createSortableId(),
      projectId: session.projectId,
      conversationId: session.conversationId,
      title: "Keep project goal",
      nowMs: 1,
    });
    connection
      .prepare(
        "INSERT INTO project_memories(memory_id,project_id,kind,title,body,pinned,source,source_run_id,created_at_ms,updated_at_ms) VALUES(?,?,'fact','Keep memory','Project information',0,'agent',?,1,1)",
      )
      .run(createSortableId(), session.projectId, owned.runId);
    await service.action("session/pin", { sessionId: session.conversationId, pinned: true });
    connection
      .prepare("INSERT INTO native_chat_tool_scopes VALUES(?,NULL,NULL,1)")
      .run(session.conversationId);
    await service.action("session/archive", { sessionId: session.conversationId });
    expect(() =>
      connection
        .prepare("DELETE FROM messages WHERE conversation_id=?")
        .run(session.conversationId),
    ).toThrow("transaction required");
    expect(() => deleteArchivedChat(connection, session.conversationId)).toThrow(
      "serialized transaction",
    );
    expect(await service.action("session/delete", { sessionId: session.conversationId })).toEqual({
      deleted: true,
      sessionId: session.conversationId,
    });
    for (const table of [
      "messages",
      "agent_steps",
      "conversation_summaries",
      "approvals",
      "file_changes",
      "node_attempts",
      "node_invocations",
      "durable_events",
      "run_checkpoints",
      "checkpoint_op_frontier",
      "checkpoint_control_edges",
      "checkpoint_router_selections",
      "native_chat_tool_scopes",
      "archived_chat_deletion_guards",
      "archived_chat_run_deletion_guards",
    ])
      expect(connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, table).toBe(
        0,
      );
    expect(
      connection
        .prepare("SELECT conversation_id,title FROM goals WHERE goal_id=?")
        .get(goal.goalId),
    ).toMatchObject({ conversation_id: null, title: "Keep project goal" });
    expect(
      connection.prepare("SELECT source_run_id,body FROM project_memories").get(),
    ).toMatchObject({ source_run_id: null, body: "Project information" });
    expect(
      connection
        .prepare("SELECT parent_run_id,fork_metadata_json FROM runs WHERE run_id=?")
        .get(surviving.runId),
    ).toMatchObject({ parent_run_id: null, fork_metadata_json: null });
    expect(
      connection.prepare("SELECT 1 FROM graph_sources WHERE document_hash=?").get(owned.hash),
    ).toBeUndefined();
    expect(
      connection.prepare("SELECT 1 FROM compiled_plans WHERE compiled_plan_id=?").get(owned.planId),
    ).toBeUndefined();
    expect(readConversation(connection, other.conversationId)).toEqual(other);
    expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects active, unfinished and shared chats, without partially erasing them", async () => {
    const { db, service } = fixture();
    const session = chat(db.connection());
    await expect(
      service.action("session/delete", { sessionId: session.conversationId }),
    ).rejects.toThrow("Archive");
    const active = run(db.connection(), session.conversationId, "waiting");
    archiveConversation(db.connection(), session.conversationId, 1);
    await expect(
      service.action("session/delete", { sessionId: session.conversationId }),
    ).rejects.toThrow("unfinished");
    writeArchivedRetentionDays(db.connection(), 1);
    expect(await service.purgeArchivedSessions()).toEqual({ deletedCount: 0 });
    expect(readConversation(db.connection(), session.conversationId)).toBeDefined();
    db.connection().prepare("UPDATE runs SET status='completed' WHERE run_id=?").run(active.runId);
    const other = chat(db.connection());
    appendMessage(db.connection(), {
      messageId: createSortableId(),
      conversationId: other.conversationId,
      role: "assistant",
      parts: [{ kind: "text", text: "Shared execution" }],
      runId: active.runId,
      nowMs: 2,
    });
    await expect(
      service.action("session/delete", { sessionId: session.conversationId }),
    ).rejects.toThrow("shares saved activity");
    expect(await service.purgeArchivedSessions()).toEqual({ deletedCount: 0 });
    expect(db.connection().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db.connection().prepare("SELECT count(*) AS count FROM archived_chat_deletion_guards").get()
        ?.count,
    ).toBe(0);
  });

  it("rechecks a restore ahead of deletion in the serialized write queue", async () => {
    const { db, service } = fixture();
    const session = chat(db.connection());
    archiveConversation(db.connection(), session.conversationId, 1);
    const restoring = service.action("session/restore", { sessionId: session.conversationId });
    const deleting = service.action("session/delete", { sessionId: session.conversationId });
    await restoring;
    await expect(deleting).rejects.toThrow("Archive");
    expect(readConversation(db.connection(), session.conversationId)?.status).toBe("active");
  });

  it("lists all archived chats beyond the recent sidebar limit", async () => {
    const { db, service } = fixture();
    const first = chat(db.connection());
    for (let index = 0; index < 205; index++) {
      const session = createConversation(db.connection(), {
        conversationId: createSortableId(),
        projectId: first.projectId,
        title: `Archive ${index}`,
        nowMs: 1,
      });
      archiveConversation(db.connection(), session.conversationId, 2 + index);
    }
    const all = (await service.action("session/list", { archived: true })) as {
      data: { id: string; archivedAt: number }[];
    };
    expect(all.data).toHaveLength(205);
    expect(all.data.every((session) => session.archivedAt > 0)).toBe(true);
    expect(
      await service.action("session/list", { projectId: first.projectId, archived: true }),
    ).toMatchObject({ data: all.data });
  });

  it("keeps terminal runs whose cooperative executor is still cleaning up", async () => {
    const { db, service } = fixture();
    const session = chat(db.connection());
    const saved = run(db.connection(), session.conversationId);
    archiveConversation(db.connection(), session.conversationId, 1);
    service.services.isRunActive = (runId) => runId === saved.runId;
    await expect(
      service.action("session/delete", { sessionId: session.conversationId }),
    ).rejects.toThrow("unfinished");
    writeArchivedRetentionDays(db.connection(), 1);
    expect(await service.purgeArchivedSessions()).toEqual({ deletedCount: 0 });
    service.services.isRunActive = () => false;
    expect(await service.purgeArchivedSessions()).toEqual({ deletedCount: 1 });
  });

  it("removes assistant actor authority safely while preserving other chats and invalidating prior context", async () => {
    const { db, service } = fixture();
    const connection = db.connection();
    const root = chat(connection, "Assistant");
    const child = chat(connection, "Child");
    const descendant = chat(connection, "Descendant");
    const rootMessage = appendMessage(connection, {
      messageId: createSortableId(),
      conversationId: root.conversationId,
      role: "assistant",
      parts: [{ kind: "text", text: "Prior authorized child context" }],
      nowMs: 2,
    });
    connection.prepare("INSERT INTO assistant_roots VALUES(?,0)").run(root.conversationId);
    for (const [actor, parent] of [
      [root.conversationId, null],
      [child.conversationId, root.conversationId],
      [descendant.conversationId, child.conversationId],
    ]) {
      connection
        .prepare("INSERT INTO assistant_actors VALUES(?,?,?)")
        .run(root.conversationId, actor!, parent ?? null);
      connection
        .prepare('INSERT INTO assistant_edges VALUES(?,?,?,\'["read","control"]\')')
        .run(root.conversationId, actor!, actor!);
      connection
        .prepare("INSERT INTO assistant_tool_authorities VALUES(?,?, '{}')")
        .run(root.conversationId, actor!);
    }
    connection
      .prepare('INSERT INTO assistant_edges VALUES(?,?,?,\'["read","control"]\')')
      .run(root.conversationId, root.conversationId, child.conversationId);
    connection
      .prepare("INSERT INTO assistant_tool_assignments VALUES(?,?,?,'parent')")
      .run(root.conversationId, descendant.conversationId, child.conversationId);
    connection
      .prepare("INSERT INTO assistant_tool_requests VALUES('request',?,?,?,0,'{}','pending',1)")
      .run(root.conversationId, descendant.conversationId, child.conversationId);
    connection
      .prepare(
        "INSERT INTO assistant_access_audit(assistant_id,epoch,action,details_json,created_at_ms) VALUES(?,0,'read',?,1)",
      )
      .run(root.conversationId, JSON.stringify({ chat: child.conversationId }));
    const active = run(connection, root.conversationId, "running");
    connection
      .prepare("INSERT INTO assistant_runs VALUES(?,?,?,?,0,'user')")
      .run(active.runId, root.conversationId, root.conversationId, root.conversationId);
    archiveConversation(connection, child.conversationId, 3);
    await expect(
      service.action("session/delete", { sessionId: child.conversationId }),
    ).rejects.toThrow("unfinished");
    connection.prepare("UPDATE runs SET status='completed' WHERE run_id=?").run(active.runId);
    await service.action("session/delete", { sessionId: child.conversationId });
    expect(
      connection
        .prepare("SELECT epoch FROM assistant_roots WHERE assistant_id=?")
        .get(root.conversationId)?.epoch,
    ).toBe(1);
    expect(connection.prepare("SELECT chat_id FROM assistant_actors").all()).toEqual([
      { chat_id: root.conversationId },
    ]);
    expect(
      connection
        .prepare("SELECT boundary_message_id FROM assistant_context_floors WHERE epoch=1")
        .get()?.boundary_message_id,
    ).toBe(rootMessage.messageId);
    expect(connection.prepare("SELECT * FROM assistant_tool_requests").all()).toEqual([]);
    expect(connection.prepare("SELECT * FROM assistant_tool_assignments").all()).toEqual([]);
    expect(connection.prepare("SELECT * FROM assistant_access_audit").all()).toEqual([]);
    expect(readConversation(connection, descendant.conversationId)).toEqual(descendant);
    expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    await service.action("session/archive", { sessionId: root.conversationId });
    await service.action("session/delete", { sessionId: root.conversationId });
    for (const table of [
      "assistant_roots",
      "assistant_actors",
      "assistant_edges",
      "assistant_runs",
      "assistant_tool_authorities",
      "assistant_context_floors",
    ])
      expect(connection.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(readConversation(connection, descendant.conversationId)).toEqual(descendant);
  });
});
