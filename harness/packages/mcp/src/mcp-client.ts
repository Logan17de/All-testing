import { spawn, type ChildProcess } from "node:child_process";

/**
 * Minimal Model Context Protocol client over the stdio transport.
 *
 * MCP's stdio transport is newline-delimited JSON-RPC 2.0: one message per
 * line, and a message may not contain an embedded newline. That is the whole
 * framing rule, so this client implements it directly rather than depending on
 * a vendor SDK that would pull a transitive dependency tree into the harness.
 *
 * Nothing here grants authority. A server's tools become ordinary tool
 * adapters that go through the same capability, approval and tracing path as
 * every other tool.
 */

/** Protocol revision this client negotiates. */
export const MCP_PROTOCOL_VERSION = "2025-06-18" as const;

export type McpErrorCode =
  | "spawn-failed"
  | "transport-closed"
  | "protocol-error"
  | "timeout"
  | "server-error"
  | "message-too-large"
  | "not-initialized";

const MCP_ERROR_MARKER: unique symbol = Symbol("zet-harness.mcp-error");

export class McpError extends Error {
  readonly code: McpErrorCode;
  /** JSON-RPC error code when the failure came from the server. */
  readonly rpcCode: number | undefined;

  constructor(code: McpErrorCode, message: string, rpcCode?: number) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.rpcCode = rpcCode;
    Object.defineProperty(this, MCP_ERROR_MARKER, { value: true, enumerable: false });
  }
}

export function isMcpError(value: unknown): value is McpError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[MCP_ERROR_MARKER] === true
  );
}

/**
 * Advisory hints an MCP server may attach to a tool.
 *
 * These are **claims by the server**, not guarantees. The harness records them
 * and may show them to a person, but never relaxes a safety decision because a
 * server said its tool was harmless.
 */
export interface McpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: McpToolAnnotations;
}

export interface McpCallResult {
  /** Text blocks the server returned, in order. */
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly isError: boolean;
}

export interface McpServerConfig {
  /** Executable to run. Never a shell command line. */
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Complete child environment; the harness environment is never inherited. */
  readonly env?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly maxMessageBytes?: number;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MESSAGE_BYTES = 4_194_304; // 4 MiB

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One connected MCP server process.
 *
 * The client owns the subprocess lifetime. `close()` is mandatory; a plugin
 * that registers MCP tools must attach it to the activation cleanup stack so
 * unloading the plugin does not leave an orphaned server running.
 */
export class McpStdioClient {
  readonly #config: McpServerConfig;
  readonly #pending = new Map<number, PendingRequest>();
  #child: ChildProcess | undefined;
  #buffer = "";
  #nextId = 1;
  #initialized = false;
  #closed = false;
  /** Retained so a transport failure can explain itself with server stderr. */
  #stderrTail = "";

  constructor(config: McpServerConfig) {
    if (typeof config.command !== "string" || config.command.length === 0) {
      throw new TypeError("MCP server command must be a non-empty string.");
    }
    this.#config = config;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Server stderr, kept only for diagnostics and never sent to a model. */
  get stderrTail(): string {
    return this.#stderrTail;
  }

  #failAllPending(error: McpError): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // A malformed line is the server's fault, not a reason to tear down every
      // in-flight request; skip it and keep reading.
      return;
    }
    if (!isRecord(message)) return;

    const id = message["id"];
    if (typeof id !== "number") {
      // Notifications and server-initiated requests are not handled by this
      // client; it deliberately exposes no server-callable surface.
      return;
    }

    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);

    const error = message["error"];
    if (isRecord(error)) {
      const rpcCode = typeof error["code"] === "number" ? error["code"] : undefined;
      const text = typeof error["message"] === "string" ? error["message"] : "MCP server error.";
      pending.reject(new McpError("server-error", text, rpcCode));
      return;
    }

