import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SQLITE_MEMORY_PATH } from "@zet-harness/db";

import { RuntimeDaemon } from "./runtime-daemon.js";
import { buildWorkflow } from "./runtime-workflows.js";

const daemons: RuntimeDaemon[] = [];
const servers: Server[] = [];
let savedGitHubApi: string | undefined;

beforeEach(() => {
  savedGitHubApi = process.env["GITHUB_API_URL"];
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
  if (savedGitHubApi === undefined) delete process.env["GITHUB_API_URL"];
  else process.env["GITHUB_API_URL"] = savedGitHubApi;
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

async function listen(
  handle: (request: IncomingMessage, body: string) => { status?: number; body: unknown },
): Promise<string> {
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const answer = handle(request, body);
      response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  return `http://127.0.0.1:${String(typeof address === "object" && address !== null ? address.port : 0)}`;
}

const completion = (message: Record<string, unknown>, finish: string) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "test-model",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

/** A model endpoint that answers from a script and remembers the tools it was offered. */
async function scriptedModel(script: readonly Record<string, unknown>[]) {
  const offered: string[][] = [];
  let turn = 0;
  const url = await listen((_request, body) => {
    const request = JSON.parse(body) as { tools?: { function: { name: string } }[] };
    offered.push((request.tools ?? []).map((tool) => tool.function.name));
    const next = script[turn] ?? completion({ content: "Done." }, "stop");
    turn += 1;
    return { body: next };
  });
  return { baseUrl: `${url}/v1`, offered };
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

  const conversation = async (modelUrl: string): Promise<string> => {
    await send("POST", "/api/models", {
      modelId: "test-model",
      title: "Test model",
      profile: "custom",
      baseUrl: modelUrl,
      model: "test-model",
      credential: "none",
      contextWindowTokens: 32_000,
    });
    const project = await send("POST", "/api/projects", { name: "Chat" });
    const projectId = (project.body["project"] as { readonly projectId: string }).projectId;
    const started = await send("POST", `/api/projects/${projectId}/conversations`, {
      title: "Hello",
    });
    return (started.body["conversation"] as { readonly conversationId: string }).conversationId;
  };

  const say = async (conversationId: string, text: string): Promise<void> => {
    await send("POST", `/api/conversations/${conversationId}/messages`, {
      role: "user",
      parts: [{ kind: "text", text }],
    });
  };

  const finish = async (runId: string): Promise<string> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const run = (await send("GET", `/api/runs/${runId}`)).body["run"] as {
        readonly status: string;
      };
      if (["completed", "failed", "cancelled", "waiting"].includes(run.status)) return run.status;
      if (Date.now() > deadline) return run.status;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const messages = async (conversationId: string) =>
    (await send("GET", `/api/conversations/${conversationId}`)).body["messages"] as {
      readonly role: string;
      readonly parts: readonly Record<string, unknown>[];
    }[];

  return { send, conversation, say, finish, messages };
}

describe("ready-made workflows", () => {
  it("lists the workflows, and gives the editor the graph a conversation would run", async () => {
    const { send } = await startDaemon();
    const listed = await send("GET", "/api/workflows");
    expect(listed.body["workflows"]).toEqual([
      expect.objectContaining({ id: "chat", title: "Chat", available: true }),
      expect.objectContaining({ id: "chat-github", title: "Chat with GitHub", available: true }),
    ]);

    const conversationId = "01890a5d-ac96-774b-bcce-b302099a8057";
    const graph = await send("GET", `/api/workflows/chat-github?conversationId=${conversationId}`);
    expect(graph.body["graph"]).toEqual(buildWorkflow("chat-github", conversationId));
    expect((await send("GET", "/api/workflows/unknown")).status).toBe(404);
  });

  it("answers a conversation with the Chat workflow", async () => {
    const model = await scriptedModel([completion({ content: "Hello! How can I help?" }, "stop")]);
    const { send, conversation, say, finish, messages } = await startDaemon();
    const conversationId = await conversation(model.baseUrl);
    await say(conversationId, "Hi there");

    const reply = await send("POST", `/api/conversations/${conversationId}/reply`, {
      workflow: "chat",
    });
    expect(reply.status).toBe(201);
    expect(await finish(String(reply.body["runId"]))).toBe("completed");

    const branch = await messages(conversationId);
    expect(branch.at(-1)).toMatchObject({
      role: "assistant",
      parts: [{ kind: "text", text: "Hello! How can I help?" }],
    });
    // A plain chat hands the model no GitHub tools.
    expect(model.offered[0]?.some((name) => name.startsWith("github_"))).toBe(false);
    expect(model.offered[0]).toContain("harness_goals_list");
  });

  it("answers with GitHub when the GitHub component is wired in", async () => {
    const githubRequests: string[] = [];
    process.env["GITHUB_API_URL"] = await listen((request) => {
      githubRequests.push(request.url ?? "");
      return {
        body: {
          full_name: "acme/rockets",
          description: "Rockets.",
          default_branch: "main",
          stargazers_count: 12,
          open_issues_count: 3,
          html_url: "https://github.com/acme/rockets",
        },
      };
    });
    const model = await scriptedModel([
      completion(
        {
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "github_repo_get",
                arguments: JSON.stringify({ owner: "acme", repo: "rockets" }),
              },
            },
          ],
        },
        "tool_calls",
      ),
      completion({ content: "acme/rockets has 12 stars." }, "stop"),
    ]);
    const { send, conversation, say, finish, messages } = await startDaemon();
    const conversationId = await conversation(model.baseUrl);
    await say(conversationId, "How popular is acme/rockets?");

    const reply = await send("POST", `/api/conversations/${conversationId}/reply`, {
      workflow: "chat-github",
    });
    expect(reply.status).toBe(201);
    expect(await finish(String(reply.body["runId"]))).toBe("completed");

    expect(model.offered[0]).toEqual(
      expect.arrayContaining([
        "github_repo_get",
        "github_issues_list",
        "github_issue_get",
        "github_pulls_list",
        "github_file_get",
      ]),
    );
    expect(githubRequests).toEqual(["/repos/acme/rockets"]);
    const branch = await messages(conversationId);
    const toolResult = branch
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.parts)[0];
    expect(toolResult).toMatchObject({
      kind: "tool-result",
      value: { ok: true, repository: { name: "acme/rockets", stars: 12 } },
    });
    expect(branch.at(-1)).toMatchObject({
      role: "assistant",
      parts: [{ kind: "text", text: "acme/rockets has 12 stars." }],
    });
  });

  it("refuses a reply it cannot start", async () => {
    const { send, conversation } = await startDaemon();
    const conversationId = await conversation("http://127.0.0.1:1/v1");

    expect(
      (await send("POST", `/api/conversations/${conversationId}/reply`, { workflow: "nope" }))
        .status,
    ).toBe(404);
    expect(
      (await send("POST", `/api/conversations/${conversationId}/reply`, { colour: "blue" })).status,
    ).toBe(400);
    expect(
      (
        await send("POST", "/api/conversations/01890a5d-ac96-774b-bcce-b302099a8057/reply", {
          workflow: "chat",
        })
      ).status,
    ).toBe(404);
  });
});
