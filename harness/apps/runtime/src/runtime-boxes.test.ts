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

interface ChatRequest {
  readonly model: string;
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
}

/**
 * An endpoint that answers `[model] <the prompt>`, so a chain of two models shows
 * both of them in the final text, and records the system text it was given.
 */
async function echoEndpoint(): Promise<{ readonly baseUrl: string; readonly systems: string[] }> {
  const systems: string[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(text) as ChatRequest;
      const say = (message: ChatRequest["messages"][number] | undefined): string =>
        typeof message?.content === "string" ? message.content : "";
      const system = body.messages.find((message) => message.role === "system");
      if (system !== undefined) systems.push(say(system));
      const prompt = say([...body.messages].reverse().find((message) => message.role === "user"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `[${body.model}] ${prompt}` },
              finish_reason: "stop",
            },
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
  return { baseUrl: `http://127.0.0.1:${String(port)}/v1`, systems };
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
      ...(writes && body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { send };
}

const model = (modelId: string, baseUrl: string) => ({
  modelId,
  title: modelId,
  profile: "llama-cpp",
  baseUrl,
  model: modelId,
  credential: "none",
  contextWindowTokens: 8_192,
});

const data = (id: string, from: string, fromPort: string, to: string, toPort: string) => ({
  id,
  kind: "data",
  from: { nodeId: from, port: fromPort },
  to: { nodeId: to, port: toPort },
});

function boxesGraph(text: string) {
  return {
    schemaVersion: 1,
    graphId: "boxes",
    revisionId: "rev-1",
    inputs: [],
    outputs: [{ id: "answer", schema: true, source: { nodeId: "show", port: "text" } }],
    nodes: [
      { id: "ask", type: "harness.text-box", version: "1", config: { text } },
      { id: "first", type: "harness.ask-model", version: "1", config: { modelId: "model-a" } },
      {
        id: "second",
        type: "harness.ask-model",
        version: "1",
        config: { modelId: "model-b", instructions: "Answer in one line." },
      },
      { id: "show", type: "harness.output-box", version: "1", config: {} },
    ],
    edges: [
      data("ask-to-first", "ask", "text", "first", "prompt"),
      data("first-to-second", "first", "text", "second", "prompt"),
      data("second-to-show", "second", "text", "show", "text"),
    ],
    entrypoints: [{ id: "main", nodeId: "ask" }],
    policies: {
      maxNodeExecutions: 10,
      maxParallelism: 1,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
  };
}

interface RunView {
  readonly status: string;
  readonly nodes: readonly { readonly nodeId: string; readonly opIndex: number }[];
  readonly attempts: readonly {
    readonly opIndex: number;
    readonly outputs: unknown;
    readonly error: unknown;
  }[];
}

async function settle(send: Awaited<ReturnType<typeof startDaemon>>["send"], runId: string) {
  const deadline = Date.now() + 15_000;
  let run: RunView = { status: "", nodes: [], attempts: [] };
  while (Date.now() < deadline) {
    run = (await send("GET", `/api/runs/${runId}`)).body["run"] as RunView;
    if (["completed", "failed", "cancelled"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return run;
}

/** The text a node put out, as its attempt recorded it. */
function textOf(run: RunView, nodeId: string): unknown {
  const opIndex = run.nodes.find((node) => node.nodeId === nodeId)?.opIndex;
  const outputs = [...run.attempts].reverse().find((attempt) => attempt.opIndex === opIndex)
    ?.outputs as { readonly text?: { readonly kind: string; readonly value: unknown } } | undefined;
  return outputs?.text?.kind === "inline" ? outputs.text.value : undefined;
}

describe("boxes: text in, text out", () => {
  it("runs a text box through two models into an output box", async () => {
    const endpoint = await echoEndpoint();
    const { send } = await startDaemon();
    expect((await send("POST", "/api/models", model("model-a", endpoint.baseUrl))).status).toBe(
      201,
    );
    expect((await send("POST", "/api/models", model("model-b", endpoint.baseUrl))).status).toBe(
      201,
    );

    const created = await send("POST", "/api/runs", { graph: boxesGraph("hello") });
    expect(created.status).toBe(201);
    const run = await settle(send, String(created.body["runId"]));

    expect(run.status).toBe("completed");
    // The first model's answer was the second model's prompt.
    expect(textOf(run, "first")).toBe("[model-a] hello");
    expect(textOf(run, "show")).toBe("[model-b] [model-a] hello");
    // Only the second model was given instructions.
    expect(endpoint.systems).toEqual(["Answer in one line."]);
  });

  it("says a model was given no text when the box is empty", async () => {
    const endpoint = await echoEndpoint();
    const { send } = await startDaemon();
    await send("POST", "/api/models", model("model-a", endpoint.baseUrl));
    await send("POST", "/api/models", model("model-b", endpoint.baseUrl));

    const created = await send("POST", "/api/runs", { graph: boxesGraph("   ") });
    const run = await settle(send, String(created.body["runId"]));

    expect(run.status).toBe("failed");
    const failed = run.attempts.find((attempt) => attempt.error !== null);
    expect(failed?.error).toMatchObject({ cause: { code: "AGENT_INPUT_MISSING" } });
  });
});
