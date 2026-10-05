import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeApiSecurity } from "./runtime-api-security.js";
import { writeRuntimeJson } from "./runtime-approval-http.js";
import type { RuntimeCodexService } from "./runtime-codex-service.js";
export function isCodexHttpPath(path: string): boolean {
  return path === "/api/codex";
}
export function createCodexHttpHandler(service: RuntimeCodexService) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    security: RuntimeApiSecurity,
  ): Promise<void> => {
    if (request.method === "GET") {
      const since = Number(url.searchParams.get("since") ?? 0);
      if (!Number.isSafeInteger(since) || since < 0) {
        writeRuntimeJson(response, 400, { error: { code: "INVALID_CURSOR" } });
        return;
      }
      writeRuntimeJson(response, 200, service.snapshot(since));
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
      writeRuntimeJson(response, 502, {
        error: {
          code: "CODEX_REQUEST_FAILED",
          reason:
            "Codex request failed. Check CLI installation, authentication, and request parameters.",
        },
      });
    }
  };
}
