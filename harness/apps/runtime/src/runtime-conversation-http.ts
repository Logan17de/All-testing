import type { IncomingMessage, ServerResponse } from "node:http";

import type { SqliteDatabase } from "@zet-harness/db";
import {
  DurableConversationError,
  appendMessage,
  archiveConversation,
  createConversation,
  listConversations,
  readConversation,
  readConversationMessages,
  readMessagePath,
  renameConversation,
  restoreConversation,
  type ConversationListStatus,
  type DurableConversationErrorCode,
  type DurableConversationRecord,
  type DurableMessagePart,
  type DurableMessageRole,
} from "@zet-harness/db/durable-conversation-records";
import { readProject } from "@zet-harness/db/durable-project-records";
import { SORTABLE_ID_PATTERN, createSortableId } from "@zet-harness/db/sortable-id";

import { RuntimeApiSecurityError, type RuntimeApiSecurity } from "./runtime-api-security.js";
import { writeRuntimeJson } from "./runtime-approval-http.js";

/** Services the conversation endpoints need; supplied by the daemon. */
export interface RuntimeConversationHttpServices {
  readonly database: SqliteDatabase;
  /** UTC epoch milliseconds. Defaults to the system clock. */
  readonly now?: () => number;
  /** Defaults to a sortable UUIDv7. */
  readonly createId?: () => string;
}

/** Messages carry up to 1 MiB of parts, so the body cap matches. */
const MAX_CONVERSATION_BODY_BYTES = 1_048_576;

const PROJECT_CONVERSATIONS_PATH = /^\/api\/projects\/([^/]+)\/conversations$/u;
const MESSAGE_PATH_PATH = /^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/path$/u;
const CONVERSATION_PATH = /^\/api\/conversations\/([^/]+)(?:\/(archive|restore|messages))?$/u;

class RuntimeConversationRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly field: string | undefined;

  constructor(code: string, message: string, statusCode: number, field?: string) {
    super(message);
    this.name = "RuntimeConversationRequestError";
    this.code = code;
    this.statusCode = statusCode;
    this.field = field;
  }
}

function invalidRequest(message: string, field?: string): RuntimeConversationRequestError {
  return new RuntimeConversationRequestError("CONVERSATION_INVALID", message, 400, field);
}

const projectNotFound = (): RuntimeConversationRequestError =>
  new RuntimeConversationRequestError("PROJECT_NOT_FOUND", "No project exists with this id.", 404);
const conversationNotFound = (): RuntimeConversationRequestError =>
  new RuntimeConversationRequestError(
    "CONVERSATION_NOT_FOUND",
    "No conversation exists with this id.",
    404,
  );
const messageNotFound = (): RuntimeConversationRequestError =>
  new RuntimeConversationRequestError(
    "MESSAGE_NOT_FOUND",
    "No message with this id is part of this conversation.",
    404,
  );

const STATUS_FOR: Readonly<Record<DurableConversationErrorCode, number>> = {
  CONVERSATION_INVALID: 400,
  CONVERSATION_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  CONVERSATION_ARCHIVED: 409,
  PROJECT_ARCHIVED: 409,
};

/**
 * Conversation paths this handler owns. The server checks them before project
 * paths, because `/api/projects/:id/conversations` belongs here.
 */
export function isConversationHttpPath(pathname: string): boolean {
  return (
    PROJECT_CONVERSATIONS_PATH.test(pathname) ||
    pathname === "/api/conversations" ||
    pathname.startsWith("/api/conversations/")
  );
}

function methodNotAllowed(response: ServerResponse, allowed: readonly string[]): void {
  response.setHeader("allow", allowed.join(", "));
  writeRuntimeJson(response, 405, { error: "method_not_allowed", allowed });
}

/** A JSON object, or an empty object when the request has no body. */
async function readConversationBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    size += buffer.length;
    if (size > MAX_CONVERSATION_BODY_BYTES) {
      request.resume();
      throw new RuntimeApiSecurityError("LOCAL_API_BODY_TOO_LARGE", "Request exceeds 1 MiB.", 413);
    }
    parts.push(buffer);
  }
  if (size === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } catch {
    throw invalidRequest("Request body is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function onlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const field of Object.keys(body)) {
    if (!allowed.includes(field)) throw invalidRequest(`Unknown field '${field}'.`, field);
  }
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidRequest(`${field} must be a string.`, field);
  return value;
}

function parentFrom(body: Record<string, unknown>): string | null | undefined {
  const value = body["parentMessageId"];
  if (value === undefined || value === null || typeof value === "string") return value;
  throw invalidRequest("parentMessageId must be a string or null.", "parentMessageId");
}

function listStatus(url: URL): ConversationListStatus {
  const status = url.searchParams.get("status") ?? "active";
  if (status === "active" || status === "archived" || status === "all") return status;
  throw invalidRequest("status must be active, archived or all.", "status");
}

function idFrom(segment: string, missing: () => RuntimeConversationRequestError): string {
  let id: string;
  try {
    id = decodeURIComponent(segment);
  } catch {
    throw missing();
  }
  if (!SORTABLE_ID_PATTERN.test(id)) throw missing();
  return id;
}

function found(conversation: DurableConversationRecord | undefined): DurableConversationRecord {
  if (conversation === undefined) throw conversationNotFound();
  return conversation;
}

