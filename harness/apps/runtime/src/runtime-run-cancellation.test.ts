import { expect, it } from "vitest";
import { CapabilityPermissionPolicy, PluginHost } from "@zet-harness/core";
import {
  DURABLE_CHECKPOINTS_MIGRATION,
  DURABLE_EVENTS_MIGRATION,
  DURABLE_GRAPH_IDENTITY_MIGRATION,
  DURABLE_NODE_ATTEMPTS_MIGRATION,
  DURABLE_RUNS_MIGRATION,
  SQLITE_MEMORY_PATH,
  SqliteDatabase,
  runSqliteMigrations,
} from "@zet-harness/db";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";
import { DURABLE_APPROVALS_MIGRATION } from "@zet-harness/db/durable-approval-records";
import { compileEditorGraph, createRunFromCompiledGraph } from "./runtime-graphs.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";
import { RuntimeRunDispatcher } from "./runtime-run-dispatcher.js";
import { reconstructExecutionFrontier } from "./runtime-recovery.js";

it("cancels only the requested run and waits for actual executor settlement before terminalizing", async () => {
  const db = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  db.open();
  runSqliteMigrations(db.connection(), [
    DURABLE_GRAPH_IDENTITY_MIGRATION,
    DURABLE_RUNS_MIGRATION,
    DURABLE_NODE_ATTEMPTS_MIGRATION,
    DURABLE_EVENTS_MIGRATION,
    DURABLE_CHECKPOINTS_MIGRATION,
    DURABLE_APPROVALS_MIGRATION,
  ]);
  const host = new PluginHost();
  await host.activate({
    manifest: { id: "test.cancel", name: "Cancellation", version: "1.0.0", apiVersion: 1 },
    activate(context) {
      context.nodes.register({
        manifest: {
          type: "test.wait",
          version: "1",
          title: "Wait",
          inputs: {},
          outputs: {},
          configSchema: { type: "object" },
          behavior: {
            primitiveFamily: "pure",
            determinism: "deterministic",
            effect: "none",
            idempotency: "not-applicable",
            recovery: "rerun",
            executionMode: "in-process",
            requiredCapabilities: [],
          },
        },
        execute: () => ({ outputs: {} }),
      });
    },
  });
  const graph: GraphJsonV1 = {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "cancel",
    revisionId: "v1",
    inputs: [],
    outputs: [],
    nodes: [{ id: "wait", type: "test.wait", version: "1", config: {} }],
    edges: [],
    entrypoints: [{ id: "main", nodeId: "wait" }],
    policies: {
      maxNodeExecutions: 10,
      maxParallelism: 2,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
  };
  const compiled = await compileEditorGraph(graph, { host }, new CapabilityPermissionPolicy());
  if (!compiled.valid) throw new Error("Invalid test graph");
  const first = (await createRunFromCompiledGraph(db, compiled.compiled)).runId;
  const second = (await createRunFromCompiledGraph(db, compiled.compiled)).runId;
  const redaction = new RuntimeRedactionRegistry();
  const approvals = new RuntimeHumanApprovals(db, { redaction });
  const signals = new Map<string, AbortSignal>();
  const releases = new Map<string, () => void>();
  const dispatcher = new RuntimeRunDispatcher(
    db,
    approvals,
    {
      execute: async ({ runId, signal }) => {
        signals.set(runId, signal);
        await new Promise<void>((resolve) => releases.set(runId, resolve));
        return { outputs: {} };
      },
    },
    redaction,
  );
  dispatcher.start();
  try {
    await expect.poll(() => signals.size).toBe(2);
    await dispatcher.cancelRun(first);
    expect(signals.get(first)?.aborted).toBe(true);
    expect(signals.get(second)?.aborted).toBe(false);
    expect(reconstructExecutionFrontier(db.connection(), first).runStatus).toBe("running");
    releases.get(first)!();
    expect(await dispatcher.waitForIdle(first)).toMatchObject({ status: "cancelled" });
    expect(
      reconstructExecutionFrontier(db.connection(), first).preCrashRunningAttempts,
    ).toHaveLength(0);
    releases.get(second)!();
    expect(await dispatcher.waitForIdle(second)).toMatchObject({ status: "completed" });
    await dispatcher.cancelRun(first);
    expect(
      db
        .connection()
        .prepare(
          "SELECT count(*) AS count FROM durable_events WHERE run_id = ? AND event_type = 'harness.run.cancelled'",
        )
        .get(first),
    ).toMatchObject({ count: 1 });
  } finally {
    for (const release of releases.values()) release();
    await dispatcher.stop();
    await host.dispose();
    db.close();
  }
});
