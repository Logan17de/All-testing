import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  RUNTIME_HEALTH_SERVICE,
  type RuntimeHealthProvider,
  type RuntimeHealthResponse,
} from "./runtime-health.js";
import {
  RuntimeEventCursorError,
  RuntimeEventStream,
  type RuntimeEventStreamUnsubscribe,
  type RuntimeStreamEvent,
} from "./runtime-event-stream.js";
import { RuntimeApiSecurity, assertLoopbackHost } from "./runtime-api-security.js";
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
export class RuntimeHttpServer {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly eventStream: RuntimeEventStream;
  private readonly healthProvider: RuntimeHealthProvider;
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
    } = {},
  ) {
    this.host = options.host ?? DEFAULT_RUNTIME_HOST;
    this.requestedPort = options.port ?? DEFAULT_RUNTIME_PORT;
    this.eventStream = eventStream;
    this.healthProvider = healthProvider;
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
