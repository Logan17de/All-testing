import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  RUNTIME_HEALTH_SERVICE,
  type RuntimeHealthProvider,
  type RuntimeHealthResponse,
} from "./runtime-health.js";
import {
  handleGraphHttp,
  isGraphHttpPath,
  type RuntimeGraphHttpServices,
} from "./runtime-graph-http.js";
import {
  handleProjectHttp,
  isProjectHttpPath,
  type RuntimeProjectHttpServices,
} from "./runtime-project-http.js";
import {
  handleConversationHttp,
  isConversationHttpPath,
  type RuntimeConversationHttpServices,
} from "./runtime-conversation-http.js";
import {
  handleGoalHttp,
  isGoalHttpPath,
  type RuntimeGoalHttpServices,
} from "./runtime-goal-http.js";
import {
  handleMemoryHttp,
  isMemoryHttpPath,
  type RuntimeMemoryHttpServices,
} from "./runtime-memory-http.js";
import {
  handleTriggerHttp,
  isTriggerHttpPath,
  type RuntimeTriggerHttpServices,
} from "./runtime-trigger-http.js";
import {
  handleClientHttp,
  isClientHttpPath,
  type RuntimeClientHttpServices,
} from "./runtime-client-http.js";
import {
  RuntimeEventCursorError,
  RuntimeEventStream,
  type RuntimeEventStreamUnsubscribe,
  type RuntimeStreamEvent,
} from "./runtime-event-stream.js";
import {
  RuntimeApiSecurity,
  RuntimeApiSecurityError,
  assertLoopbackHost,
} from "./runtime-api-security.js";
import {
  handleApprovalHttp,
  writeRuntimeApiError,
  writeRuntimeJson,
} from "./runtime-approval-http.js";
import type { RuntimeHumanApprovals } from "./runtime-human-approvals.js";
import { RuntimeRedactionRegistry } from "./runtime-redaction.js";

export const DEFAULT_RUNTIME_HOST = "127.0.0.1";
export const DEFAULT_RUNTIME_PORT = 3211;
export type RuntimeHttpServerState = "idle" | "listening" | "stopped";

export interface RuntimeHttpServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly allowedOrigins?: readonly string[];
}

export interface RuntimeHttpServerSnapshot {
  readonly state: RuntimeHttpServerState;
  readonly host: string;
  readonly port: number | null;
  readonly eventClients: number;
}

