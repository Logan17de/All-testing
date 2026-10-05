import type { IncomingMessage, ServerResponse } from "node:http";
import type { SqliteDatabase } from "@zet-harness/db";
import type { RuntimeApiSecurity } from "./runtime-api-security.js";
import { writeRuntimeJson } from "./runtime-approval-http.js";

export interface RuntimeConnectionHttpServices {
  readonly database: SqliteDatabase;
}

/** Retired routes are recognized so old clients receive a precise, safe refusal. */
export function isConnectionHttpPath(pathname: string): boolean {
  return pathname === "/api/connections" || pathname.startsWith("/api/connections/openrouter/");
}

export function createConnectionHttpHandler() {
  return function handleConnectionHttp(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    security: RuntimeApiSecurity,
  ): Promise<void> {
    if (request.method !== "GET") security.checkMutation(request);
    if (url.pathname === "/api/connections" && request.method === "GET") {
      writeRuntimeJson(response, 200, {
        connections: [],
        integrations: [
          {
            provider: "codex",
            method: "official-cli",
            login: "npm run codex -- login --confirm-persist-login",
          },
          {
            provider: "anthropic",
            method: "api-key",
            active: false,
            pendingDecision: true,
            subscriptionOAuth: false,
          },
          {
            provider: "xai",
            method: "api-key",
            active: false,
            pendingDecision: true,
            subscriptionOAuth: false,
          },
        ],
      });
    } else {
      writeRuntimeJson(response, 410, {
        error: {
          code: "CONNECTION_RETIRED",
          reason:
            "OpenRouter integration was removed. Use a direct provider API key or the official Codex CLI bridge. Existing stored records are retained but inactive.",
        },
      });
    }
    return Promise.resolve();
  };
}
