import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { validateMcpFormContent } from "@zet-harness/plugin-api/mcp-elicitation";
import { CODEX_DYNAMIC_TOOLS, executeCodexDynamicTool } from "./runtime-codex-dynamic-tools.js";
import { buildCodexWorkspacePermissionGrant } from "./runtime-codex-permissions.js";

export type CodexDecision = "accept" | "decline" | "cancel";
export interface CodexEvent {
  sequence: number;
  method: string;
  params: unknown;
}
export interface CodexApproval {
  id: string | number;
  method: string;
  params: unknown;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export interface CodexServiceOptions {
  cwd: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  spawnProcess?: () => ChildProcessWithoutNullStreams;
}
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
]);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const fail = () => new Error("Codex app-server unavailable or protocol request failed.");

/** Official app-server JSONL transport. No credentials are read, returned, or persisted here. */
export class RuntimeCodexService extends EventEmitter {
  readonly #options: CodexServiceOptions;
  #scope = "";
  #scopeGeneration = 0;
  #requestGeneration = 0;
  #child: ChildProcessWithoutNullStreams | undefined;
  #ready: Promise<void> | undefined;
  #buffer = "";
  #nextId = 0;
  #sequence = 0;
  #pending = new Map<number, Pending>();
  #approvals = new Map<string | number, CodexApproval>();
  #events: CodexEvent[] = [];
  #closed = false;
  #threads = new Map<string, "read-only" | "workspace-write">();
  #dynamicThreads = new Set<string>();
  constructor(options: CodexServiceOptions) {
    super();
    this.#options = options;
  }
  #syncScope(): void {
    const scope = resolve(this.#options.cwd);
    if (!this.#scope) {
      this.#scope = scope;
      return;
    }
    if (scope === this.#scope) return;
    this.#stop();
    this.#events = [];
    this.#scope = scope;
    this.#scopeGeneration += 1;
  }
  snapshot(since = 0) {
    this.#syncScope();
    return {
      available: this.#child !== undefined,
      scopeGeneration: this.#scopeGeneration,
      requestGeneration: this.#requestGeneration,
      cursor: this.#sequence,
      events: this.#events.filter((event) => event.sequence > since),
      pendingApprovals: [...this.#approvals.values()],
    };
  }
  async #start(): Promise<void> {
    if (this.#closed) throw fail();
    if (this.#ready) return this.#ready;
    this.#ready = (async () => {
      const child =
        this.#options.spawnProcess?.() ??
        spawn(this.#options.command ?? "codex", this.#options.args ?? ["app-server", "--stdio"], {
          cwd: this.#scope,
          stdio: "pipe",
        });
      this.#child = child;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (this.#child === child) this.#consume(chunk);
      });
      child.stderr.resume(); // Private provider diagnostics must never enter API responses or logs.
      child.on("error", () => {
        if (this.#child === child) this.#stop();
      });
      child.on("exit", () => {
        if (this.#child === child) this.#stop();
      });
      await this.#request("initialize", {
        clientInfo: { name: "zet_harness", title: "Z harness", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      this.#write({ method: "initialized" });
    })();
    const startup = this.#ready;
    try {
      await startup;
    } catch {
      if (this.#ready === startup) this.#stop();
      throw fail();
    }
  }
  #write(value: unknown): void {
    if (!this.#child || this.#child.stdin.destroyed) throw fail();
    const child = this.#child;
    child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error && this.#child === child) this.#stop();
    });
  }
  #request(method: string, params: unknown): Promise<unknown> {
    if (this.#pending.size >= 100) return Promise.reject(fail());
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(fail());
        this.#stop();
      }, this.#options.timeoutMs ?? 30_000);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ id, method, params });
      } catch {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(fail());
      }
    });
  }
  #consume(chunk: string): void {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer) > 2_000_000) {
      this.#stop();
      return;
    }
    for (;;) {
      const index = this.#buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
        if (!message || typeof message !== "object") throw fail();
      } catch {
        this.#stop();
        return;
      }
      if (typeof message["method"] === "string") {
        const method = message["method"];
        const id = message["id"];
        if (typeof id === "number" || typeof id === "string") {
          if (this.#approvals.has(id)) {
            this.#stop();
            return;
          }
          if (
            APPROVAL_METHODS.has(method) &&
            this.#approvals.size < 100 &&
            Buffer.byteLength(
              JSON.stringify([
                ...this.#approvals.values(),
                { id, method, params: message["params"] },
              ]),
            ) <= 4_000_000
          )
            this.#approvals.set(id, { id, method, params: message["params"] });
          else
            this.#write({
              id,
              error: { code: -32601, message: "Unsupported server request; refused." },
            });
        } else {
          const params = message["params"] as Record<string, unknown> | undefined;
          if (params && method === "serverRequest/resolved") {
            const requestId = params["requestId"];
            if (typeof requestId === "string" || typeof requestId === "number")
              this.#approvals.delete(requestId);
          }
          if (params && ["turn/completed", "thread/closed", "thread/deleted"].includes(method)) {
            for (const [approvalId, approval] of this.#approvals) {
              const detail = approval.params as Record<string, unknown> | undefined;
              if (detail?.["threadId"] === params["threadId"]) this.#approvals.delete(approvalId);
            }
            if (method !== "turn/completed" && typeof params["threadId"] === "string")
              this.#threads.delete(params["threadId"]);
          }
          const event = { sequence: ++this.#sequence, method, params: message["params"] };
          this.#events.push(event);
          while (
            this.#events.length > 200 ||
            Buffer.byteLength(JSON.stringify(this.#events)) > 4_000_000
          )
            this.#events.shift();
          this.emit("notification", event);
        }
      } else if (typeof message["id"] === "number") {
        const pending = this.#pending.get(message["id"]);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(message["id"]);
        if (message["error"] !== undefined) pending.reject(fail());
        else pending.resolve(message["result"]);
      }
    }
  }
  async action(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.#syncScope();
    if (action.endsWith("/respond") && params["requestGeneration"] !== this.#requestGeneration)
      throw new Error("Invalid or expired Codex request generation.");
    if (action === "permissions/respond" || action === "dynamic-tool/respond") {
      const id = params["id"];
      const pending =
        typeof id === "string" || typeof id === "number" ? this.#approvals.get(id) : undefined;
      if (!pending || !object(pending.params)) throw new Error("Invalid or expired Codex request.");
      const generation = this.#requestGeneration;
      let result: unknown;
      if (action === "permissions/respond") {
        if (
          pending.method !== "item/permissions/requestApproval" ||
          !["allow", "deny"].includes(String(params["decision"])) ||
          Object.keys(params).some(
            (key) =>
              !["id", "decision", "confirmTurnPermission", "requestGeneration"].includes(key),
          )
        )
          throw new Error("Invalid permission response.");
        if (params["decision"] === "allow") {
          if (
            params["confirmTurnPermission"] !== true ||
            typeof pending.params.threadId !== "string" ||
            !this.#threads.has(pending.params.threadId)
          )
            throw new Error("Explicit turn permission consent required for a loaded thread.");
          result = {
            permissions: await buildCodexWorkspacePermissionGrant(this.#scope, pending.params),
            scope: "turn",
            strictAutoReview: true,
          };
        } else result = { permissions: {}, scope: "turn" };
      } else {
        if (
          pending.method !== "item/tool/call" ||
          typeof params["execute"] !== "boolean" ||
          Object.keys(params).some((key) => !["id", "execute", "requestGeneration"].includes(key))
        )
          throw new Error("Invalid dynamic tool response.");
        if (params["execute"] === true) {
          if (
            Object.keys(pending.params).some(
              (key) =>
                !["threadId", "turnId", "callId", "namespace", "tool", "arguments"].includes(key),
            ) ||
            [pending.params.threadId, pending.params.turnId, pending.params.callId].some(
              (value) =>
                typeof value !== "string" || !value || value.length > 512 || value.includes("\0"),
            ) ||
            typeof pending.params.tool !== "string" ||
            pending.params.tool.length > 200 ||
            !object(pending.params.arguments) ||
            Buffer.byteLength(JSON.stringify(pending.params.arguments)) > 16_384
          )
            throw new Error("Invalid native dynamic tool request.");
          if (
            typeof pending.params.threadId !== "string" ||
            !this.#threads.has(pending.params.threadId) ||
            !this.#dynamicThreads.has(pending.params.threadId) ||
            pending.params.namespace !== null ||
            typeof pending.params.tool !== "string"
          )
            throw new Error("Dynamic tools are not enabled for this thread.");
          result = await executeCodexDynamicTool(
            this.#scope,
            pending.params.tool,
            pending.params.arguments,
          );
        } else
          result = {
            contentItems: [{ type: "inputText", text: "User declined this client tool call." }],
            success: false,
          };
      }
      this.#syncScope();
      if (this.#requestGeneration !== generation || this.#approvals.get(pending.id) !== pending)
        throw new Error("Expired workspace request.");
      this.#write({ id: pending.id, result });
      this.#approvals.delete(pending.id);
      return { responded: true };
    }
    if (action === "user-input/respond" || action === "elicitation/respond") {
      const id = params["id"];
      const pending =
        typeof id === "string" || typeof id === "number" ? this.#approvals.get(id) : undefined;
      if (!pending || !object(pending.params)) throw new Error("Invalid or expired Codex request.");
      let result: unknown;
      if (action === "user-input/respond") {
        const answers = params["answers"];
        const questions = pending.params.questions;
        if (
          pending.method !== "item/tool/requestUserInput" ||
          !object(answers) ||
          !Array.isArray(questions) ||
          questions.length > 100
        )
          throw new Error("Invalid user input response.");
        const ids = questions.map((question) => (object(question) ? question.id : undefined));
        if (
          ids.some((id) => typeof id !== "string") ||
          new Set(ids).size !== ids.length ||
          Object.keys(answers).length !== ids.length
        )
          throw new Error("Invalid user input response.");
        for (const id of ids as string[]) {
          const answer = answers[id];
          if (
            !Object.hasOwn(answers, id) ||
            !object(answer) ||
            Object.keys(answer).some((key) => key !== "answers") ||
            !Array.isArray(answer.answers) ||
            answer.answers.length > 100 ||
            answer.answers.some((value) => typeof value !== "string" || value.length > 16_384)
          )
            throw new Error("Invalid user input response.");
        }
        result = { answers };
      } else {
        const decision = params["action"];
        const content = params["content"] ?? null;
        if (
          pending.method !== "mcpServer/elicitation/request" ||
          !["accept", "decline", "cancel"].includes(String(decision))
        )
          throw new Error("Invalid elicitation response.");
        if (decision === "accept") {
          if (pending.params.mode === "url") {
            const target = pending.params.url;
            let validUrl = false;
            if (
              typeof target === "string" &&
              target.length <= 8192 &&
              !/[\u0000-\u0020]/.test(target)
            ) {
              try {
                const url = new URL(target);
                validUrl =
                  url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
              } catch {
                /* Untrusted server-supplied navigation target. */
              }
            }
            if (!validUrl || params["confirmExternalConsent"] !== true || content !== null)
              throw new Error(
                "External URL consent requires a valid HTTPS target and explicit confirmation.",
              );
            // This acknowledges consent only. The MCP server verifies the external outcome;
            // no URL is fetched and no third-party credentials transit through this broker.
          } else if (
            !["form", "openai/form", "openaiForm"].includes(String(pending.params.mode)) ||
            !validateMcpFormContent(pending.params.requestedSchema, content)
          )
            throw new Error("Unsupported form schema or invalid content.");
        } else if (content !== null) throw new Error("Declined elicitations have no content.");
        result = { action: decision, content, _meta: null };
      }
      if (Buffer.byteLength(JSON.stringify(result)) > 100_000)
        throw new Error("Response too large.");
      this.#write({ id, result });
      this.#approvals.delete(id as string | number);
      return { responded: true };
    }
    if (action === "approval/respond") {
      const id = params["id"];
      const decision = params["decision"];
      if (
        (typeof id !== "string" && typeof id !== "number") ||
        !this.#approvals.has(id) ||
        !["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(
          this.#approvals.get(id)!.method,
        ) ||
        !["accept", "decline", "cancel"].includes(String(decision))
      )
        throw new Error("Invalid or expired Codex approval.");
      this.#write({ id, result: { decision } });
      this.#approvals.delete(id);
      return { responded: true };
    }
    const string = (key: string) => {
      const value = params[key];
      const maxLength = key === "text" ? 100_000 : key === "cursor" ? 16_384 : 512;
      if (typeof value !== "string" || !value || value.length > maxLength || value.includes("\0"))
        throw new Error(`Invalid ${key}.`);
      return value;
    };
    if (
      params["model"] !== undefined &&
      (typeof params["model"] !== "string" ||
        !params["model"] ||
        params["model"].length > 200 ||
        params["model"].includes("\0"))
    )
      throw new Error("Invalid model.");
    const sandbox =
      params["sandbox"] ??
      (typeof params["threadId"] === "string"
        ? this.#threads.get(params["threadId"])
        : undefined) ??
      "read-only";
    if (sandbox !== "read-only" && sandbox !== "workspace-write")
      throw new Error("Unsupported sandbox.");
    const policy = {
      cwd: this.#scope,
      sandbox,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      config: {
        "sandbox_workspace_write.network_access": false,
        "sandbox_workspace_write.writable_roots": [],
        "sandbox_workspace_write.exclude_tmpdir_env_var": true,
        "sandbox_workspace_write.exclude_slash_tmp": true,
        "sandbox_read_only.network_access": false,
      },
    };
    let args: Record<string, unknown>;
    switch (action) {
      case "account/read":
        args = { refreshToken: false };
        break;
      case "account/login/start":
        if (params["confirmPersistLogin"] !== true || params["type"] !== "chatgpt")
          throw new Error("Explicit persistent login consent required.");
        args = { type: "chatgpt" };
        break;
      case "account/login/cancel":
        args = { loginId: string("loginId") };
        break;
      case "model/list":
        args = {};
        break;
      case "permissionProfile/list":
        args = {
          cwd: this.#scope,
          limit: 50,
          ...(params["cursor"] !== undefined ? { cursor: string("cursor") } : {}),
        };
        break;
      case "thread/list":
        if (params["archived"] !== undefined && typeof params["archived"] !== "boolean")
          throw new Error("Invalid archived filter.");
        args = {
          limit: 50,
          cwd: this.#scope,
          ...(params["archived"] !== undefined ? { archived: params["archived"] } : {}),
          ...(params["cursor"] !== undefined ? { cursor: string("cursor") } : {}),
        };
        break;
      case "thread/compact/start":
      case "thread/archive":
        if (!this.#threads.has(string("threadId")))
          throw new Error("Resume or start this thread before modifying it.");
        args = { threadId: string("threadId") };
        break;
      case "thread/unarchive":
        args = { threadId: string("threadId") };
        break;
      case "thread/start":
        if (
          params["dynamicToolsEnabled"] !== undefined &&
          typeof params["dynamicToolsEnabled"] !== "boolean"
        )
          throw new Error("Invalid dynamic tool opt-in.");
        args = {
          ...policy,
          ...(params["dynamicToolsEnabled"] === true ? { dynamicTools: CODEX_DYNAMIC_TOOLS } : {}),
          ...(typeof params["model"] === "string" ? { model: params["model"] } : {}),
        };
        break;
      case "thread/resume":
        args = {
          ...policy,
          threadId: string("threadId"),
          ...(typeof params["model"] === "string" ? { model: params["model"] } : {}),
        };
        break;
      case "thread/read":
        args = { threadId: string("threadId"), includeTurns: true };
        break;
      case "turn/start":
        if (!this.#threads.has(string("threadId")))
          throw new Error("Resume or start this thread before sending a turn.");
        args = {
          cwd: this.#scope,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy:
            sandbox === "read-only"
              ? { type: "readOnly", networkAccess: false }
              : {
                  type: "workspaceWrite",
                  writableRoots: [this.#scope],
                  networkAccess: false,
                  excludeTmpdirEnvVar: true,
                  excludeSlashTmp: true,
                },
          threadId: string("threadId"),
          input: [{ type: "text", text: string("text"), text_elements: [] }],
          ...(typeof params["model"] === "string" ? { model: params["model"] } : {}),
        };
        break;
      case "turn/interrupt":
        args = { threadId: string("threadId"), turnId: string("turnId") };
        break;
      default:
        throw new Error("Unsupported Codex action.");
    }
    await this.#start();
    const result = await this.#request(action, args);
    if (action === "thread/start" || action === "thread/resume") {
      const thread = (result as { thread?: { id?: unknown } } | null)?.thread;
      if (typeof thread?.id !== "string") throw fail();
      if (this.#threads.size >= 1000 && !this.#threads.has(thread.id)) throw fail();
      this.#threads.set(thread.id, sandbox);
      if (action === "thread/start" && params["dynamicToolsEnabled"] === true)
        this.#dynamicThreads.add(thread.id);
    }
    if (action === "thread/archive") {
      const threadId = string("threadId");
      this.#threads.delete(threadId);
      this.#dynamicThreads.delete(threadId);
      for (const [id, approval] of this.#approvals) {
        if (object(approval.params) && approval.params.threadId === threadId)
          this.#approvals.delete(id);
      }
    }
    return result;
  }
  #stop(): void {
    this.#requestGeneration += 1;
    const child = this.#child;
    this.#child = undefined;
    this.#ready = undefined;
    this.#buffer = "";
    this.#approvals.clear();
    this.#threads.clear();
    this.#dynamicThreads.clear();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(fail());
    }
    this.#pending.clear();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1000);
      timer.unref();
    }
  }
  close(): void {
    this.#closed = true;
    this.#stop();
    this.removeAllListeners();
  }
}