const writeJson = writeRuntimeJson;
const parseCursorValue = (value: string, source: string): number => {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${source} must be a non-negative safe integer.`);
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) {
    throw new TypeError(`${source} must be a non-negative safe integer.`);
  }
  return cursor;
};

const parseReconnectCursor = (request: IncomingMessage, url: URL): number | null => {
  const headerValue = request.headers["last-event-id"];
  if (Array.isArray(headerValue)) {
    throw new TypeError("Last-Event-ID must contain exactly one cursor value.");
  }
  const headerCursor =
    headerValue === undefined ? null : parseCursorValue(headerValue, "Last-Event-ID");
  const queryValue = url.searchParams.get("cursor");
  const queryCursor =
    queryValue === null ? null : parseCursorValue(queryValue, "Runtime event cursor");
  if (headerCursor !== null && queryCursor !== null && headerCursor !== queryCursor) {
    throw new TypeError("Last-Event-ID and query cursor must match when both are supplied.");
  }
  return headerCursor ?? queryCursor;
};

const formatSseEvent = (event: RuntimeStreamEvent): string =>
  `id: ${String(event.id)}\nevent: ${event.type}\ndata: ${event.data}\n\n`;
const defaultRuntimeHealthProvider: RuntimeHealthProvider = () =>
  Object.freeze({ status: "ok", service: RUNTIME_HEALTH_SERVICE });

/** Loopback API; browser origin/CSRF protection is distinct from OS process isolation. */
/** The few mutations this server answers itself take a small JSON object. */
const MAX_SERVER_BODY_BYTES = 8_192;

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown> | undefined> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    size += buffer.length;
    if (size > MAX_SERVER_BODY_BYTES) {
      request.resume();
      throw new RuntimeApiSecurityError("LOCAL_API_BODY_TOO_LARGE", "Request exceeds 8 KiB.", 413);
    }
    parts.push(buffer);
  }
  if (size === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class RuntimeHttpServer {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly eventStream: RuntimeEventStream;
  private readonly healthProvider: RuntimeHealthProvider;
  private readonly pluginsProvider: (() => unknown) | undefined;
  private readonly installPlugin:
    | ((source: {
        readonly kind: "npm" | "git";
        readonly spec?: string;
        readonly url?: string;
        readonly ref?: string;
      }) => Promise<unknown>)
    | undefined;
  private readonly graphServices: RuntimeGraphHttpServices | undefined;
  private readonly projectServices: RuntimeProjectHttpServices | undefined;
  private readonly conversationServices: RuntimeConversationHttpServices | undefined;
  private readonly goalServices: RuntimeGoalHttpServices | undefined;
  private readonly memoryServices: RuntimeMemoryHttpServices | undefined;
  private readonly triggerServices: RuntimeTriggerHttpServices | undefined;
  private readonly clientServices: RuntimeClientHttpServices | undefined;
  private readonly eventClients = new Map<ServerResponse, () => void>();
  private readonly security: RuntimeApiSecurity;
  private readonly redaction: RuntimeRedactionRegistry;
  private readonly approvals: RuntimeHumanApprovals | undefined;
  private state: RuntimeHttpServerState = "idle";
  private boundPort: number | null = null;
  private server: Server | undefined;
  private stopPromise: Promise<boolean> | undefined;

  constructor(
    options: RuntimeHttpServerOptions = {},
    eventStream = new RuntimeEventStream(),
    healthProvider: RuntimeHealthProvider = defaultRuntimeHealthProvider,
    services: {
      readonly approvals?: RuntimeHumanApprovals;
      readonly redaction?: RuntimeRedactionRegistry;
      /** Read-only view of installed plugins for the local UI. */
      readonly plugins?: () => unknown;
      /**
       * Install a plugin package from npm or a Git repository.
       *
       * Supplied only when the host allows it. Installing never enables a plugin or
       * grants it anything, so this stays a separate decision from the config.
       */
      readonly installPlugin?: (source: {
        readonly kind: "npm" | "git";
        readonly spec?: string;
        readonly url?: string;
        readonly ref?: string;
      }) => Promise<unknown>;
      /** Editor endpoints: node palette, graph validation, runs. */
      readonly graphs?: RuntimeGraphHttpServices;
      /** Project endpoints: list, create, change, archive and restore. */
      readonly projects?: RuntimeProjectHttpServices;
      /** Conversation endpoints: conversations and their append-only messages. */
      readonly conversations?: RuntimeConversationHttpServices;
      /** Goal and todo endpoints, with status transitions and todo dependencies. */
      readonly goals?: RuntimeGoalHttpServices;
      /** What a project remembers across conversations and runs. */
      readonly memories?: RuntimeMemoryHttpServices;
      /** Standing reasons to start a run: manual, cron, webhook and api triggers. */
      readonly triggers?: RuntimeTriggerHttpServices;
      /** External clients: tokens issued locally, then used instead of a browser session. */
      readonly clients?: RuntimeClientHttpServices;
    } = {},
  ) {
    this.host = options.host ?? DEFAULT_RUNTIME_HOST;
    this.requestedPort = options.port ?? DEFAULT_RUNTIME_PORT;
    this.eventStream = eventStream;
    this.healthProvider = healthProvider;
    this.pluginsProvider = services.plugins;
    this.installPlugin = services.installPlugin;
    this.graphServices = services.graphs;
    this.projectServices = services.projects;
    this.conversationServices = services.conversations;
    this.goalServices = services.goals;
    this.memoryServices = services.memories;
    this.triggerServices = services.triggers;
    this.clientServices = services.clients;
    this.redaction = services.redaction ?? new RuntimeRedactionRegistry();
    this.approvals = services.approvals;
    this.security = new RuntimeApiSecurity(options.allowedOrigins);
    this.redaction.registerSecret(this.security.sessionToken());
    if (this.host.length === 0) throw new TypeError("Runtime HTTP host must not be empty.");
    assertLoopbackHost(this.host);
    if (
      !Number.isSafeInteger(this.requestedPort) ||
      this.requestedPort < 0 ||
      this.requestedPort > 65_535
    ) {
      throw new TypeError("Runtime HTTP port must be a safe integer from 0 through 65535.");
    }
  }

  snapshot(): RuntimeHttpServerSnapshot {
    return Object.freeze({
      state: this.state,
      host: this.host,
      port: this.boundPort,
      eventClients: this.eventClients.size,
    });
  }

  async start(): Promise<boolean> {
    if (this.state === "stopped") {
      throw new TypeError("Runtime HTTP server cannot restart after it has stopped.");
    }
    if (this.state === "listening") return false;
    const server = createServer((request, response) => {
      this.handleRequest(request, response);
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.on("clientError", (_error, socket) => {
      socket.destroy();
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.requestedPort, this.host);
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }
    const address = server.address();
    if (address === null || typeof address === "string") {
      this.server = undefined;
      server.close();
      throw new TypeError("Runtime HTTP server did not expose a TCP listening address.");
    }
    this.boundPort = address.port;
    this.state = "listening";
    return true;
  }

  async stop(): Promise<boolean> {
    if (this.state === "stopped") return false;
    if (this.stopPromise !== undefined) {
      await this.stopPromise;
      return false;
    }
    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    try {
      const origin = this.security.check(request, this.boundPort ?? this.requestedPort);
      response.setHeader("vary", "Origin, Sec-Fetch-Site");
      if (origin !== undefined) response.setHeader("access-control-allow-origin", origin);
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type, x-zet-csrf",
          "cache-control": "no-store",
        });
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://runtime.invalid");
      if (
        url.pathname === "/api/session" ||
        url.pathname === "/api/approvals" ||
        url.pathname.startsWith("/api/approvals/")
      ) {
        void handleApprovalHttp(
          request,
          response,
          url,
          this.security,
          this.approvals,
          this.redaction,
        ).catch((error: unknown) => {
          writeRuntimeApiError(response, error);
        });
        return;
      }
      if (url.pathname === "/api/health") {
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          writeJson(response, 405, { error: "method_not_allowed", allowed: ["GET"] });
          return;
        }
        const health = this.readHealth();
        writeJson(response, health.status === "ok" ? 200 : 503, health);
        return;
      }
      if (isGraphHttpPath(url.pathname)) {
        const graphs = this.graphServices;
        if (graphs === undefined) {
          writeJson(response, 503, { error: { code: "GRAPH_SERVICE_UNAVAILABLE" } });
          return;
        }
        void handleGraphHttp(request, response, url, this.security, graphs).catch(
          (error: unknown) => {
            writeRuntimeApiError(response, error);
          },
        );
        return;
      }
      // Before project paths: /api/projects/:id/goals belongs to goals.
      if (isGoalHttpPath(url.pathname)) {
        const goals = this.goalServices;
        if (goals === undefined) {
          writeJson(response, 503, { error: { code: "GOAL_SERVICE_UNAVAILABLE" } });
          return;
        }
        void handleGoalHttp(request, response, url, this.security, goals).catch(
          (error: unknown) => {
            writeRuntimeApiError(response, error);
          },
        );
        return;
      }
      if (isClientHttpPath(url.pathname)) {
        const clients = this.clientServices;
        if (clients === undefined) {
          writeJson(response, 503, { error: { code: "CLIENT_SERVICE_UNAVAILABLE" } });
          return;
        }
        void handleClientHttp(request, response, url, this.security, clients).catch(
          (error: unknown) => {
            writeRuntimeApiError(response, error);
          },
        );
        return;
      }
      if (isTriggerHttpPath(url.pathname)) {
        const triggers = this.triggerServices;
        if (triggers === undefined) {
          writeJson(response, 503, { error: { code: "TRIGGER_SERVICE_UNAVAILABLE" } });
          return;
        }
        void handleTriggerHttp(request, response, url, this.security, triggers).catch(
          (error: unknown) => {
            writeRuntimeApiError(response, error);
          },
        );
        return;
      }
      // Before project paths: /api/projects/:id/memories belongs to memories.
      if (isMemoryHttpPath(url.pathname)) {
        const memories = this.memoryServices;
        if (memories === undefined) {
          writeJson(response, 503, { error: { code: "MEMORY_SERVICE_UNAVAILABLE" } });
          return;
        }
        void handleMemoryHttp(request, response, url, this.security, memories).catch(
          (error: unknown) => {
            writeRuntimeApiError(response, error);
          },
        );
        return;
      }
      // Before project paths: /api/projects/:id/conversations belongs to conversations.
      if (isConversationHttpPath(url.pathname)) {
        const conversations = this.conversationServices;
        if (conversations === undefined) {
          writeJson(response, 503, { error: { code: "CONVERSATION_SERVICE_UNAVAILABLE" } });
          return;
        }
        void handleConversationHttp(request, response, url, this.security, conversations).catch(
          (error: unknown) => {
            writeRuntimeApiError(response, error);
          },
        );
        return;
      }
      if (isProjectHttpPath(url.pathname)) {
        const projects = this.projectServices;
        if (projects === undefined) {
          writeJson(response, 503, { error: { code: "PROJECT_SERVICE_UNAVAILABLE" } });
          return;
        }
        void handleProjectHttp(request, response, url, this.security, projects).catch(
          (error: unknown) => {
            writeRuntimeApiError(response, error);
          },
        );
        return;
      }
      if (url.pathname === "/api/plugins/install") {
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          writeJson(response, 405, { error: "method_not_allowed", allowed: ["POST"] });
          return;
        }
        void this.handlePluginInstall(request, response);
        return;
      }
      if (url.pathname === "/api/plugins") {
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          writeJson(response, 405, { error: "method_not_allowed", allowed: ["GET"] });
          return;
        }
        // Read-only. Enabling a plugin or granting it a capability is a
        // configuration decision, never an HTTP call the UI can make.
        writeJson(response, 200, this.pluginsProvider?.() ?? { installed: [], activated: [] });
        return;
      }
      if (url.pathname === "/api/events") {
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          writeJson(response, 405, { error: "method_not_allowed", allowed: ["GET"] });
          return;
        }
        this.openEventStream(request, response, url);
        return;
      }
      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      writeRuntimeApiError(response, error);
    }
  }

  /**
   * Install a plugin package.
   *
   * A local mutation like any other, so it passes the same CSRF check. The install
   * itself refuses anything the host has not allowed, and an installed package is
   * still disabled until a person enables it.
   */
  private async handlePluginInstall(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      this.security.checkMutation(request);
      const install = this.installPlugin;
      if (install === undefined) {
        writeJson(response, 403, {
          error: {
            code: "INSTALL_NOT_ALLOWED",
            reason: "This harness does not install plugins.",
          },
        });
        return;
      }
      const body = await readJsonBody(request);
      if (body === undefined) {
        writeJson(response, 400, {
          error: { code: "INSTALL_SOURCE_INVALID", reason: "Request body must be a JSON object." },
        });
        return;
      }
      const kind = body["kind"];
      if (kind !== "npm" && kind !== "git") {
        writeJson(response, 400, {
          error: { code: "INSTALL_SOURCE_INVALID", reason: "kind must be 'npm' or 'git'." },
        });
        return;
      }
      const spec = body["spec"];
      const repository = body["url"];
      const ref = body["ref"];
      if (
        (kind === "npm" && typeof spec !== "string") ||
        (kind === "git" && typeof repository !== "string") ||
        (ref !== undefined && typeof ref !== "string")
      ) {
        writeJson(response, 400, {
          error: {
            code: "INSTALL_SOURCE_INVALID",
            reason:
              kind === "npm"
                ? "An npm install needs a package spec."
                : "A git install needs a repository url.",
          },
        });
        return;
      }
      const installed = await install({
        kind,
        ...(typeof spec === "string" ? { spec } : {}),
        ...(typeof repository === "string" ? { url: repository } : {}),
        ...(typeof ref === "string" ? { ref } : {}),
      });
      writeJson(response, 201, {
        plugin: installed,
        // Installing is not enabling: the plugin waits for a person.
        enabled: false,
        activated: false,
      });
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code: unknown }).code
          : undefined;
      if (typeof code === "string" && code.startsWith("INSTALL_")) {
        const status = code === "INSTALL_NOT_ALLOWED" ? 403 : 400;
        writeJson(response, status, {
          error: {
            code,
            reason: error instanceof Error ? error.message : "The plugin was not installed.",
            ...(typeof (error as { readonly detail?: unknown }).detail === "string"
              ? { detail: (error as { readonly detail: string }).detail }
              : {}),
          },
        });
        return;
      }
      writeRuntimeApiError(response, error);
    }
  }

  private readHealth(): RuntimeHealthResponse {
    try {
      return this.healthProvider();
    } catch {
      return Object.freeze({
        status: "unhealthy",
        service: RUNTIME_HEALTH_SERVICE,
        checks: Object.freeze({ health: Object.freeze({ status: "unhealthy" }) }),
      });
    }
  }

  private openEventStream(request: IncomingMessage, response: ServerResponse, url: URL): void {
    let requestedCursor: number | null;
    try {
      requestedCursor = parseReconnectCursor(request, url);
    } catch (error) {
      writeJson(response, 400, {
        error: "invalid_event_cursor",
        message: error instanceof Error ? error.message : "Invalid event cursor.",
      });
      return;
    }
    const streamSnapshot = this.eventStream.snapshot();
    const cursor = requestedCursor ?? streamSnapshot.latestEventId;
    let replay: readonly RuntimeStreamEvent[];
    try {
      replay = this.eventStream.replayAfter(cursor);
    } catch (error) {
      if (error instanceof RuntimeEventCursorError) {
        writeJson(response, 409, {
          error: "event_cursor_unavailable",
          cursor: error.cursor,
          oldestRetainedEventId: error.oldestRetainedEventId,
          latestEventId: error.latestEventId,
        });
        return;
      }
      throw error;
    }
    response.writeHead(200, {
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    if (!response.write(": connected\n\n")) {
      response.destroy();
      return;
    }
    for (const event of replay) {
      if (!response.write(formatSseEvent(event))) {
        response.destroy();
        return;
      }
    }
    let unsubscribe: RuntimeEventStreamUnsubscribe = () => undefined;
    let active = true;
    const cleanup = (): void => {
      if (!active) return;
      active = false;
      unsubscribe();
      this.eventClients.delete(response);
      request.removeListener("close", cleanup);
      response.removeListener("close", cleanup);
    };
    unsubscribe = this.eventStream.subscribe((event) => {
      if (!response.write(formatSseEvent(event))) {
        cleanup();
        response.destroy();
      }
    });
    this.eventClients.set(response, cleanup);
    request.once("close", cleanup);
    response.once("close", cleanup);
  }

  private async stopOnce(): Promise<boolean> {
    for (const [response, cleanup] of [...this.eventClients]) {
      cleanup();
      if (!response.writableEnded) response.end();
    }
    const server = this.server;
    this.server = undefined;
    if (server !== undefined && server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
    this.boundPort = null;
    this.state = "stopped";
    return true;
  }
}
