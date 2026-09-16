import type { IncomingMessage, ServerResponse } from "node:http";

import type { SqliteDatabase } from "@zet-harness/db";
import {
  DurableMemoryError,
  MEMORY_KINDS,
  createMemory,
  forgetMemory,
  listMemories,
  readMemory,
  updateMemory,
  type DurableMemoryErrorCode,
  type DurableMemoryKind,
  type ListMemoriesOptions,
} from "@zet-harness/db/durable-memory-records";
import { readProject } from "@zet-harness/db/durable-project-records";
import { SORTABLE_ID_PATTERN, createSortableId } from "@zet-harness/db/sortable-id";

import { RuntimeApiSecurityError, type RuntimeApiSecurity } from "./runtime-api-security.js";
import { writeRuntimeJson } from "./runtime-approval-http.js";

/** Services the memory endpoints need; supplied by the daemon. */
export interface RuntimeMemoryHttpServices {
  readonly database: SqliteDatabase;
  /** UTC epoch milliseconds. Defaults to the system clock. */
  readonly now?: () => number;
  /** Defaults to a sortable UUIDv7. */
  readonly createId?: () => string;
}

const MAX_MEMORY_BODY_BYTES = 65_536;
const MEMORY_FIELDS: readonly string[] = ["title", "body", "kind", "pinned"];
const PROJECT_MEMORIES_PATH = /^\/api\/projects\/([^/]+)\/memories$/u;
const MEMORY_PATH = /^\/api\/memories\/([^/]+)$/u;

const STATUS_FOR: Readonly<Record<DurableMemoryErrorCode, number>> = {
  MEMORY_INVALID: 400,
  MEMORY_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  PROJECT_ARCHIVED: 409,
};

class RuntimeMemoryRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly field: string | undefined;

  constructor(code: string, message: string, statusCode: number, field?: string) {
    super(message);
    this.name = "RuntimeMemoryRequestError";
    this.code = code;
    this.statusCode = statusCode;
    this.field = field;
  }
}

function invalidRequest(message: string, field?: string): RuntimeMemoryRequestError {
  return new RuntimeMemoryRequestError("MEMORY_INVALID", message, 400, field);
}

function memoryNotFound(): RuntimeMemoryRequestError {
  return new RuntimeMemoryRequestError("MEMORY_NOT_FOUND", "No memory exists with this id.", 404);
}

function projectNotFound(): RuntimeMemoryRequestError {
  return new RuntimeMemoryRequestError("PROJECT_NOT_FOUND", "No project exists with this id.", 404);
}

/** Memory paths this handler owns; everything else falls through to the server. */
export function isMemoryHttpPath(pathname: string): boolean {
  return PROJECT_MEMORIES_PATH.test(pathname) || MEMORY_PATH.test(pathname);
}

function methodNotAllowed(response: ServerResponse, allowed: readonly string[]): void {
  response.setHeader("allow", allowed.join(", "));
  writeRuntimeJson(response, 405, { error: "method_not_allowed", allowed });
}

function idFrom(raw: string, missing: () => RuntimeMemoryRequestError): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw missing();
  }
  if (!SORTABLE_ID_PATTERN.test(decoded)) throw missing();
  return decoded;
}

/** A JSON object, or an empty object when the request has no body. */
async function readMemoryBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    size += buffer.length;
    if (size > MAX_MEMORY_BODY_BYTES) {
      request.resume();
      throw new RuntimeApiSecurityError("LOCAL_API_BODY_TOO_LARGE", "Request exceeds 64 KiB.", 413);
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

function onlyFields(body: Record<string, unknown>): void {
  for (const field of Object.keys(body)) {
    if (!MEMORY_FIELDS.includes(field)) {
      throw invalidRequest(`A memory has no '${field}' field.`, field);
    }
  }
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw invalidRequest(`${field} must be text.`, field);
  return value;
}

function optionalKind(body: Record<string, unknown>): DurableMemoryKind | undefined {
  const value = body["kind"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !MEMORY_KINDS.includes(value as DurableMemoryKind)) {
    throw invalidRequest(`kind must be one of: ${MEMORY_KINDS.join(", ")}.`, "kind");
  }
  return value as DurableMemoryKind;
}

function optionalPinned(body: Record<string, unknown>): boolean | undefined {
  const value = body["pinned"];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalidRequest("pinned must be true or false.", "pinned");
  return value;
}

function listOptions(url: URL): ListMemoriesOptions {
  const options: { pinnedOnly?: boolean; kind?: DurableMemoryKind; limit?: number } = {};
  if (url.searchParams.get("pinned") === "true") options.pinnedOnly = true;
  const kind = url.searchParams.get("kind");
  if (kind !== null) {
    if (!MEMORY_KINDS.includes(kind as DurableMemoryKind)) {
      throw invalidRequest(`kind must be one of: ${MEMORY_KINDS.join(", ")}.`, "kind");
    }
    options.kind = kind as DurableMemoryKind;
  }
  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    const parsed = Number(limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw invalidRequest("limit must be a whole number of at least 1.", "limit");
    }
    options.limit = parsed;
  }
  return options;
}

