import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeApiSecurity } from "./runtime-api-security.js";
import { writeRuntimeJson } from "./runtime-approval-http.js";
import type { RuntimeBrowserService } from "./runtime-browser-service.js";
export function isBrowserHttpPath(path: string): boolean {
  return path === "/api/browser";
}
export function createBrowserHttpHandler(service: RuntimeBrowserService) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    _url: URL,
    security: RuntimeApiSecurity,
  ): Promise<void> => {
    void _url;
    if (request.method === "GET") {
      writeRuntimeJson(response, 200, service.snapshot());
      return;
    }
    if (request.method !== "POST") {
      writeRuntimeJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
      return;
    }
    security.checkMutation(request);
    let body = "";
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 131_072) {
        request.resume();
        writeRuntimeJson(response, 413, { error: { code: "BODY_TOO_LARGE" } });
        return;
      }
    }
    let action: unknown;
    let params: unknown;
    try {
      const value = JSON.parse(body) as Record<string, unknown>;
      action = value["action"];
      params = value["params"] ?? {};
    } catch {
      writeRuntimeJson(response, 400, { error: { code: "INVALID_JSON" } });
      return;
    }
    if (
      typeof action !== "string" ||
      !params ||
      typeof params !== "object" ||
      Array.isArray(params)
    ) {
      writeRuntimeJson(response, 400, { error: { code: "INVALID_REQUEST" } });
      return;
    }
    try {
      writeRuntimeJson(response, 200, {
        result: await service.action(action, params as Record<string, unknown>),
      });
    } catch {
      writeRuntimeJson(response, 400, {
        error: {
          code: "BROWSER_REQUEST_FAILED",
          reason:
            "Browser request failed or refused. Check task scope, generation, consent, and browser availability.",
        },
      });
    }
  };
}
