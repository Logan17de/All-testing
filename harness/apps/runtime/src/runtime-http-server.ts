import { createServer, type Server, type ServerResponse } from "node:http";

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

/** Tiny dependency-free loopback HTTP surface. SSE and persistence arrive in later Phase 4 items. */
export class RuntimeHttpServer {
  private readonly host: string;
  private readonly requestedPort: number;
  private state: RuntimeHttpServerState = "idle";
  private boundPort: number | null = null;
  private server: Server | undefined;
  private stopPromise: Promise<boolean> | undefined;

  constructor(options: RuntimeHttpServerOptions = {}) {
    this.host = options.host ?? DEFAULT_RUNTIME_HOST;
    this.requestedPort = options.port ?? DEFAULT_RUNTIME_PORT;

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
      const pathname = new URL(request.url ?? "/", "http://runtime.invalid").pathname;

      if (pathname === "/api/health") {
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

      writeJson(response, 404, { error: "not_found" });
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

  private async stopOnce(): Promise<boolean> {
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
