import type { IncomingMessage, ServerResponse } from "node:http";
import { SORTABLE_ID_PATTERN } from "@zet-harness/db/sortable-id";
import { writeRuntimeJson } from "./runtime-approval-http.js";
import { RuntimeApiSecurityError, type RuntimeApiSecurity } from "./runtime-api-security.js";
import { type RuntimeTerminalService, TerminalError } from "./runtime-terminal-service.js";
import type {
  RuntimeTerminalAuthority,
  TerminalAuthorityScope,
} from "./runtime-terminal-authority.js";

export interface TerminalHttpServices {
  readonly service: RuntimeTerminalService;
  /** Trusted host lookup; a request cannot supply cwd or terminal authority. */
  readonly conversationRoot: (conversationId: string) => Promise<string>;
  readonly authority?: RuntimeTerminalAuthority;
}

export function createTerminalHttpHandler(services: TerminalHttpServices) {
  const scope = async (identity: {
    ownerKey: string;
    conversationId: string;
  }): Promise<TerminalAuthorityScope> => {
    const capability = services.service.capability(identity);
    if (
      !services.authority ||
      capability.mode !== "human-host-pty" ||
      capability.reason === "Terminal service is stopped." ||
      !capability.authorityIdentity ||
      !capability.shell
    )
      throw new TerminalError(
        "TERMINAL_UNAVAILABLE",
        "A configured human terminal adapter is required.",
        409,
      );
    try {
      const cwd = await services.conversationRoot(identity.conversationId);
      return {
        cwd,
        shell: capability.shell,
        windowsIdentity: capability.authorityIdentity,
        trusted: true,
      };
    } catch {
      services.authority.revoke(identity);
      await Promise.all(
        services.service
          .list(identity)
          .sessions.map((session) =>
            services.service.close(identity, session.id).catch(() => undefined),
          ),
      );
      throw new TerminalError(
        "TERMINAL_FOLDER_UNTRUSTED",
        "Select and trust this chat's folder before reviewing terminal authority.",
        409,
      );
    }
  };
  const validateSessions = async (identity: { ownerKey: string; conversationId: string }) => {
    const sessions = services.service.list(identity).sessions;
    if (!sessions.length) return;
    try {
      const currentRoot = await services.conversationRoot(identity.conversationId);
      if (sessions.some((session) => session.cwd !== currentRoot))
        throw new Error("Folder changed");
    } catch {
      await Promise.all(
        sessions.map((session) =>
          services.service.close(identity, session.id).catch(() => undefined),
        ),
      );
      throw new TerminalError(
        "TERMINAL_FOLDER_UNTRUSTED",
        "Terminal folder authority was revoked.",
        409,
      );
    }
  };
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    security: RuntimeApiSecurity,
  ) => {
    if (request.method !== "GET" && request.method !== "POST") {
      writeRuntimeJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
      return;
    }
    // Output is private to the opaque browser owner too. GET is not an anonymous read.
    security.checkMutation(request);
    const ownerKey = request.headers["x-zet-terminal-owner"];
    if (typeof ownerKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ownerKey))
      throw new RuntimeApiSecurityError(
        "TERMINAL_AUTH_REQUIRED",
        "A current terminal session is required.",
      );
    try {
      if (request.method === "GET") {
        if ([...url.searchParams.keys()].some((key) => !["conversationId", "after"].includes(key)))
          throw new TerminalError("TERMINAL_INVALID", "Invalid terminal request.");
        const conversationId = url.searchParams.get("conversationId") ?? "";
        if (!SORTABLE_ID_PATTERN.test(conversationId))
          throw new TerminalError("TERMINAL_INVALID", "Select a chat first.");
        const cursor = url.searchParams.get("after") ?? "0";
        if (!/^(0|[1-9]\d*)$/.test(cursor))
          throw new TerminalError("TERMINAL_INVALID", "Invalid output cursor.");
        const identity = { ownerKey, conversationId };
        let grantReview;
        if (services.authority && services.service.capability(identity).mode === "human-host-pty") {
          const current = await scope(identity);
          const granted = services.authority.get(identity);
          if (
            granted &&
            (granted.cwd !== current.cwd ||
              granted.shell !== current.shell ||
              granted.windowsIdentity !== current.windowsIdentity)
          )
            services.authority.revoke(identity);
          if (!services.service.capability(identity).launch)
            grantReview = services.authority.review(identity, current);
        }
        await validateSessions(identity);
        writeRuntimeJson(response, 200, {
          ...services.service.list(identity, Number(cursor)),
          ...(grantReview ? { grantReview } : {}),
        });
        return;
      }
      let text = "";
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        text += String(chunk);
        if (Buffer.byteLength(text) > 16_384) {
          request.resume();
          writeRuntimeJson(response, 413, { error: { code: "BODY_TOO_LARGE" } });
          return;
        }
      }
      let body: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        body = value as Record<string, unknown>;
      } catch {
        throw new TerminalError("TERMINAL_INVALID", "Invalid terminal request.");
      }
      const fields: Record<string, readonly string[]> = {
        create: ["action", "conversationId", "cols", "rows"],
        input: ["action", "conversationId", "terminalId", "text"],
        resize: ["action", "conversationId", "terminalId", "cols", "rows"],
        interrupt: ["action", "conversationId", "terminalId"],
        stop: ["action", "conversationId", "terminalId"],
        close: ["action", "conversationId", "terminalId"],
        grant: ["action", "conversationId", "nonce", "confirm"],
        revoke: ["action", "conversationId"],
      };
      const action = body["action"];
      const conversationId = body["conversationId"];
      if (
        typeof action !== "string" ||
        !Object.hasOwn(fields, action) ||
        Object.keys(body).some((key) => !fields[action]!.includes(key)) ||
        typeof conversationId !== "string" ||
        !SORTABLE_ID_PATTERN.test(conversationId)
      )
        throw new TerminalError("TERMINAL_INVALID", "Invalid terminal request.");
      const identity = { ownerKey, conversationId };
      if (action === "grant") {
        if (
          Object.keys(body).length !== 4 ||
          typeof body["nonce"] !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(body["nonce"]) ||
          body["confirm"] !== true
        )
          throw new TerminalError(
            "TERMINAL_INVALID",
            "Review and explicitly confirm terminal authority.",
          );
        const current = await scope(identity);
        services.authority!.confirm(identity, { nonce: body["nonce"], confirm: true }, current);
        writeRuntimeJson(response, 200, {
          result: { granted: true },
          capability: services.service.capability(identity),
        });
        return;
      }
      if (action === "revoke") {
        if (Object.keys(body).length !== 2 || !services.authority)
          throw new TerminalError("TERMINAL_INVALID", "Invalid terminal authority action.");
        services.authority.revoke(identity);
        await Promise.all(
          services.service
            .list(identity)
            .sessions.map((session) => services.service.close(identity, session.id)),
        );
        writeRuntimeJson(response, 200, {
          result: { revoked: true },
          capability: services.service.capability(identity),
        });
        return;
      }
      if (action === "create") {
        const cwd = await services.conversationRoot(conversationId);
        const result = await services.service.create(
          identity,
          cwd,
          body["cols"] === undefined ? 80 : (body["cols"] as number),
          body["rows"] === undefined ? 24 : (body["rows"] as number),
        );
        writeRuntimeJson(response, 200, { result });
        return;
      }
      const id = body["terminalId"];
      if (typeof id !== "string" || id.length > 200)
        throw new TerminalError("TERMINAL_INVALID", "Invalid terminal identity.");
      if (action !== "close") await validateSessions(identity);
      if (action === "input") await services.service.input(identity, id, body["text"] as string);
      else if (action === "resize")
        await services.service.resize(identity, id, body["cols"] as number, body["rows"] as number);
      else if (action === "interrupt") await services.service.interrupt(identity, id);
      else if (action === "stop") await services.service.stop(identity, id);
      else await services.service.close(identity, id);
      if (action === "close" && services.service.list(identity).sessions.length === 0)
        services.authority?.revoke(identity);
      writeRuntimeJson(response, 200, { result: { accepted: true } });
    } catch (error) {
      writeRuntimeJson(response, error instanceof TerminalError ? error.statusCode : 400, {
        error: {
          code: error instanceof TerminalError ? error.code : "TERMINAL_REQUEST_FAILED",
          reason:
            error instanceof TerminalError && error.code === "TERMINAL_UNAVAILABLE"
              ? services.service.capability().reason
              : "Terminal request failed or was refused. Check the chat, session and backend availability.",
        },
      });
    }
  };
}
