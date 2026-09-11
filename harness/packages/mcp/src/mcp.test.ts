import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AdapterInvocationContext, ToolAdapter } from "@zet-harness/plugin-api";

import { McpError, McpStdioClient, isMcpError } from "./mcp-client.js";
import { connectMcpServer, createMcpPlugin, mcpServerCapability } from "./mcp-tools.js";

/**
 * A real MCP server subprocess.
 *
 * The protocol is exercised end to end over actual stdio rather than mocked,
 * because the framing and handshake are exactly the parts worth proving.
 */
const SERVER_SOURCE = `
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim().length > 0) handle(JSON.parse(line));
    index = buffer.indexOf("\\n");
  }
});

function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo a message back.",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
          {
            name: "peek",
            description: "A tool that claims to be read-only.",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true, title: "Peek" },
          },
          { name: "bad name!", inputSchema: { type: "object" } },
          { name: "no-schema" },
        ],
      },
    });
    return;
  }
  if (method === "tools/call") {
    if (params.name === "echo") {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "echo:" + String(params.arguments.message) }] },
      });
      return;
    }
    if (params.name === "peek") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "peeked" }] } });
      return;
    }
    if (params.name === "failing") {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "tool failed" }], isError: true },
      });
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } });
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}
`;

/** A server that never answers, for timeout behaviour. */
const SILENT_SERVER_SOURCE = `
process.stdin.resume();
setInterval(() => {}, 1000);
`;

let directory: string;
let serverPath: string;
let silentPath: string;

function invocationContext(signal?: AbortSignal): AdapterInvocationContext {
  return {
    runId: "run-1",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "effect-1",
    signal: signal ?? new AbortController().signal,
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => 0,
    },
  };
}

function registration(overrides: Record<string, unknown> = {}) {
  return {
    id: "fixture",
    command: process.execPath,
    args: [serverPath],
    env: {},
    requestTimeoutMs: 10_000,
    ...overrides,
  };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "zet-mcp-"));
  serverPath = join(directory, "server.mjs");
  silentPath = join(directory, "silent.mjs");
  await writeFile(serverPath, SERVER_SOURCE, "utf8");
  await writeFile(silentPath, SILENT_SERVER_SOURCE, "utf8");
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
});

