import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { SQLITE_MEMORY_PATH } from "@zet-harness/db";

import { RuntimeDaemon } from "./runtime-daemon.js";

const daemons: RuntimeDaemon[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** A tiny OpenAI-compatible endpoint that records what it was asked. */
async function fakeEndpoint(): Promise<{
  readonly baseUrl: string;
  readonly authorizations: string[];
}> {
  const authorizations: string[] = [];
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? "");
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1,
          model: "test-model",
          choices: [
            { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${String(port)}/v1`, authorizations };
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
  const send = async (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Reply> => {
    const writes = method !== "GET";
    const csrf = writes
      ? ((await (await fetch(`${base}/api/session`)).json()) as { readonly csrfToken: string })
          .csrfToken
      : undefined;
    const response = await fetch(`${base}${path}`, {
      method,
      headers: writes ? { "content-type": "application/json", "x-zet-csrf": csrf ?? "" } : {},
      ...(writes && body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { daemon, send };
}

const LOCAL_MODEL = {
  modelId: "local-llama",
  title: "Local llama",
  profile: "llama-cpp",
  baseUrl: "http://127.0.0.1:8080/v1",
  model: "llama3.1:8b",
  contextWindowTokens: 32_000,
};

describe("the models a person configures", () => {
  it("configures, lists, changes and forgets a model without ever returning its key", async () => {
    const { send } = await startDaemon();

    const created = await send("POST", "/api/models", {
      ...LOCAL_MODEL,
      profile: "openai",
      baseUrl: "https://api.example.com/v1",
      credential: "stored",
      apiKey: "sk-secret-value",
    });
    expect(created.status).toBe(201);
    expect(created.body["model"]).toMatchObject({
      modelId: "local-llama",
      credential: "stored",
      tools: true,
      streaming: false,
    });
    expect(JSON.stringify(created.body)).not.toContain("sk-secret-value");

    const listed = await send("GET", "/api/models");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain("sk-secret-value");
    expect((listed.body["models"] as { readonly modelId: string }[]).map((m) => m.modelId)).toEqual(
      ["local-llama"],
    );

    // Changing the endpoint without naming a key again keeps the stored one.
    const changed = await send("PATCH", "/api/models/local-llama", {
      ...LOCAL_MODEL,
      profile: "openai",
      baseUrl: "https://api.example.com/v2",
      credential: "stored",
      title: "Example model",
    });
    expect(changed.status).toBe(200);
    expect(changed.body["model"]).toMatchObject({
      title: "Example model",
      baseUrl: "https://api.example.com/v2",
      credential: "stored",
    });

    expect((await send("DELETE", "/api/models/local-llama")).status).toBe(200);
    expect((await send("GET", "/api/models/local-llama")).status).toBe(404);
  });

  it("refuses a configuration the harness would not be able to honour", async () => {
    const { send } = await startDaemon();

    const badId = await send("POST", "/api/models", { ...LOCAL_MODEL, modelId: "Local Llama" });
    expect(badId.status).toBe(400);
    expect(badId.body["error"]).toMatchObject({ code: "MODEL_CONFIG_INVALID", field: "modelId" });

    // A key is never sent in the clear to another machine.
    const clearKey = await send("POST", "/api/models", {
      ...LOCAL_MODEL,
      baseUrl: "http://models.example.com/v1",
      credential: "stored",
      apiKey: "sk-secret-value",
    });
    expect(clearKey.status).toBe(400);
    expect(clearKey.body["error"]).toMatchObject({ field: "baseUrl" });

    const unknownField = await send("POST", "/api/models", { ...LOCAL_MODEL, apiToken: "x" });
    expect(unknownField.status).toBe(400);

    expect((await send("POST", "/api/models", LOCAL_MODEL)).status).toBe(201);
    expect((await send("POST", "/api/models", LOCAL_MODEL)).status).toBe(409);
  });

  it("calls the endpoint with the stored key when a model is checked", async () => {
    const endpoint = await fakeEndpoint();
    const { send } = await startDaemon();

    const created = await send("POST", "/api/models", {
      ...LOCAL_MODEL,
      profile: "custom",
      baseUrl: endpoint.baseUrl,
      credential: "stored",
      apiKey: "sk-local-key",
    });
    expect(created.status).toBe(201);

    const checked = await send("POST", "/api/models/local-llama/check");
    expect(checked.status).toBe(200);
    expect(checked.body["check"]).toMatchObject({ ok: true });
    expect(endpoint.authorizations).toEqual(["Bearer sk-local-key"]);
  });

  it("lets an agent step use a configured model, with its key", async () => {
    const endpoint = await fakeEndpoint();
    const { send } = await startDaemon();
    expect(
      (
        await send("POST", "/api/models", {
          ...LOCAL_MODEL,
          profile: "custom",
          baseUrl: endpoint.baseUrl,
          credential: "stored",
          apiKey: "sk-agent-key",
        })
      ).status,
    ).toBe(201);

    const project = await send("POST", "/api/projects", { name: "Chat" });
    const projectId = (project.body["project"] as { readonly projectId: string }).projectId;
    const started = await send("POST", `/api/projects/${projectId}/conversations`, {
      title: "Hello",
    });
    const conversationId = (started.body["conversation"] as { readonly conversationId: string })
      .conversationId;
    await send("POST", `/api/conversations/${conversationId}/messages`, {
      role: "user",
      parts: [{ kind: "text", text: "Say pong." }],
    });

    const created = await send("POST", "/api/runs", {
      graph: {
        schemaVersion: 1,
        graphId: "chat",
        revisionId: "rev-1",
        inputs: [],
        outputs: [{ id: "result", schema: true, source: { nodeId: "think", port: "again" } }],
        nodes: [
          {
            id: "think",
            type: "harness.agent-model",
            version: "1",
            config: {
              conversationId,
              systemPrompt: "You are helpful.",
              reserveOutputTokens: 256,
              modelId: "local-llama",
            },
          },
        ],
        edges: [],
        entrypoints: [{ id: "main", nodeId: "think" }],
        policies: {
          maxNodeExecutions: 5,
          maxParallelism: 1,
          capabilities: { required: [], optional: [], deny: [] },
        },
        options: { defaultEntrypoint: "main" },
      },
    });
    expect(created.status).toBe(201);
    const runId = String(created.body["runId"]);

    const deadline = Date.now() + 15_000;
    let status = "";
    while (Date.now() < deadline) {
      const run = (await send("GET", `/api/runs/${runId}`)).body["run"] as {
        readonly status: string;
      };
      status = run.status;
      if (["completed", "failed", "cancelled"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status).toBe("completed");

    // The model a person configured answered, and it was sent the key they stored.
    expect(endpoint.authorizations).toEqual(["Bearer sk-agent-key"]);
    const read = await send("GET", `/api/conversations/${conversationId}`);
    const messages = read.body["messages"] as {
      readonly role: string;
      readonly parts: readonly { readonly text?: string }[];
    }[];
    expect(messages.at(-1)).toMatchObject({ role: "assistant", parts: [{ text: "pong" }] });
    // And the key appears nowhere in what the run recorded.
    const events = await send("GET", `/api/runs/${runId}`);
    expect(JSON.stringify(events.body)).not.toContain("sk-agent-key");
  });

  it("says what went wrong when an endpoint does not answer", async () => {
    const { send } = await startDaemon();
    // Port 1 on loopback has nothing listening, so this fails without leaving the machine.
    await send("POST", "/api/models", { ...LOCAL_MODEL, baseUrl: "http://127.0.0.1:1/v1" });

    const checked = await send("POST", "/api/models/local-llama/check");
    expect(checked.status).toBe(200);
    expect(checked.body["check"]).toMatchObject({ ok: false });
    expect((checked.body["check"] as { readonly code: string }).code.length).toBeGreaterThan(0);
  });
});
