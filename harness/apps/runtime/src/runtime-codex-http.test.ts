import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { RuntimeApiSecurity } from "./runtime-api-security.js";
import { createCodexHttpHandler } from "./runtime-codex-http.js";
import { RuntimeCodexService } from "./runtime-codex-service.js";
describe("Codex HTTP boundary (fixture only)", () => {
  it("serves bounded snapshots, rejects credential injection and requires persistent login consent", async () => {
    const service = new RuntimeCodexService({
      cwd: process.cwd(),
      spawnProcess: () =>
        spawn(
          process.execPath,
          [
            "-e",
            `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)console.log(JSON.stringify({id:m.id,result:{method:m.method,params:m.params,...(['thread/start','thread/resume'].includes(m.method)?{thread:{id:'fixture-thread'}}:{})}}));});`,
          ],
          { stdio: "pipe" },
        ),
    });
    const security = new RuntimeApiSecurity();
    const handler = createCodexHttpHandler(service);
    const server = createServer((request, response) => {
      void handler(
        request,
        response,
        new URL(request.url ?? "/", "http://localhost"),
        security,
      ).catch(() => {
        response.writeHead(403);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server");
    const url = `http://127.0.0.1:${address.port}/api/codex`;
    const post = (body: unknown, token = security.sessionToken()) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zet-csrf": token },
        body: JSON.stringify(body),
      });
    try {
      expect(await (await fetch(url)).json()).toMatchObject({
        available: false,
        events: [],
        pendingApprovals: [],
      });
      expect((await post({ action: "account/read" }, "")).status).toBe(403);
      expect((await fetch(`${url}?since=-1`)).status).toBe(400);
      expect((await fetch(`${url}?since=NaN`)).status).toBe(400);
      expect(
        (await post({ action: "account/login/start", params: { type: "chatgpt" } })).status,
      ).toBe(502);
      expect(
        (
          await post({
            action: "account/login/start",
            params: {
              type: "chatgptAuthTokens",
              accessToken: "private",
              confirmPersistLogin: true,
            },
          })
        ).status,
      ).toBe(502);
      expect(
        await (
          await post({ action: "thread/start", params: { cwd: "/", approvalPolicy: "never" } })
        ).json(),
      ).toMatchObject({
        result: {
          params: { cwd: process.cwd(), sandbox: "read-only", approvalPolicy: "on-request" },
        },
      });
      expect(
        (await post({ action: "thread/start", params: { text: "x".repeat(140_000) } })).status,
      ).toBe(413);
    } finally {
      service.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
