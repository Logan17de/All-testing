import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { CodexSearchError } from "./runtime-codex-search.js";
import type { CodexSearchBridge } from "./runtime-codex-search.js";
import { ChatGPTAuthError, ChatGPTPlanAuth } from "./runtime-chatgpt-auth.js";
import type { ChatGPTAccount } from "./runtime-chatgpt-auth.js";

export interface ChatGPTLoginStatus {
  state: "disconnected" | "pending" | "connected" | "error";
  account?: ChatGPTAccount;
  errorCode?: string;
}
/** Owns only the documented loopback callback, never the application's public HTTP listener.
 * Wire start/cancel behind the runtime's existing authenticated, explicit-action routes.
 */
export class ChatGPTLoginController {
  readonly auth: ChatGPTPlanAuth;
  readonly #hostId: string | undefined;
  #server: Server | undefined;
  #expiry: ReturnType<typeof setTimeout> | undefined;
  #state: ChatGPTLoginStatus["state"] = "disconnected";
  #errorCode: string | undefined;
  #generation = 0;
  constructor(options: { hostId?: string; auth?: ChatGPTPlanAuth } = {}) {
    this.#hostId = options.hostId;
    this.auth = options.auth ?? new ChatGPTPlanAuth();
  }
  status(): ChatGPTLoginStatus {
    const account = this.auth.account();
    return {
      state: this.#state,
      ...(account ? { account } : {}),
      ...(this.#errorCode ? { errorCode: this.#errorCode } : {}),
    };
  }
  #stopListener(force = true): void {
    if (this.#expiry) clearTimeout(this.#expiry);
    this.#expiry = undefined;
    this.#server?.close();
    if (force) this.#server?.closeAllConnections();
    this.#server = undefined;
  }
  cancel(): ChatGPTLoginStatus {
    this.#generation++;
    this.auth.cancel();
    this.#stopListener();
    this.#state = this.auth.account() ? "connected" : "disconnected";
    this.#errorCode = undefined;
    return this.status();
  }
  close(): void {
    this.cancel();
    this.auth.clear();
    this.#state = "disconnected";
  }

  async start(): Promise<{
    authorizationUrl: string;
    expiresAt: number;
    callbackLocation: "local-runtime-loopback";
    memoryOnly: true;
  }> {
    this.cancel();
    if (!this.#hostId) throw new ChatGPTAuthError("CHATGPT_HOST_ID_CONFIGURATION_REQUIRED");
    const generation = this.#generation;
    const server = createServer((request, response) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        response.writeHead(503);
        response.end();
        return;
      }
      const callbackOrigin = `http://127.0.0.1:${address.port}`;
      let callback: URL;
      try {
        callback = new URL(request.url ?? "", callbackOrigin);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      // Reject absolute-target requests, unexpected host, methods, and other paths without consuming login.
      if (
        request.method !== "GET" ||
        request.headers.host !== `127.0.0.1:${address.port}` ||
        callback.origin !== callbackOrigin ||
        callback.pathname !== "/auth/callback"
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (generation !== this.#generation || this.#state !== "pending") {
        response.writeHead(409);
        response.end();
        return;
      }
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      void this.auth
        .complete(callback.href)
        .then(() => {
          if (generation !== this.#generation) {
            response.writeHead(409);
            response.end("Sign-in cancelled.");
            return;
          }
          this.#state = "connected";
          response.writeHead(200);
          response.end("ChatGPT connected to Z harness. You can close this window.");
        })
        .catch((error: unknown) => {
          if (generation === this.#generation) {
            this.#state = "error";
            this.#errorCode =
              error instanceof ChatGPTAuthError ? error.code : "CHATGPT_AUTH_INVALID";
          }
          response.writeHead(400);
          response.end("ChatGPT sign-in was not completed. Return to Z harness and try again.");
        })
        .finally(() => {
          if (generation === this.#generation) this.#stopListener(false);
        });
    });
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      if (generation !== this.#generation) throw new ChatGPTAuthError("CHATGPT_AUTH_CANCELLED");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new ChatGPTAuthError("CHATGPT_CALLBACK_UNAVAILABLE");
      const start = this.auth.begin({
        hostId: this.#hostId,
        redirectUri: `http://127.0.0.1:${address.port}/auth/callback`,
      });
      this.#state = "pending";
      this.#expiry = setTimeout(
        () => {
          if (generation === this.#generation) {
            this.cancel();
            this.#state = "error";
            this.#errorCode = "CHATGPT_AUTH_EXPIRED";
          }
        },
        Math.max(1, start.expiresAt - Date.now()),
      );
      this.#expiry.unref();
      return { ...start, callbackLocation: "local-runtime-loopback", memoryOnly: true };
    } catch (error) {
      if (generation !== this.#generation) {
        server.close();
        server.closeAllConnections();
        throw new ChatGPTAuthError("CHATGPT_AUTH_CANCELLED");
      }
      this.cancel();
      this.#state = "error";
      this.#errorCode =
        error instanceof ChatGPTAuthError ? error.code : "CHATGPT_CALLBACK_UNAVAILABLE";
      throw new ChatGPTAuthError(this.#errorCode);
    }
  }
}

export function createChatGPTAuthHttpHandler(options: {
  controller: ChatGPTLoginController;
  search?: CodexSearchBridge;
}): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
  return async (request, response, url) => {
    const path = url.pathname.replace(/^\/api(?=\/)/u, "");
    if (
      ![
        "/auth/chatgpt",
        "/auth/chatgpt/login",
        "/auth/chatgpt/cancel",
        "/auth/chatgpt/search",
      ].includes(path)
    )
      return false;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    const send = (status: number, value: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && path === "/auth/chatgpt") {
      send(200, options.controller.status());
      return true;
    }
    if (request.method !== "POST" || path === "/auth/chatgpt") {
      send(405, { error: "CHATGPT_ACTION_METHOD_INVALID" });
      return true;
    }
    try {
      if (path === "/auth/chatgpt/login") send(200, await options.controller.start());
      else if (path === "/auth/chatgpt/cancel") send(200, options.controller.cancel());
      else {
        if (!options.search) {
          send(409, { error: "CODEX_SEARCH_MODEL_CONFIGURATION_REQUIRED" });
          return true;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const value of request) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
          bytes += chunk.length;
          if (bytes > 8192) throw new ChatGPTAuthError("CODEX_SEARCH_QUERY_INVALID");
          chunks.push(chunk);
        }
        let body: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("invalid");
          body = parsed as Record<string, unknown>;
        } catch {
          throw new ChatGPTAuthError("CODEX_SEARCH_QUERY_INVALID");
        }
        if (Object.keys(body).some((key) => key !== "query") || typeof body.query !== "string")
          throw new ChatGPTAuthError("CODEX_SEARCH_QUERY_INVALID");
        const abort = new AbortController();
        const cancel = () => {
          if (!response.writableFinished) abort.abort();
        };
        response.once("close", cancel);
        try {
          send(200, await options.search.search(body.query, abort.signal));
        } finally {
          response.off("close", cancel);
        }
      }
    } catch (error) {
      const code =
        error instanceof ChatGPTAuthError || error instanceof CodexSearchError
          ? error.code
          : "CHATGPT_AUTH_UNAVAILABLE";
      if (!response.destroyed && !response.writableEnded) send(409, { error: code });
    }
    return true;
  };
}
