import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeApiSecurity } from "./runtime-api-security.js";
import type { RuntimePluginMakerController } from "./runtime-plugin-maker-controller.js";
import { writeRuntimeJson } from "./runtime-approval-http.js";
export function createPluginMakerHttpHandler(controller: RuntimePluginMakerController) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    _url: URL,
    security: RuntimeApiSecurity,
  ) => {
    if (request.method === "GET") {
      writeRuntimeJson(response, 200, controller.snapshot());
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
      if (Buffer.byteLength(body) > 131072) {
        request.resume();
        writeRuntimeJson(response, 413, { error: { code: "BODY_TOO_LARGE" } });
        return;
      }
    }
    try {
      const value = JSON.parse(body) as Record<string, unknown>;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 2 ||
        typeof value.action !== "string" ||
        !value.params ||
        typeof value.params !== "object" ||
        Array.isArray(value.params)
      )
        throw new Error("Invalid request.");
      writeRuntimeJson(response, 200, {
        result: await controller.action(value.action, value.params as Record<string, unknown>),
      });
    } catch {
      writeRuntimeJson(response, 400, {
        error: {
          code: "PLUGIN_MAKER_ACTION_DENIED",
          reason: "Plugin maker action denied, stale, invalid or not explicitly approved.",
        },
      });
    }
  };
}