/**
 * What a project remembers.
 *
 * Memories are small pieces of written text a project keeps beyond one
 * conversation: a fact, a preference, a decision, or a plain note. Listing is
 * ordered for recall, pinned first and then most recently changed, and a memory
 * can be removed outright rather than archived, because forgetting is the point.
 */
export async function handleMemoryHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  security: RuntimeApiSecurity,
  services: RuntimeMemoryHttpServices,
): Promise<void> {
  const now = services.now ?? (() => Date.now());
  const createId = services.createId ?? createSortableId;
  const database = services.database;
  try {
    const projectMatch = PROJECT_MEMORIES_PATH.exec(url.pathname);
    if (projectMatch !== null) {
      const projectId = idFrom(projectMatch[1] ?? "", projectNotFound);
      if (request.method === "GET") {
        if (readProject(database.connection(), projectId) === undefined) throw projectNotFound();
        writeRuntimeJson(response, 200, {
          memories: listMemories(database.connection(), projectId, listOptions(url)),
        });
        return;
      }
      if (request.method !== "POST") return methodNotAllowed(response, ["GET", "POST"]);
      security.checkMutation(request);
      const body = await readMemoryBody(request);
      onlyFields(body);
      const kind = optionalKind(body);
      const pinned = optionalPinned(body);
      const memory = await database.commit((connection) =>
        createMemory(connection, {
          memoryId: createId(),
          projectId,
          title: requiredString(body, "title"),
          body: requiredString(body, "body"),
          ...(kind === undefined ? {} : { kind }),
          ...(pinned === undefined ? {} : { pinned }),
          nowMs: now(),
        }),
      );
      writeRuntimeJson(response, 201, { memory });
      return;
    }

    const match = MEMORY_PATH.exec(url.pathname);
    if (match === null) {
      writeRuntimeJson(response, 404, { error: "not_found" });
      return;
    }
    const memoryId = idFrom(match[1] ?? "", memoryNotFound);

    if (request.method === "GET") {
      const memory = readMemory(database.connection(), memoryId);
      if (memory === undefined) throw memoryNotFound();
      writeRuntimeJson(response, 200, { memory });
      return;
    }
    if (request.method === "DELETE") {
      security.checkMutation(request);
      const forgotten = await database.commit((connection) => forgetMemory(connection, memoryId));
      if (!forgotten) throw memoryNotFound();
      writeRuntimeJson(response, 200, { forgotten: true });
      return;
    }
    if (request.method !== "PATCH") {
      return methodNotAllowed(response, ["GET", "PATCH", "DELETE"]);
    }
    security.checkMutation(request);
    const body = await readMemoryBody(request);
    onlyFields(body);
    const kind = optionalKind(body);
    const pinned = optionalPinned(body);
    const title = body["title"] === undefined ? undefined : requiredString(body, "title");
    const text = body["body"] === undefined ? undefined : requiredString(body, "body");
    const memory = await database.commit((connection) =>
      updateMemory(connection, memoryId, {
        ...(title === undefined ? {} : { title }),
        ...(text === undefined ? {} : { body: text }),
        ...(kind === undefined ? {} : { kind }),
        ...(pinned === undefined ? {} : { pinned }),
        nowMs: now(),
      }),
    );
    if (memory === undefined) throw memoryNotFound();
    writeRuntimeJson(response, 200, { memory });
  } catch (error: unknown) {
    if (error instanceof RuntimeMemoryRequestError || error instanceof DurableMemoryError) {
      const statusCode =
        error instanceof RuntimeMemoryRequestError ? error.statusCode : STATUS_FOR[error.code];
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
