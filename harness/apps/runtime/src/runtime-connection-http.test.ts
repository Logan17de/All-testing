import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SQLITE_MEMORY_PATH } from "@zet-harness/db";

import { RuntimeDaemon } from "./runtime-daemon.js";

const daemons: RuntimeDaemon[] = [];
const servers: Server[] = [];
let savedUrl: string | undefined;

beforeEach(() => {
  savedUrl = process.env["OPENROUTER_URL"];
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  if (savedUrl === undefined) delete process.env["OPENROUTER_URL"];
  else process.env["OPENROUTER_URL"] = savedUrl;
});

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => {
      resolve(text);
    });
  });
}

/**
 * A stand-in for OpenRouter: it issues a key only for the code it handed out and
 * only when the verifier matches the challenge the sign-in started with.
 */
async function fakeOpenRouter() {
  const state = { challenge: "", authorizations: [] as string[] };
  const server = createServer((request, response) => {
    void readBody(request).then((text) => {
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.url === "/api/v1/auth/keys" && request.method === "POST") {
        const body = JSON.parse(text) as {
          code: string;
          code_verifier: string;
          code_challenge_method: string;
        };
        const proof = createHash("sha256").update(body.code_verifier).digest("base64url");
        if (
          body.code !== "code-123" ||
          body.code_challenge_method !== "S256" ||
          proof !== state.challenge
        ) {
          reply(403, { error: { message: "Invalid code" } });
          return;
        }
        reply(200, { key: "sk-or-test-key" });
        return;
      }
      if (request.url === "/api/v1/models") {
        reply(200, {
          data: [
            {
              id: "x-ai/grok-4",
              name: "xAI: Grok 4",
              context_length: 256_000,
              supported_parameters: ["tools", "max_tokens"],
            },
            {
              id: "anthropic/claude-sonnet-4",
              name: "Anthropic: Claude Sonnet 4",
              context_length: 200_000,
              supported_parameters: ["tools"],
            },
            { id: "some/text-only", name: "No tools", supported_parameters: ["max_tokens"] },
          ],
        });
        return;
      }
      if (request.url === "/api/v1/chat/completions") {
        state.authorizations.push(request.headers.authorization ?? "");
        reply(200, {
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1,
          model: "anthropic/claude-sonnet-4",
          choices: [
            { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
        return;
      }
      reply(404, {});
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  const url = `http://127.0.0.1:${String(typeof address === "object" && address !== null ? address.port : 0)}`;
  return { url, state };
}

async function startDaemon() {
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path: SQLITE_MEMORY_PATH },
    probePathLimits: false,
    plugins: {},
  });
  daemons.push(daemon);
  await daemon.start();
  const base = `http://127.0.0.1:${String(daemon.snapshot().api.port)}`;
  const send = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> => {
    const writes = method !== "GET";
    const csrf = writes
      ? ((await (await fetch(`${base}/api/session`)).json()) as { readonly csrfToken: string })
          .csrfToken
      : undefined;
    const response = await fetch(`${base}${path}`, {
      method,
      headers: writes ? { "content-type": "application/json", "x-zet-csrf": csrf ?? "" } : {},
      ...(writes ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { send };
}

describe("signing in to OpenRouter", () => {
  it("exchanges the code for a key with PKCE, and every OpenRouter model uses it", async () => {
    const openRouter = await fakeOpenRouter();
    process.env["OPENROUTER_URL"] = openRouter.url;
    const { send } = await startDaemon();

    expect((await send("GET", "/api/connections")).body["connections"]).toEqual([
      expect.objectContaining({ provider: "openrouter", connected: false, models: 0 }),
    ]);

    const started = await send("POST", "/api/connections/openrouter/start", {
      callbackUrl: "http://localhost:3000/models/openrouter",
    });
    expect(started.status).toBe(200);
    const authorize = new URL(String(started.body["authorizeUrl"]));
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${openRouter.url}/auth`);
    expect(authorize.searchParams.get("callback_url")).toBe(
      "http://localhost:3000/models/openrouter",
    );
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("key_label")).toBe("Zet Harness");
    openRouter.state.challenge = authorize.searchParams.get("code_challenge") ?? "";

    const completed = await send("POST", "/api/connections/openrouter/complete", {
      code: "code-123",
    });
    expect(completed.status).toBe(200);
    expect(completed.body["connection"]).toMatchObject({
      connected: true,
      apiBaseUrl: `${openRouter.url}/api/v1`,
    });
    expect(JSON.stringify(completed.body)).not.toContain("sk-or-test-key");

    // The OpenRouter key goes to OpenRouter and nowhere else.
    const elsewhere = await send("POST", "/api/models", {
      modelId: "stolen",
      title: "Stolen",
      profile: "openrouter",
      baseUrl: "https://evil.example/api/v1",
      model: "anthropic/claude-sonnet-4",
      credential: "connection",
      connection: "openrouter",
      contextWindowTokens: 200_000,
    });
    expect(elsewhere).toMatchObject({
      status: 400,
      body: { error: { code: "MODEL_CONFIG_INVALID" } },
    });

    const saved = await send("POST", "/api/models", {
      modelId: "claude",
      title: "Claude Sonnet",
      profile: "openrouter",
      baseUrl: `${openRouter.url}/api/v1`,
      model: "anthropic/claude-sonnet-4",
      credential: "connection",
      connection: "openrouter",
      contextWindowTokens: 200_000,
    });
    expect(saved.status).toBe(201);
    expect((await send("GET", "/api/connections")).body["connections"]).toEqual([
      expect.objectContaining({ connected: true, models: 1 }),
    ]);

    expect((await send("POST", "/api/models/claude/check")).body["check"]).toMatchObject({
      ok: true,
    });
    expect(openRouter.state.authorizations).toEqual(["Bearer sk-or-test-key"]);

    // Signing out leaves the model configured but without a key.
    const signedOut = await send("POST", "/api/connections/openrouter/sign-out");
    expect(signedOut.body["connection"]).toMatchObject({ connected: false, models: 1 });
    expect((await send("POST", "/api/models/claude/check")).body["check"]).toMatchObject({
      ok: false,
      code: "MODEL_CREDENTIAL_UNAVAILABLE",
    });
  });

  it("lists only the OpenRouter models that can call tools", async () => {
    const openRouter = await fakeOpenRouter();
    process.env["OPENROUTER_URL"] = openRouter.url;
    const { send } = await startDaemon();

    expect((await send("GET", "/api/connections/openrouter/models")).body["models"]).toEqual([
      {
        id: "anthropic/claude-sonnet-4",
        name: "Anthropic: Claude Sonnet 4",
        contextLength: 200_000,
      },
      { id: "x-ai/grok-4", name: "xAI: Grok 4", contextLength: 256_000 },
    ]);
  });

  it("refuses a sign-in it did not start, one that returns elsewhere, and a code used twice", async () => {
    const openRouter = await fakeOpenRouter();
    process.env["OPENROUTER_URL"] = openRouter.url;
    const { send } = await startDaemon();

    const unstarted = await send("POST", "/api/connections/openrouter/complete", {
      code: "code-123",
    });
    expect(unstarted.status).toBe(409);

    for (const callbackUrl of [
      "https://evil.example/steal",
      "javascript:alert(1)",
      "http://user:pw@localhost:3000/",
    ]) {
      expect(
        (await send("POST", "/api/connections/openrouter/start", { callbackUrl })).status,
      ).toBe(400);
    }

    // A wrong code is refused by OpenRouter, and the attempt is spent.
    const started = await send("POST", "/api/connections/openrouter/start", {
      callbackUrl: "http://127.0.0.1:3000/models/openrouter",
    });
    openRouter.state.challenge =
      new URL(String(started.body["authorizeUrl"])).searchParams.get("code_challenge") ?? "";
    const wrong = await send("POST", "/api/connections/openrouter/complete", { code: "nope" });
    expect(wrong).toMatchObject({ status: 502, body: { error: { code: "CONNECTION_REFUSED" } } });
    const again = await send("POST", "/api/connections/openrouter/complete", {
      code: "code-123",
    });
    expect(again.status).toBe(409);
    expect((await send("GET", "/api/connections")).body["connections"]).toEqual([
      expect.objectContaining({ connected: false }),
    ]);
  });
});