    pending.resolve(message["result"]);
  }

  #onStdout(chunk: Buffer): void {
    const maxBytes = this.#config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.#buffer += chunk.toString("utf8");

    if (this.#buffer.length > maxBytes) {
      const error = new McpError("message-too-large", "MCP server exceeded the message limit.");
      this.#buffer = "";
      this.#failAllPending(error);
      void this.close();
      return;
    }

    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      this.#handleLine(line);
      newlineIndex = this.#buffer.indexOf("\n");
    }
  }

  /** Start the server process. Does not perform the MCP handshake. */
  start(): void {
    if (this.#child !== undefined) return;
    if (this.#closed) throw new McpError("transport-closed", "This client is already closed.");

    try {
      this.#child = spawn(this.#config.command, [...(this.#config.args ?? [])], {
        ...(this.#config.cwd === undefined ? {} : { cwd: this.#config.cwd }),
        env: { ...(this.#config.env ?? {}) },
        // No shell, ever: an MCP server is configured by argument vector so a
        // server name or argument cannot become a second command.
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      throw new McpError(
        "spawn-failed",
        error instanceof Error ? error.message : "MCP server could not be started.",
      );
    }

    // A dead child's stdin emits EPIPE. Without a listener that becomes an
    // unhandled 'error' event and takes down the harness process, so every
    // stream gets one.
    this.#child.stdin?.on("error", () => undefined);
    this.#child.stdout?.on("error", () => undefined);
    this.#child.stderr?.on("error", () => undefined);
    this.#child.stdout?.on("data", (chunk: Buffer) => {
      this.#onStdout(chunk);
    });
    this.#child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderrTail = `${this.#stderrTail}${chunk.toString("utf8")}`.slice(-4096);
    });
    this.#child.on("error", () => {
      this.#failAllPending(new McpError("transport-closed", "MCP server transport failed."));
    });
    this.#child.on("close", () => {
      this.#closed = true;
      this.#initialized = false;
      this.#failAllPending(new McpError("transport-closed", "MCP server exited."));
    });
  }

  #send(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    const child = this.#child;
    if (child === undefined || this.#closed) {
      return Promise.reject(new McpError("transport-closed", "MCP server is not running."));
    }

    const id = this.#nextId;
    this.#nextId += 1;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });

    if (payload.includes("\n")) {
      // Should be impossible from JSON.stringify, but the framing depends on it.
      return Promise.reject(new McpError("protocol-error", "Request contained a newline."));
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new McpError("timeout", `MCP request '${method}' timed out.`));
      }, this.#config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref?.();

      this.#pending.set(id, { resolve, reject, timer });
      child.stdin?.write(`${payload}\n`, (error) => {
        if (error) {
          this.#pending.delete(id);
          clearTimeout(timer);
          reject(new McpError("transport-closed", "Could not write to the MCP server."));
        }
      });
    });
  }

  #notify(method: string, params: Record<string, unknown> | undefined): void {
    const child = this.#child;
    if (child === undefined || this.#closed) return;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
    child.stdin?.write(`${payload}\n`, () => undefined);
  }

  /** Perform the MCP handshake. Must succeed before tools can be listed or called. */
  async initialize(clientName = "zet-harness", clientVersion = "0.1.0"): Promise<void> {
    if (this.#child === undefined) this.start();

    const result = await this.#send("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      // The harness exposes no roots, sampling or elicitation surface to a
      // server, so it advertises no client capabilities at all.
      capabilities: {},
      clientInfo: { name: clientName, version: clientVersion },
    });

    if (!isRecord(result)) {
      throw new McpError("protocol-error", "MCP initialize returned a non-object result.");
    }

    this.#initialized = true;
    this.#notify("notifications/initialized", undefined);
  }

  /** List the tools a server offers. */
  async listTools(): Promise<readonly McpToolDescriptor[]> {
    if (!this.#initialized) {
      throw new McpError("not-initialized", "MCP client must be initialized before listing tools.");
    }

    const result = await this.#send("tools/list", {});
    if (!isRecord(result) || !Array.isArray(result["tools"])) {
      throw new McpError("protocol-error", "MCP tools/list returned no tool array.");
    }

    const tools: McpToolDescriptor[] = [];
    for (const entry of result["tools"] as readonly unknown[]) {
      if (!isRecord(entry)) continue;
      const name = entry["name"];
      const inputSchema = entry["inputSchema"];
      if (typeof name !== "string" || name.length === 0) continue;
      if (!isRecord(inputSchema)) continue;

      const description = entry["description"];
      const annotations = entry["annotations"];
      tools.push(
        Object.freeze({
          name,
          ...(typeof description === "string" ? { description } : {}),
          inputSchema: Object.freeze({ ...inputSchema }),
          ...(isRecord(annotations) ? { annotations: Object.freeze({ ...annotations }) } : {}),
        }),
      );
    }
    return Object.freeze(tools);
  }

  /** Invoke one tool. Arguments are passed through untouched. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.#initialized) {
      throw new McpError("not-initialized", "MCP client must be initialized before calling tools.");
    }

    const result = await this.#send("tools/call", { name, arguments: args });
    if (!isRecord(result)) {
      throw new McpError("protocol-error", "MCP tools/call returned a non-object result.");
    }

    const rawContent = Array.isArray(result["content"]) ? result["content"] : [];
    const content = rawContent.filter(isRecord).map((block) =>
      Object.freeze({
        type: typeof block["type"] === "string" ? block["type"] : "unknown",
        ...(typeof block["text"] === "string" ? { text: block["text"] } : {}),
      }),
    );

    return Object.freeze({
      content: Object.freeze(content),
      // A tool reporting its own failure is data, not a transport fault.
      isError: result["isError"] === true,
    });
  }

  /** Stop the server process and fail anything still in flight. */
  async close(): Promise<void> {
    if (this.#closed && this.#child === undefined) return;
    this.#closed = true;
    this.#initialized = false;

    const child = this.#child;
    this.#child = undefined;
    this.#failAllPending(new McpError("transport-closed", "MCP client closed."));

    if (child === undefined) return;

    try {
      child.stdin?.end();
    } catch {
      // Already gone.
    }

    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        resolve();
      }, 2_000);
      timer.unref?.();
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
