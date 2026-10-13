import { createServer } from "node:http";
import { expect, it } from "vitest";
import { RuntimeApiSecurity } from "./runtime-api-security.js";
import { createRuntimePluginMaker } from "./runtime-plugin-maker.js";
import { createRuntimePluginMakerController } from "./runtime-plugin-maker-controller.js";
import { createPluginMakerHttpHandler } from "./runtime-plugin-maker-http.js";
it("real loopback HTTP exposes inert snapshot and requires CSRF and exact human proof", async () => {
  const authority = {};
  const maker = createRuntimePluginMaker({ write: () => Promise.resolve() }, authority);
  const controller = createRuntimePluginMakerController({
    maker,
    userAuthority: authority,
    host: {
      materialize: () => Promise.resolve(),
      test: () =>
        Promise.resolve({
          mode: "required-os-sandbox",
          executed: false,
          passed: false,
          code: "SANDBOX_UNAVAILABLE",
        }),
      enable: () => Promise.resolve({}),
    },
  });
  const handler = createPluginMakerHttpHandler(controller);
  const security = new RuntimeApiSecurity();
  const server = createServer((request, response) => {
    void handler(
      request,
      response,
      new URL(request.url ?? "/", "http://127.0.0.1"),
      security,
    ).catch(() => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "DENIED" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture address");
    const base = `http://127.0.0.1:${address.port}/api/plugin-maker`;
    expect(await (await fetch(base)).json()).toMatchObject({
      artifact: null,
      enabled: false,
      scopeGeneration: 0,
    });
    const post = (body: unknown, token = security.sessionToken()) =>
      fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zet-csrf": token },
        body: JSON.stringify(body),
      });
    expect(
      (await post({ action: "scaffold", params: { id: "example.http", name: "HTTP" } }, "")).status,
    ).toBe(403);
    const created = (await (
      await post({ action: "scaffold", params: { id: "example.http", name: "HTTP" } })
    ).json()) as { result: { hash: string } };
    expect(created.result.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      (
        await post({
          action: "enable",
          params: {
            hash: created.result.hash,
            directory: "drafts/http",
            scopes: [],
            confirm: true,
            allowExecution: true,
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          action: "materialize",
          params: { hash: created.result.hash, directory: "../outside", scopes: [], confirm: true },
        })
      ).status,
    ).toBe(400);
    expect(
      (await post({ action: "scaffold", params: { id: "x".repeat(140000), name: "oversize" } }))
        .status,
    ).toBe(413);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
