import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  CapabilityPermissionPolicy,
  PluginHost,
  createAgentPlugin,
  createControlFlowPlugin,
} from "@zet-harness/core";
import { SqliteDatabase, SQLITE_MEMORY_PATH, runSqliteMigrations } from "@zet-harness/db";
import { saveModelConfig } from "@zet-harness/db/durable-model-records";
import type { AdapterInvocationContext } from "@zet-harness/plugin-api";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import { RuntimeCodingService } from "./runtime-coding-service.js";
import { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";

it("serializes turns, binds call consent, rejects stale/duplicate answers, and expires waits", async () => {
  const root = await mkdtemp(join(tmpdir(), "zet-approval-security-"));
  const other = await mkdtemp(join(tmpdir(), "zet-approval-other-"));
  const db = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
  db.open();
  runSqliteMigrations(db.connection(), RUNTIME_DATABASE_MIGRATIONS);
  const host = new PluginHost();
  await host.activate(createControlFlowPlugin());
  await host.activate(createAgentPlugin());
  const authority = new CapabilityPermissionPolicy();
  const redaction = new RuntimeRedactionRegistry();
  const approvals = new RuntimeHumanApprovals(db, { redaction, authority });
  saveModelConfig(db.connection(), {
    modelId: "fixture",
    title: "Fixture",
    profile: "custom",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
    tools: true,
    contextWindowTokens: 32000,
    nowMs: Date.now(),
  });
  let selected = root;
  const cancel = vi.fn(() => Promise.resolve());
  const service = new RuntimeCodingService({
    database: db,
    workspace: () => selected,
    approvals,
    sources: () => ({ host }),
    capabilityAuthority: () => authority,
    redact: (value: unknown) => value,
    dispatch: () => undefined,
    cancel,
  });
  try {
    const started = (await service.action("session/start")) as { session: { id: string } };
    const params = {
      sessionId: started.session.id,
      modelId: "fixture",
      text: "fixture",
      mutationConsent: true,
    };
    const turns = await Promise.allSettled([
      service.action("turn/start", params),
      service.action("turn/start", params),
    ]);
    expect(turns.map((turn) => turn.status)).toEqual(["fulfilled", "rejected"]);
    const runId = (turns[0] as PromiseFulfilledResult<{ turn: { id: string } }>).value.turn.id;
    const context = (signal = new AbortController().signal): AdapterInvocationContext => ({
      runId,
      signal,
      logicalEffectId: "fixture-call",
      opIndex: 0,
      iteration: 0,
      attempt: 1,
      retryBudget: {
        maxAttempts: 1,
        repeatAuthorized: false,
        usedAttempts: 1,
        remainingAttempts: 0,
        reportInternalRetries: () => 0,
      },
    });
    const request = { tool: "harness.fs.write", args: { path: "fixture.ts", content: "fixture" } };
    const wait = service.approveTool(request, context());
    const pending = (
      service.snapshot().toolApprovals as { id: string; requestGeneration: number }[]
    )[0]!;
    await expect(
      service.action("tool-approval/respond", {
        id: pending.id,
        requestGeneration: pending.requestGeneration + 1,
        decision: "approved",
      }),
    ).rejects.toThrow("expired");
    await service.action("tool-approval/respond", {
      id: pending.id,
      requestGeneration: pending.requestGeneration,
      decision: "approved",
    });
    expect(await wait).toBe(true);
    await expect(
      service.action("tool-approval/respond", {
        id: pending.id,
        requestGeneration: pending.requestGeneration,
        decision: "approved",
      }),
    ).rejects.toThrow("expired");
    const controller = new AbortController();
    const cancelled = service.approveTool(request, context(controller.signal));
    controller.abort();
    expect(await cancelled).toBe(false);
    vi.useFakeTimers();
    const expired = service.approveTool(request, context());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await expired).toBe(false);
    vi.useRealTimers();
    const switched = service.approveTool(request, context());
    selected = other;
    service.snapshot();
    expect(await switched).toBe(false);
    await service.drainCancellations();
    expect(cancel).toHaveBeenCalledWith(runId);
    expect(service.toolPolicy(runId)).toBeUndefined();
    expect(await service.approveTool(request, context())).toBe(false);
  } finally {
    vi.useRealTimers();
    service.close();
    db.close();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});
