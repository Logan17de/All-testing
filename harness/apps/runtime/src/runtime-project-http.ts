import type { IncomingMessage, ServerResponse } from "node:http";

import type { SqliteDatabase } from "@zet-harness/db";
import {
  DurableProjectError,
  archiveProject,
  createProject,
  listProjects,
  readProject,
  restoreProject,
  updateProject,
  type DurableProjectRecord,
  type ProjectListStatus,
} from "@zet-harness/db/durable-project-records";
import { SORTABLE_ID_PATTERN, createSortableId } from "@zet-harness/db/sortable-id";

import { RuntimeApiSecurityError, type RuntimeApiSecurity } from "./runtime-api-security.js";
import { writeRuntimeJson } from "./runtime-approval-http.js";

/** Services the project endpoints need; supplied by the daemon. */
export interface RuntimeProjectHttpServices {
  readonly database: SqliteDatabase;
  /** UTC epoch milliseconds. Defaults to the system clock. */
  readonly now?: () => number;
  /** Defaults to a sortable UUIDv7. */
  readonly createId?: () => string;
}

const MAX_PROJECT_BODY_BYTES = 65_536;
const PROJECT_FIELDS: ReadonlySet<string> = new Set(["name", "description", "workspacePath"]);

class RuntimeProjectRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly field: string | undefined;

  constructor(code: string, message: string, statusCode: number, field?: string) {
    super(message);
    this.name = "RuntimeProjectRequestError";
    this.code = code;
    this.statusCode = statusCode;
    this.field = field;
  }
}

function invalidRequest(message: string, field?: string): RuntimeProjectRequestError {
  return new RuntimeProjectRequestError("PROJECT_INVALID", message, 400, field);
}

function notFound(): RuntimeProjectRequestError {
  return new RuntimeProjectRequestError(
    "PROJECT_NOT_FOUND",
    "No project exists with this id.",
    404,
  );
}

/** Project paths this handler owns; everything else falls through to the server. */
export function isProjectHttpPath(pathname: string): boolean {
  return pathname === "/api/projects" || pathname.startsWith("/api/projects/");
}

function methodNotAllowed(response: ServerResponse, allowed: readonly string[]): void {
  response.setHeader("allow", allowed.join(", "));
  writeRuntimeJson(response, 405, { error: "method_not_allowed", allowed });
}

/** A JSON object, or an empty object when the request has no body. */
async function readProjectBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    size += buffer.length;
    if (size > MAX_PROJECT_BODY_BYTES) {
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

interface ProjectFields {
  readonly name?: string;
  readonly description?: string;
  readonly workspacePath?: string | null;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidRequest(`${field} must be a string.`, field);
  return value;
}

function projectFields(body: Record<string, unknown>): ProjectFields {
  for (const field of Object.keys(body)) {
    if (!PROJECT_FIELDS.has(field))
      throw invalidRequest(`Unknown project field '${field}'.`, field);
  }
  const name = optionalString(body, "name");
  const description = optionalString(body, "description");
  const workspacePath =
    body["workspacePath"] === null ? null : optionalString(body, "workspacePath");
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(workspacePath === undefined ? {} : { workspacePath }),
  };
}

function listStatus(url: URL): ProjectListStatus {
  const status = url.searchParams.get("status") ?? "active";
  if (status === "active" || status === "archived" || status === "all") return status;
  throw invalidRequest("status must be active, archived or all.", "status");
}

function projectIdFrom(segment: string): string {
  let projectId: string;
  try {
    projectId = decodeURIComponent(segment);
  } catch {
    throw notFound();
  }
  if (!SORTABLE_ID_PATTERN.test(projectId)) throw notFound();
  return projectId;
}

function found(project: DurableProjectRecord | undefined): DurableProjectRecord {
  if (project === undefined) throw notFound();
  return project;
}

/**
 * Project endpoints.
 *
 *   GET  /api/projects?status=active|archived|all
 *   POST /api/projects                    { name, description?, workspacePath? }
 *   GET  /api/projects/:id
 *   POST /api/projects/:id                { name?, description?, workspacePath? }
 *   POST /api/projects/:id/archive
 *   POST /api/projects/:id/restore
 *
 * Projects are archived and restored, never deleted. Every POST passes the same
 * CSRF check as the editor and approval endpoints, and every write is one
 * serialized SQLite commit.
 */
export async function handleProjectHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  security: RuntimeApiSecurity,
  services: RuntimeProjectHttpServices,
): Promise<void> {
  const now = services.now ?? (() => Date.now());
  const createId = services.createId ?? createSortableId;
  try {
    if (url.pathname === "/api/projects") {
      if (request.method === "GET") {
        writeRuntimeJson(response, 200, {
          projects: listProjects(services.database.connection(), { status: listStatus(url) }),
        });
        return;
      }
      if (request.method !== "POST") return methodNotAllowed(response, ["GET", "POST"]);
      security.checkMutation(request);
      const fields = projectFields(await readProjectBody(request));
      const name = fields.name;
      if (name === undefined) throw invalidRequest("A project needs a name.", "name");
      const project = await services.database.commit((connection) =>
        createProject(connection, { ...fields, name, projectId: createId(), nowMs: now() }),
      );
      writeRuntimeJson(response, 201, { project });
      return;
    }

    const match = /^\/api\/projects\/([^/]+)(?:\/(archive|restore))?$/u.exec(url.pathname);
    if (match === null) throw notFound();
    const projectId = projectIdFrom(match[1] ?? "");
    const action = match[2];

    if (action === undefined && request.method === "GET") {
      writeRuntimeJson(response, 200, {
        project: found(readProject(services.database.connection(), projectId)),
      });
      return;
    }
    if (request.method !== "POST") {
      return methodNotAllowed(response, action === undefined ? ["GET", "POST"] : ["POST"]);
    }
    security.checkMutation(request);
    const body = await readProjectBody(request);

    let project: DurableProjectRecord | undefined;
    if (action === undefined) {
      const fields = projectFields(body);
      project = await services.database.commit((connection) =>
        updateProject(connection, projectId, { ...fields, nowMs: now() }),
      );
    } else {
      if (Object.keys(body).length > 0) throw invalidRequest(`${action} takes no fields.`);
      project = await services.database.commit((connection) =>
        action === "archive"
          ? archiveProject(connection, projectId, now())
          : restoreProject(connection, projectId, now()),
      );
    }
    writeRuntimeJson(response, 200, { project: found(project) });
  } catch (error: unknown) {
    if (error instanceof RuntimeProjectRequestError || error instanceof DurableProjectError) {
      const statusCode =
        error instanceof RuntimeProjectRequestError
          ? error.statusCode
          : error.code === "PROJECT_ARCHIVED"
            ? 409
            : 400;
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
