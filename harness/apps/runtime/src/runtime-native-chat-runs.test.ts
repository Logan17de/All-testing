import { expect, it } from "vitest";
import {
  PluginHost,
  CapabilityPermissionPolicy,
  createAgentPlugin,
  createControlFlowPlugin,
} from "@zet-harness/core";
import { SQLITE_MEMORY_PATH, SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { createConversation } from "@zet-harness/db/durable-conversation-records";
import { createProject } from "@zet-harness/db/durable-project-records";
import { createSortableId } from "@zet-harness/db/sortable-id";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { attestNativeChatRun } from "./runtime-native-chat-runs.js";
import { buildWorkflow } from "./runtime-workflows.js";
import { compileEditorGraph, createRunFromCompiledGraph } from "./runtime-graphs.js";
it("native run attestation is atomic, immutable and never inferred from a generic graph label", async () => {
  const db = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  db.open();
  runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
  const host = new PluginHost();
  await host.activate(createControlFlowPlugin());
  await host.activate(createAgentPlugin());
  const conversationId = createSortableId();
  const project = createProject(db.connection(), {
    projectId: createSortableId(),
    name: "Provenance fixture",
    workspacePath: process.cwd(),
    nowMs: Date.now(),
  });
  createConversation(db.connection(), {
    conversationId,
    projectId: project.projectId,
    title: "Fixture",
    nowMs: Date.now(),
  });
  const graph = {
    ...buildWorkflow("chat", conversationId),
    graphId: `native-chat:${conversationId}`,
  };
  const compiled = await compileEditorGraph(graph, { host }, new CapabilityPermissionPolicy());
  if (!compiled.valid) throw new Error("Fixture compile failed.");
  try {
    await expect(
      createRunFromCompiledGraph(
        db,
        compiled.compiled,
        Date.now(),
        undefined,
        (connection, runId) => {
          attestNativeChatRun(connection, runId, conversationId);
          throw new Error("Trusted attestation failed.");
        },
      ),
    ).rejects.toThrow("attestation failed");
    expect(db.connection().prepare("SELECT count(*) AS n FROM runs").get()?.n).toBe(0);
    expect(db.connection().prepare("SELECT count(*) AS n FROM native_chat_runs").get()?.n).toBe(0);
    const generic = await createRunFromCompiledGraph(db, compiled.compiled);
    expect(
      db.connection().prepare("SELECT 1 FROM native_chat_runs WHERE run_id=?").get(generic.runId),
    ).toBeUndefined();
    const native = await createRunFromCompiledGraph(
      db,
      compiled.compiled,
      Date.now(),
      undefined,
      (connection, runId) => attestNativeChatRun(connection, runId, conversationId),
    );
    expect(
      db
        .connection()
        .prepare("SELECT conversation_id FROM native_chat_runs WHERE run_id=?")
        .get(native.runId)?.conversation_id,
    ).toBe(conversationId);
    expect(() =>
      db
        .connection()
        .prepare("UPDATE native_chat_runs SET conversation_id=? WHERE run_id=?")
        .run(conversationId, native.runId),
    ).toThrow("immutable");
    expect(() =>
      db.connection().prepare("DELETE FROM native_chat_runs WHERE run_id=?").run(native.runId),
    ).toThrow("immutable");
    await expect(
      createRunFromCompiledGraph(
        db,
        compiled.compiled,
        Date.now(),
        undefined,
        // Intentionally violate the trusted hook contract to verify runtime fail-closed enforcement.
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        async (connection, runId) => {
          attestNativeChatRun(connection, runId, conversationId);
          await Promise.resolve();
        },
      ),
    ).rejects.toThrow("synchronous");
    expect(db.connection().prepare("SELECT count(*) AS n FROM runs").get()?.n).toBe(2);
    expect(db.connection().prepare("SELECT count(*) AS n FROM native_chat_runs").get()?.n).toBe(1);
  } finally {
    await host.dispose();
    db.close();
  }
});
