import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SQLITE_MEMORY_PATH } from "@zet-harness/db";
import { RuntimeDaemon } from "./runtime-daemon.js";
const daemons: RuntimeDaemon[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
describe("standalone coding HTTP boundary", () => {
  it("persists native sessions, enforces mutation CSRF and retires the delegated coding service", async () => {
    const daemon = new RuntimeDaemon({
      api: { port: 0 },
      database: { path: SQLITE_MEMORY_PATH },
      plugins: {},
      probePathLimits: false,
    });
    daemons.push(daemon);
    await daemon.start();
    const base = `http://127.0.0.1:${daemon.snapshot().api.port}`;
    const csrf = (await (await fetch(`${base}/api/session`)).json()) as { csrfToken: string };
    const token = csrf.csrfToken;
    const post = (action: string, params: unknown = {}, auth = token) =>
      fetch(`${base}/api/agent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zet-csrf": auth },
        body: JSON.stringify({ action, params }),
      });
    const status = (await (await fetch(`${base}/api/agent`)).json()) as { engine: string };
    expect(status.engine).toBe("native");
    expect((await post("session/start", {}, "")).status).toBe(403);
    const noDefault = await post("session/start", {});
    expect(noDefault.status).toBe(400);
    expect(await noDefault.json()).toMatchObject({ error: { code: "DEFAULT_FOLDER_UNTRUSTED" } });
    const folder = await realpath(await mkdtemp(join(tmpdir(), "native-http-folder-")));
    folders.push(folder);
    expect(
      (
        await fetch(`${base}/api/setup/workspace`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-zet-csrf": token },
          body: JSON.stringify({ path: folder, trusted: true }),
        })
      ).status,
    ).toBe(200);
    const created = (await (
      await post("session/start", { title: "HTTP native session" })
    ).json()) as { result: { session: { id: string } } };
    const id = created.result.session.id;
    expect(await (await post("session/read", { sessionId: id })).json()).toMatchObject({
      result: { session: { id }, messages: [] },
    });
    const noModel = await post("turn/start", {
      sessionId: id,
      text: "fixture",
      modelId: "missing",
    });
    expect(noModel.status).toBe(400);
    expect(await noModel.json()).toMatchObject({ error: { code: "MODEL_NOT_CONFIGURED" } });
    expect(
      (await post("session/read", { sessionId: id, sandbox: "danger-full-access" })).status,
    ).toBe(400);
    const invalid = await post("model/list", { apiKey: "private-test-value" });
    expect(await invalid.text()).not.toContain("private-test-value");
    await rm(folder, { recursive: true, force: true });
    const unavailable = await post("turn/start", {
      sessionId: id,
      text: "fixture",
      modelId: "missing",
    });
    expect(unavailable.status).toBe(400);
    expect(await unavailable.json()).toEqual({
      error: {
        code: "PROJECT_FOLDER_UNAVAILABLE",
        reason: "The trusted project folder changed or is unavailable; select and trust it again.",
      },
    });
    expect((await post("session/start", { title: "x".repeat(140_000) })).status).toBe(413);
    expect((await fetch(`${base}/api/codex`)).status).toBe(410);
    expect(
      (
        await fetch(`${base}/api/auth/chatgpt/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(await (await fetch(`${base}/api/auth/chatgpt`)).json()).toMatchObject({
      state: "disconnected",
    });
  });
});
