import { afterEach, describe, expect, it } from "vitest";
import { SQLITE_MEMORY_PATH } from "@zet-harness/db";
import { RuntimeDaemon } from "./runtime-daemon.js";
const daemons: RuntimeDaemon[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
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
    const created = (await (
      await post("session/start", { title: "HTTP native session" })
    ).json()) as { result: { session: { id: string } } };
    const id = created.result.session.id;
    expect(await (await post("session/read", { sessionId: id })).json()).toMatchObject({
      result: { session: { id }, messages: [] },
    });
    expect(
      (await post("turn/start", { sessionId: id, text: "fixture", modelId: "missing" })).status,
    ).toBe(400);
    expect(
      (await post("session/read", { sessionId: id, sandbox: "danger-full-access" })).status,
    ).toBe(400);
    const invalid = await post("model/list", { apiKey: "private-test-value" });
    expect(await invalid.text()).not.toContain("private-test-value");
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