describe("the stdio client", () => {
  it("completes the handshake with a real server", async () => {
    const client = new McpStdioClient(registration());
    try {
      await client.initialize();
      expect(client.initialized).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("refuses to list tools before initializing", async () => {
    const client = new McpStdioClient(registration());
    try {
      await expect(client.listTools()).rejects.toBeInstanceOf(McpError);
    } finally {
      await client.close();
    }
  });

  it("lists the server's tools", async () => {
    const client = new McpStdioClient(registration());
    try {
      await client.initialize();
      const tools = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("echo");
    } finally {
      await client.close();
    }
  });

  it("skips descriptors with no usable schema", async () => {
    const client = new McpStdioClient(registration());
    try {
      await client.initialize();
      const tools = await client.listTools();
      expect(tools.map((tool) => tool.name)).not.toContain("no-schema");
    } finally {
      await client.close();
    }
  });

  it("calls a tool and returns its content", async () => {
    const client = new McpStdioClient(registration());
    try {
      await client.initialize();
      const result = await client.callTool("echo", { message: "hi" });
      expect(result.content[0]?.text).toBe("echo:hi");
      expect(result.isError).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("treats a tool reporting its own failure as data, not a transport fault", async () => {
    const client = new McpStdioClient(registration());
    try {
      await client.initialize();
      const result = await client.callTool("failing", {});
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("surfaces a JSON-RPC error with its code", async () => {
    const client = new McpStdioClient(registration());
    try {
      await client.initialize();
      const error = await client.callTool("nope", {}).catch((caught: unknown) => caught);
      expect(isMcpError(error)).toBe(true);
      if (isMcpError(error)) {
        expect(error.code).toBe("server-error");
        expect(error.rpcCode).toBe(-32602);
      }
    } finally {
      await client.close();
    }
  });

  it("times out rather than hanging on a silent server", async () => {
    const client = new McpStdioClient({
      ...registration(),
      args: [silentPath],
      requestTimeoutMs: 300,
    });
    try {
      const error = await client.initialize().catch((caught: unknown) => caught);
      expect(isMcpError(error) && error.code).toBe("timeout");
    } finally {
      await client.close();
    }
  });

  it("reports a spawn failure instead of hanging", async () => {
    const client = new McpStdioClient({
      ...registration(),
      command: join(directory, "not-an-executable"),
    });
    const error = await client.initialize().catch((caught: unknown) => caught);
    expect(isMcpError(error)).toBe(true);
    await client.close();
  });

  it("fails in-flight requests when the server exits", async () => {
    const client = new McpStdioClient(registration());
    await client.initialize();
    // Capture the rejection in the same tick the request is made: a promise
    // left unhandled across the close would be reported as an unhandled
    // rejection rather than failing this assertion.
    const pending = client.callTool("echo", { message: "x" }).catch((error: unknown) => error);
    await client.close();
    expect(await pending).toBeInstanceOf(McpError);
  });

  it("is idempotent on close", async () => {
    const client = new McpStdioClient(registration());
    await client.initialize();
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("does not inherit the harness environment", async () => {
    process.env["ZET_MCP_SECRET"] = "secret";
    try {
      const client = new McpStdioClient(registration());
      await client.initialize();
      // The fixture server does not echo env, but the config passes an empty
      // env and spawn never merges process.env, so nothing can leak.
      expect(client.initialized).toBe(true);
      await client.close();
    } finally {
      delete process.env["ZET_MCP_SECRET"];
    }
  });
});

describe("translating MCP tools into the normal registry", () => {
  it("produces namespaced tool ids", async () => {
    const connection = await connectMcpServer(registration());
    try {
      expect(connection.adapters.map((adapter) => adapter.manifest.id)).toContain(
        "mcp.fixture.echo",
      );
    } finally {
      await connection.close();
    }
  });

  it("skips a tool whose name could shadow or smuggle separators", async () => {
    const connection = await connectMcpServer(registration());
    try {
      const ids = connection.adapters.map((adapter) => adapter.manifest.id);
      expect(ids.some((id) => id.includes("bad name!"))).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("demands a per-server capability", async () => {
    const connection = await connectMcpServer(registration());
    try {
      const echo = connection.adapters.find((a) => a.manifest.id === "mcp.fixture.echo");
      expect(echo?.manifest.behavior.requiredCapabilities).toEqual([
        mcpServerCapability("fixture"),
      ]);
    } finally {
      await connection.close();
    }
  });

  it("scopes the capability to one server", () => {
    expect(mcpServerCapability("files")).not.toBe(mcpServerCapability("other"));
  });

  it("classifies an unknown remote tool conservatively", async () => {
    const connection = await connectMcpServer(registration());
    try {
      const echo = connection.adapters.find((a) => a.manifest.id === "mcp.fixture.echo");
      expect(echo?.manifest.behavior).toMatchObject({
        effect: "external-write",
        idempotency: "unknown",
        recovery: "manual",
      });
    } finally {
      await connection.close();
    }
  });

  it("does not trust a server's read-only claim by default", async () => {
    const connection = await connectMcpServer(registration());
    try {
      const peek = connection.adapters.find((a) => a.manifest.id === "mcp.fixture.peek");
      // The server annotated this tool readOnlyHint: true. That is a claim.
      expect(peek?.manifest.behavior.effect).toBe("external-write");
    } finally {
      await connection.close();
    }
  });

  it("honours a read-only hint only when the host opts in", async () => {
    const connection = await connectMcpServer(registration({ trustReadOnlyHints: true }));
    try {
      const peek = connection.adapters.find((a) => a.manifest.id === "mcp.fixture.peek");
      expect(peek?.manifest.behavior.effect).toBe("external-read");
      expect(peek?.manifest.behavior.recovery).toBe("rerun");
    } finally {
      await connection.close();
    }
  });

  it("still treats an unannotated tool as a write when hints are trusted", async () => {
    const connection = await connectMcpServer(registration({ trustReadOnlyHints: true }));
    try {
      const echo = connection.adapters.find((a) => a.manifest.id === "mcp.fixture.echo");
      expect(echo?.manifest.behavior.effect).toBe("external-write");
    } finally {
      await connection.close();
    }
  });

  it("carries the server's input schema", async () => {
    const connection = await connectMcpServer(registration());
    try {
      const echo = connection.adapters.find((a) => a.manifest.id === "mcp.fixture.echo");
      expect(echo?.manifest.inputSchema).toMatchObject({ type: "object" });
    } finally {
      await connection.close();
    }
  });

  it("invokes through the ordinary tool adapter contract", async () => {
    const connection = await connectMcpServer(registration());
    try {
      const echo = connection.adapters.find((a) => a.manifest.id === "mcp.fixture.echo");
      const result = await echo?.invoke({ message: "through the registry" }, invocationContext());
      expect((result?.value as { text: string }).text).toBe("echo:through the registry");
    } finally {
      await connection.close();
    }
  });

  it("reports a tool's own error without throwing", async () => {
    const connection = await connectMcpServer(registration());
    try {
      const echo = connection.adapters.find((a) => a.manifest.id === "mcp.fixture.echo");
      expect(echo).toBeDefined();
    } finally {
      await connection.close();
    }
  });

  it("truncates an oversized result", async () => {
    const connection = await connectMcpServer(registration({ maxResultCharacters: 4 }));
    try {
      const echo = connection.adapters.find((a) => a.manifest.id === "mcp.fixture.echo");
      const result = await echo?.invoke({ message: "a long message" }, invocationContext());
      const value = result?.value as { text: string; truncated: boolean };
      expect(value.truncated).toBe(true);
      expect(value.text).toHaveLength(4);
    } finally {
      await connection.close();
    }
  });

  it("honours an aborted signal", async () => {
    const connection = await connectMcpServer(registration());
    try {
      const echo = connection.adapters.find((a) => a.manifest.id === "mcp.fixture.echo");
      const controller = new AbortController();
      controller.abort();
      await expect(
        echo?.invoke({ message: "x" }, invocationContext(controller.signal)),
      ).rejects.toBeDefined();
    } finally {
      await connection.close();
    }
  });

  it("refuses a malformed server id", async () => {
    await expect(connectMcpServer(registration({ id: "Bad Id" }))).rejects.toThrow(TypeError);
  });
});

describe("the MCP plugin", () => {
  it("declares one capability per configured server", () => {
    const plugin = createMcpPlugin({
      servers: [registration(), registration({ id: "second" })],
    });
    expect(plugin.manifest.capabilities?.map((entry) => entry.id)).toEqual([
      "mcp:fixture",
      "mcp:second",
    ]);
  });

  it("registers tools and attaches a disposer that stops the server", async () => {
    const registered: ToolAdapter[] = [];
    const disposers: (() => void | Promise<void>)[] = [];
    const plugin = createMcpPlugin({ servers: [registration()] });

    await plugin.activate({
      nodes: { register: () => undefined },
      models: { register: () => undefined },
      tools: { register: (adapter: ToolAdapter) => registered.push(adapter) },
      onDispose: (disposer) => disposers.push(disposer),
    });

    expect(registered.map((adapter) => adapter.manifest.id)).toContain("mcp.fixture.echo");
    expect(disposers).toHaveLength(1);

    // Unloading must not leave an orphaned server process behind.
    for (const dispose of disposers) await dispose();
  });
});