/**
 * Conversation endpoints.
 *
 *   GET  /api/projects/:projectId/conversations?status=active|archived|all
 *   POST /api/projects/:projectId/conversations        { title? }
 *   GET  /api/conversations/:id                         conversation and every message
 *   POST /api/conversations/:id                         { title }
 *   POST /api/conversations/:id/archive | /restore
 *   POST /api/conversations/:id/messages                { role, parts, parentMessageId? }
 *   GET  /api/conversations/:id/messages/:messageId/path
 *
 * Messages are append-only; an edit or retry is a new message that names the
 * original's parent. Every POST passes the shared CSRF check, and every write is
 * one serialized SQLite commit.
 */
export async function handleConversationHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  security: RuntimeApiSecurity,
  services: RuntimeConversationHttpServices,
): Promise<void> {
  const now = services.now ?? (() => Date.now());
  const createId = services.createId ?? createSortableId;
  const database = services.database;
  try {
    const projectMatch = PROJECT_CONVERSATIONS_PATH.exec(url.pathname);
    if (projectMatch !== null) {
      const projectId = idFrom(projectMatch[1] ?? "", projectNotFound);
      if (request.method === "GET") {
        if (readProject(database.connection(), projectId) === undefined) throw projectNotFound();
        writeRuntimeJson(response, 200, {
          conversations: listConversations(database.connection(), projectId, {
            status: listStatus(url),
          }),
        });
        return;
      }
      if (request.method !== "POST") return methodNotAllowed(response, ["GET", "POST"]);
      security.checkMutation(request);
      const body = await readConversationBody(request);
      onlyFields(body, ["title"]);
      const title = optionalString(body, "title");
      const conversation = await database.commit((connection) =>
        createConversation(connection, {
          conversationId: createId(),
          projectId,
          ...(title === undefined ? {} : { title }),
          nowMs: now(),
        }),
      );
      writeRuntimeJson(response, 201, { conversation });
      return;
    }

    const pathMatch = MESSAGE_PATH_PATH.exec(url.pathname);
    if (pathMatch !== null) {
      if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
      const conversationId = idFrom(pathMatch[1] ?? "", conversationNotFound);
      const messageId = idFrom(pathMatch[2] ?? "", messageNotFound);
      const messages = readMessagePath(database.connection(), messageId);
      if (
        messages.length === 0 ||
        messages.some((item) => item.conversationId !== conversationId)
      ) {
        throw messageNotFound();
      }
      writeRuntimeJson(response, 200, { messages });
      return;
    }

    const match = CONVERSATION_PATH.exec(url.pathname);
    if (match === null) throw conversationNotFound();
    const conversationId = idFrom(match[1] ?? "", conversationNotFound);
    const action = match[2];

    if (action === undefined && request.method === "GET") {
      const conversation = found(readConversation(database.connection(), conversationId));
      writeRuntimeJson(response, 200, {
        conversation,
        messages: readConversationMessages(database.connection(), conversationId),
      });
      return;
    }
    if (request.method !== "POST") {
      return methodNotAllowed(response, action === undefined ? ["GET", "POST"] : ["POST"]);
    }
    security.checkMutation(request);
    const body = await readConversationBody(request);

    if (action === "messages") {
      onlyFields(body, ["role", "parts", "parentMessageId"]);
      const role = body["role"];
      if (typeof role !== "string") throw invalidRequest("role must be a string.", "role");
      const parts = body["parts"];
      if (!Array.isArray(parts)) throw invalidRequest("parts must be an array.", "parts");
      const parentMessageId = parentFrom(body);
      const messageRole = role as DurableMessageRole;
      const messageParts = parts as readonly DurableMessagePart[];
      const message = await database.commit((connection) =>
        appendMessage(connection, {
          messageId: createId(),
          conversationId,
          role: messageRole,
          parts: messageParts,
          ...(parentMessageId === undefined ? {} : { parentMessageId }),
          nowMs: now(),
        }),
      );
      writeRuntimeJson(response, 201, { message });
      return;
    }

    let conversation: DurableConversationRecord | undefined;
    if (action === undefined) {
      onlyFields(body, ["title"]);
      const title = optionalString(body, "title");
      if (title === undefined) throw invalidRequest("A new title is required.", "title");
      conversation = await database.commit((connection) =>
        renameConversation(connection, conversationId, title, now()),
      );
    } else {
      if (Object.keys(body).length > 0) throw invalidRequest(`${action} takes no fields.`);
      conversation = await database.commit((connection) =>
        action === "archive"
          ? archiveConversation(connection, conversationId, now())
          : restoreConversation(connection, conversationId, now()),
      );
    }
    writeRuntimeJson(response, 200, { conversation: found(conversation) });
  } catch (error: unknown) {
    if (
      error instanceof RuntimeConversationRequestError ||
      error instanceof DurableConversationError
    ) {
      const statusCode =
        error instanceof RuntimeConversationRequestError
          ? error.statusCode
          : STATUS_FOR[error.code];
      writeRuntimeJson(response, statusCode, {
        error: {
          code: error.code,
          reason: error.message,
          ...(error.field === undefined ? {} : { field: error.field }),
        },
      });
      return;
    }
    throw error;
  }
}
