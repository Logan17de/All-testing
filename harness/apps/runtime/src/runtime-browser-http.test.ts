import { expect, it } from "vitest";
import { SQLITE_MEMORY_PATH } from "@zet-harness/db";
import { RuntimeDaemon } from "./runtime-daemon.js";
it("browser HTTP requires runtime mutation consent and refuses invalid scopes without launch", async () => {
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path: SQLITE_MEMORY_PATH },
    plugins: {},
    probePathLimits: false,
  });
  await daemon.start();
  try {
    const base = `http://127.0.0.1:${daemon.snapshot().api.port}`;
    const { csrfToken } = (await (await fetch(`${base}/api/session`)).json()) as {
      csrfToken: string;
    };
    expect(await (await fetch(`${base}/api/browser`)).json()).toMatchObject({
      armed: false,
      captures: [],
      pendingInputs: [],
      captureSharing: "disabled",
    });
    const post = (params: unknown, token = csrfToken) =>
      fetch(`${base}/api/browser`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zet-csrf": token },
        body: JSON.stringify({ action: "arm", params }),
      });
    expect((await post({}, "")).status).toBe(403);
    expect(
      (
        await post({
          task: "fixture",
          domains: ["localhost"],
          minutes: 1,
          maxActions: 1,
          confirm: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          task: "fixture",
          domains: ["public.org"],
          minutes: 1,
          maxActions: 1,
          confirm: true,
          ignoreSandbox: true,
        })
      ).status,
    ).toBe(400);
    expect((await post({ task: "x".repeat(140_000) })).status).toBe(413);
    expect(await (await fetch(`${base}/api/browser`)).json()).toMatchObject({
      armed: false,
      pendingInputs: [],
    });
  } finally {
    await daemon.stop();
  }
});
