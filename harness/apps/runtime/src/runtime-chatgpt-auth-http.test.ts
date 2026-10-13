import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createChatGPTAuthHttpHandler } from "./runtime-chatgpt-auth-http.js";
import { ChatGPTLoginController } from "./runtime-chatgpt-auth-http.js";
import { ChatGPTPlanAuth } from "./runtime-chatgpt-auth.js";
const hostId = "urn:uuid:11111111-1111-4111-8111-111111111111";
describe("ChatGPT login loopback controller (no real authorization)", () => {
  it("fails inactive without stable host configuration", async () => {
    const controller = new ChatGPTLoginController();
    expect(controller.status()).toEqual({ state: "disconnected" });
    await expect(controller.start()).rejects.toThrow("CHATGPT_HOST_ID_CONFIGURATION_REQUIRED");
    controller.close();
  });
  it("starts a local callback only on explicit action and handles denial without provider calls", async () => {
    const transport = vi.fn<typeof globalThis.fetch>();
    const controller = new ChatGPTLoginController({
      hostId,
      auth: new ChatGPTPlanAuth({ fetch: transport }),
    });
    try {
      const start = await controller.start();
      expect(start.memoryOnly).toBe(true);
      expect(start.callbackLocation).toBe("local-runtime-loopback");
      expect(controller.status().state).toBe("pending");
      const authorize = new URL(start.authorizationUrl);
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      expect(callback.hostname).toBe("127.0.0.1");
      const other = new URL("/unrelated", callback);
      expect((await fetch(other)).status).toBe(404);
      expect(controller.status().state).toBe("pending");
      callback.search = new URLSearchParams({
        state: authorize.searchParams.get("state")!,
        error: "access_denied",
      }).toString();
      const response = await fetch(callback);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("access_denied");
      expect(controller.status()).toEqual({ state: "error", errorCode: "CHATGPT_AUTH_DENIED" });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      controller.close();
    }
  });
  it("cancel stops callback and exposes no credentials", async () => {
    const controller = new ChatGPTLoginController({ hostId });
    try {
      await controller.start();
      expect(controller.cancel()).toEqual({ state: "disconnected" });
      expect(JSON.stringify(controller.status())).not.toContain("token");
    } finally {
      controller.close();
    }
  });
});

describe("explicit authenticated-runtime auth action contract", () => {
  it("routes read-only status, rejects GET login and non-search parameters", async () => {
    const controller = new ChatGPTLoginController();
    const handler = createChatGPTAuthHttpHandler({ controller });
    const server = createServer((request, response) => {
      void handler(request, response, new URL(request.url ?? "/", "http://127.0.0.1")).then(
        (matched) => {
          if (!matched) {
            response.writeHead(404);
            response.end();
          }
        },
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No listener");
      const base = `http://127.0.0.1:${address.port}`;
      expect(await (await fetch(`${base}/api/auth/chatgpt`)).json()).toEqual({
        state: "disconnected",
      });
      expect((await fetch(`${base}/api/auth/chatgpt/login`)).status).toBe(405);
      expect(
        await (await fetch(`${base}/api/auth/chatgpt/login`, { method: "POST" })).json(),
      ).toEqual({ error: "CHATGPT_HOST_ID_CONFIGURATION_REQUIRED" });
      expect(
        await (
          await fetch(`${base}/api/auth/chatgpt/search`, {
            method: "POST",
            body: JSON.stringify({ query: "query", tools: [{ type: "shell" }] }),
          })
        ).json(),
      ).toEqual({ error: "CODEX_SEARCH_MODEL_CONFIGURATION_REQUIRED" });
    } finally {
      controller.close();
      server.close();
      server.closeAllConnections();
    }
  });
});
