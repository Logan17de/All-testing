import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  RuntimeEventCursorError,
  RuntimeEventStream,
  type RuntimeEventStreamUnsubscribe,
  type RuntimeStreamEvent,
} from "./runtime-event-stream.js";

export const DEFAULT_RUNTIME_HOST = "127.0.0.1";
export const DEFAULT_RUNTIME_PORT = 3211;

export type RuntimeHttpServerState = "idle" | "listening" | "stopped";

export interface RuntimeHttpServerOptions {
  readonly host?: string;
  readonly port?: number;
}

export interface RuntimeHttpServerSnapshot {
  readonly state: RuntimeHttpServerState;
  readonly host: string;
  readonly port: number | null;
  readonly eventClients: number;
}

const writeJson = (response: ServerResponse, statusCode: number, body: unknown): void => {
  const payload = `${JSON.stringify(body)}\n`;

  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(payload);
};

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

/** Tiny dependency-free loopback HTTP surface with process-local SSE replay. */
export class RuntimeHttpServer {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly eventStream: RuntimeEventStream;
  private readonly eventClients = new Map<ServerResponse, () => void>();
  private state: RuntimeHttpServerState = "idle";
  private boundPort: number | null = null;
  private server: Server | undefined;
  private stopPromise: Promise<boolean> | undefined;

  constructor(options: RuntimeHttpServerOptions = {}, eventStream = new RuntimeEventStream()) {
    this.host = options.host ?? DEFAULT_RUNTIME_HOST;
    this.requestedPort = options.port ?? DEFAULT_RUNTIME_PORT;
    this.eventStream = eventStream;

    if (this.host.length === 0) {
      throw new TypeError("Runtime HTTP host must not be empty.");
    }
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
    if (this.state === "listening") {
      return false;
    }

    const server = createServer((request, response) => {
      this.handleRequest(request, response);
    });

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
    if (this.state === "stopped") {
      return false;
    }
    if (this.stopPromise !== undefined) {
      await this.stopPromise;
      return false;
    }

    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://runtime.invalid");

    if (url.pathname === "/api/health") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        writeJson(response, 405, {
          error: "method_not_allowed",
          allowed: ["GET"],
        });
        return;
      }

      writeJson(response, 200, {
        status: "ok",
        service: "zet-harness-runtime",
      });
      return;
    }

    if (url.pathname === "/api/events") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        writeJson(response, 405, {
          error: "method_not_allowed",
          allowed: ["GET"],
        });
        return;
      }

      this.openEventStream(request, response, url);
      return;
    }

    writeJson(response, 404, { error: "not_found" });
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
      if (!active) {
        return;
      }
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
      if (!response.writableEnded) {
        response.end();
      }
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
