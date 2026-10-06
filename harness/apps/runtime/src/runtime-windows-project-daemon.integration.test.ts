import { DatabaseSync } from "node:sqlite";
import { mkdtemp, realpath, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { saveModelConfig } from "@zet-harness/db/durable-model-records";
import { writeSetting } from "@zet-harness/db/durable-setting-records";
import { readConversationMessages } from "@zet-harness/db/durable-conversation-records";
import { RuntimeDaemon } from "./runtime-daemon.js";

// Scripted inference only; positive execution uses the actual Windows kernel sandbox.
// Production dispatch must be promoted explicitly before this Windows test can pass.
it.skipIf(process.platform !== "win32")(
  "real daemon requires exact project approval and isolates source/private state",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "win-project-daemon-")));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "win-project-state-")));
    const databasePath = join(outside, "runtime.sqlite");
    const originalNpm = process.env["ZET_NPM_CLI"];
    const npmCli = originalNpm ?? process.env["npm_execpath"];
    if (!npmCli) throw new Error("Native fixture requires trusted npm_execpath or ZET_NPM_CLI.");
    process.env["ZET_NPM_CLI"] = await realpath(npmCli);
    await writeFile(join(root, "source.txt"), "source unchanged");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: { test: "node fixture.cjs", pretest: "node -e process.exit(99)" },
      }),
    );
    await writeFile(
      join(root, "fixture.cjs"),
      `const fs=require('node:fs');const assert=require('node:assert/strict');for(const suffix of ['', '-wal','-shm'])assert.equal(fs.existsSync(${JSON.stringify(databasePath)}+suffix),false);assert.equal(fs.readFileSync('source.txt','utf8'),'source unchanged');fs.writeFileSync('copy-only.txt','private output');console.log('WINDOWS-PRIVATE-PROJECT-OK');`,
    );
    const daemon = new RuntimeDaemon({
      api: { port: 0 },
      database: { path: databasePath },
      plugins: { directory: join(outside, "plugins") },
      probePathLimits: false,
    });
    await daemon.start();
    const db = new DatabaseSync(databasePath);
    writeSetting(db, "workspace.root", root, Date.now());
    const api = daemon.snapshot().api;
    const base = `http://${api.host}:${String(api.port)}`;
    const seen = new Set<string>();
    daemon.plugins!.models.register({
      manifest: {
        id: "fixture.model",
        version: "1",
        title: "Scripted Windows fixture",
        requiredCapabilities: [],
        features: {
          streaming: false,
          tools: true,
          vision: false,
          structuredOutput: false,
          contextWindowTokens: 32000,
        },
      },
      generate: (request, context) => {
        const first = !seen.has(context.runId);
        seen.add(context.runId);
        return Promise.resolve({
          message: {
            role: "assistant" as const,
            parts: first
              ? [
                  {
                    kind: "tool-call" as const,
                    callId: "project",
                    name: "harness_shell_run",
                    arguments: { command: "project-test" },
                  },
                ]
              : [{ kind: "text" as const, text: "scripted fixture complete" }],
          },
          finishReason: first ? ("tool-calls" as const) : ("stop" as const),
        });
      },
    });
    saveModelConfig(db, {
      modelId: "fixture.model",
      title: "Fixture",
      profile: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "fixture",
      tools: true,
      contextWindowTokens: 32000,
      nowMs: Date.now(),
    });
    try {
      const { csrfToken } = (await (await fetch(`${base}/api/session`)).json()) as {
        csrfToken: string;
      };
      const raw = (action: string, params: Record<string, unknown>) =>
        fetch(`${base}/api/agent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-zet-csrf": csrfToken },
          body: JSON.stringify({ action, params }),
        });
      const post = async (action: string, params: Record<string, unknown>) => {
        const response = await raw(action, params);
        expect(response.status).toBe(200);
        return (await response.json()) as { result: Record<string, unknown> };
      };
      const session = async () =>
        (
          (await post("session/start", { title: "Windows project fixture" })).result.session as {
            id: string;
          }
        ).id;
      const start = async (sessionId: string, mutationConsent: boolean) =>
        (
          (
            await post("turn/start", {
              sessionId,
              text: "Run the fixed fixture test",
              modelId: "fixture.model",
              mutationConsent,
            })
          ).result.turn as { id: string }
        ).id;
      const terminal = async (id: string, budgetMs = 30000) => {
        const deadline = performance.now() + budgetMs;
        while (performance.now() < deadline) {
          if (
            ["completed", "failed", "cancelled"].includes(
              String(db.prepare("SELECT status FROM runs WHERE run_id=?").get(id)?.status),
            )
          )
            return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("Fixture did not terminate.");
      };
      type Approval = {
        id: string;
        runId: string;
        requestGeneration: number;
        tool: string;
        args: unknown;
      };
      const approvals = async () =>
        ((await (await fetch(`${base}/api/agent`)).json()) as { toolApprovals: Approval[] })
          .toolApprovals;
      const pending = async (runId: string) => {
        for (let i = 0; i < 400; i++) {
          const entry = (await approvals()).find((item) => item.runId === runId);
          if (entry) return entry;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("Exact native approval not reached.");
      };
      const noConsent = await session();
      const denied = await start(noConsent, false);
      await terminal(denied);
      expect((await approvals()).some((item) => item.runId === denied)).toBe(false);
      const scoped = await session();
      await post("session/plugin-scope", { sessionId: scoped, model: [], tools: [] });
      const restricted = await start(scoped, true);
      await terminal(restricted);
      expect((await approvals()).some((item) => item.runId === restricted)).toBe(false);
      const declinedSession = await session();
      const declinedRun = await start(declinedSession, true);
      const decline = await pending(declinedRun);
      expect(decline.tool).toBe("harness.shell.run");
      expect(decline.args).toEqual({ command: "project-test" });
      await post("tool-approval/respond", {
        id: decline.id,
        requestGeneration: decline.requestGeneration,
        decision: "rejected",
      });
      await terminal(declinedRun);
      const cancelledSession = await session();
      const cancelledRun = await start(cancelledSession, true);
      const stale = await pending(cancelledRun);
      await post("turn/interrupt", { sessionId: cancelledSession, turnId: cancelledRun });
      await terminal(cancelledRun);
      expect(
        (
          await raw("tool-approval/respond", {
            id: stale.id,
            requestGeneration: stale.requestGeneration,
            decision: "approved",
          })
        ).status,
      ).toBe(400);
      const approvedSession = await session();
      const approvedRun = await start(approvedSession, true);
      const exact = await pending(approvedRun);
      expect(exact.args).toEqual({ command: "project-test" });
      await expect(access(join(root, "copy-only.txt"))).rejects.toThrow();
      await post("tool-approval/respond", {
        id: exact.id,
        requestGeneration: exact.requestGeneration,
        decision: "approved",
      });
      await terminal(approvedRun, 190000);
      const result = readConversationMessages(db, approvedSession)
        .flatMap((message) => message.parts)
        .find((part) => part.kind === "tool-result" && part.callId === "project");
      expect(result?.kind === "tool-result" && result.isError).not.toBe(true);
      expect(result?.kind === "tool-result" ? result.value : null).toMatchObject({
        executionWorkspace: "temporary-copy",
        sourceWorkspaceModified: false,
        exitCode: 0,
      });
      expect(JSON.stringify(result)).toContain("WINDOWS-PRIVATE-PROJECT-OK");
      expect(await readFile(join(root, "source.txt"), "utf8")).toBe("source unchanged");
      await expect(access(join(root, "copy-only.txt"))).rejects.toThrow();
      expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      for (const id of [noConsent, scoped, declinedSession, cancelledSession])
        expect(JSON.stringify(readConversationMessages(db, id))).not.toContain(
          "WINDOWS-PRIVATE-PROJECT-OK",
        );
    } finally {
      await daemon.stop();
      db.close();
      if (originalNpm === undefined) delete process.env["ZET_NPM_CLI"];
      else process.env["ZET_NPM_CLI"] = originalNpm;
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
  240000,
);
