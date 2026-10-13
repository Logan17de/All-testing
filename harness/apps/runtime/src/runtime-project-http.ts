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
import { checkWorkspace, SetupRequestError } from "./runtime-setup-http.js";
import { writeSetting } from "@zet-harness/db/durable-setting-records";
import {
  PROJECT_FEATURES,
  projectWithMetadata,
  readProjectMetadata,
  writeProjectMetadata,
} from "./runtime-project-metadata.js";
import { archiveConversation } from "@zet-harness/db/durable-conversation-records";

/** Services the project endpoints need; supplied by the daemon. */
export interface RuntimeProjectHttpServices {
  readonly database: SqliteDatabase;
  /** UTC epoch milliseconds. Defaults to the system clock. */
  readonly now?: () => number;
  /** Defaults to a sortable UUIDv7. */
  readonly createId?: () => string;
}

const MAX_PROJECT_BODY_BYTES = 65_536;
const PROJECT_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "workspacePath",
  "trusted",
  "sourceFolders",
  "pinned",
  "section",
]);

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
  if (body.trusted !== undefined && body.trusted !== true)
    throw invalidRequest("Confirm trust for this exact folder.", "trusted");
  if (body.pinned !== undefined && typeof body.pinned !== "boolean")
    throw invalidRequest("pinned must be a boolean.", "pinned");
  if (
    body.section !== undefined &&
    body.section !== null &&
    (typeof body.section !== "string" ||
      body.section.trim().length === 0 ||
      body.section.length > 80 ||
      /[\x00-\x1f\x7f]/u.test(body.section))
  )
    throw invalidRequest("section must be null or a name of 1–80 characters.", "section");
  if (
    body.sourceFolders !== undefined &&
    (!Array.isArray(body.sourceFolders) ||
      body.sourceFolders.length < 1 ||
      body.sourceFolders.length > 20 ||
      body.sourceFolders.some((value: unknown) => typeof value !== "string"))
  )
    throw invalidRequest("Choose between 1 and 20 source folders.", "sourceFolders");
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
 *   POST /api/projects                    { name, trusted:true, workspacePath? | sourceFolders, pinned?, section? }
 *   GET  /api/projects/:id
 *   POST /api/projects/:id                { name?, description?, workspacePath?, sourceFolders?, trusted?, pinned?, section? }
 *   POST /api/projects/:id/archive
 *   POST /api/projects/:id/restore
 *   POST /api/projects/:id/archive-chats  {}
 *   POST /api/projects/:id/remove         {} (soft archive, never disk deletion)
 *
 * Projects are archived and restored, never deleted. Every POST passes the same
 * CSRF check as the editor and approval endpoints, and every write is one
 * serialized SQLite commit.
 * Source folders after the first are metadata only; existing tool/terminal
 * authority continues to resolve the primary workspacePath.
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
  const enrich = (project: DurableProjectRecord) =>
    projectWithMetadata(services.database.connection(), project);
  try {
    if (url.pathname === "/api/projects") {
      if (request.method === "GET") {
        writeRuntimeJson(response, 200, {
          projects: listProjects(services.database.connection(), { status: listStatus(url) }).map(
            enrich,
          ),
          projectFeatures: PROJECT_FEATURES,
        });
        return;
      }
      if (request.method !== "POST") return methodNotAllowed(response, ["GET", "POST"]);
      security.checkMutation(request);
      const body = await readProjectBody(request);
      const fields = projectFields(body);
      const name = fields.name;
      if (name === undefined) throw invalidRequest("A project needs a name.", "name");
      if (fields.workspacePath == null && body.sourceFolders === undefined)
        throw invalidRequest("Choose a project folder.", "workspacePath");
      if (body.trusted !== true)
        throw invalidRequest("Confirm trust for this exact folder.", "trusted");
      const folders =
        body.sourceFolders === undefined
          ? [await checkWorkspace(fields.workspacePath)]
          : await Promise.all((body.sourceFolders as string[]).map(checkWorkspace));
      if (new Set(folders).size !== folders.length)
        throw invalidRequest("Source folders must be unique.", "sourceFolders");
      const workspacePath = folders[0]!;
      if (
        fields.workspacePath !== undefined &&
        (await checkWorkspace(fields.workspacePath)) !== workspacePath
      )
        throw invalidRequest(
          "The primary folder must be the first source folder.",
          "workspacePath",
        );
      const project = await services.database.commit((connection) => {
        const created = createProject(connection, {
          ...fields,
          workspacePath,
          name,
          projectId: createId(),
          nowMs: now(),
        });
        writeSetting(connection, `project.trusted.${created.projectId}`, workspacePath, now());
        writeProjectMetadata(
          connection,
          created.projectId,
          {
            pinned: body.pinned === true,
            section: typeof body.section === "string" ? body.section.trim() : null,
            sourceFolders: folders,
          },
          now(),
        );
        return created;
      });
      writeRuntimeJson(response, 201, {
        project: enrich(project),
        projectFeatures: PROJECT_FEATURES,
      });
      return;
    }

    const match = /^\/api\/projects\/([^/]+)(?:\/(archive|restore|archive-chats|remove))?$/u.exec(
      url.pathname,
    );
    if (match === null) throw notFound();
    const projectId = projectIdFrom(match[1] ?? "");
    const action = match[2];

    if (action === undefined && request.method === "GET") {
      writeRuntimeJson(response, 200, {
        project: enrich(found(readProject(services.database.connection(), projectId))),
        projectFeatures: PROJECT_FEATURES,
      });
      return;
    }
    if (request.method !== "POST") {
      return methodNotAllowed(response, action === undefined ? ["GET", "POST"] : ["POST"]);
    }
    security.checkMutation(request);
    const body = await readProjectBody(request);

    let project: DurableProjectRecord | undefined;
    let archivedChats: number | undefined;
    if (action === undefined) {
      const fields = projectFields(body);
      const prior = found(readProject(services.database.connection(), projectId));
      const priorMetadata = readProjectMetadata(services.database.connection(), prior);
      let folders =
        body.sourceFolders === undefined
          ? undefined
          : await Promise.all((body.sourceFolders as string[]).map(checkWorkspace));
      if (folders && new Set(folders).size !== folders.length)
        throw invalidRequest("Source folders must be unique.", "sourceFolders");
      let workspacePath = fields.workspacePath;
      if (workspacePath !== undefined) {
        if (workspacePath === null || body.trusted !== true)
          throw invalidRequest("Confirm trust for the selected folder.", "trusted");
        workspacePath = await checkWorkspace(workspacePath);
      }
      if (folders) {
        if (workspacePath !== undefined && workspacePath !== folders[0])
          throw invalidRequest(
            "The primary folder must be the first source folder.",
            "workspacePath",
          );
        if (
          body.trusted !== true &&
          (folders[0] !== prior.workspacePath ||
            folders.some((folder) => !priorMetadata.sourceFolders.includes(folder)))
        )
          throw invalidRequest(
            "Confirm trust for newly added or primary source folders.",
            "trusted",
          );
        workspacePath = folders[0]!;
      } else if (workspacePath !== undefined) {
        folders = [
          workspacePath,
          ...priorMetadata.sourceFolders.slice(1).filter((folder) => folder !== workspacePath),
        ];
      }
      project = await services.database.commit((connection) => {
        const current = found(readProject(connection, projectId));
        const metadata = readProjectMetadata(connection, current);
        if (
          folders &&
          (current.workspacePath !== prior.workspacePath ||
            JSON.stringify(metadata.sourceFolders) !== JSON.stringify(priorMetadata.sourceFolders))
        )
          throw invalidRequest("Project folders changed. Review them again.", "sourceFolders");
        const updated = updateProject(connection, projectId, {
          ...fields,
          ...(workspacePath === undefined ? {} : { workspacePath }),
          nowMs: now(),
        });
        if (updated && workspacePath !== undefined && body.trusted === true)
          writeSetting(connection, `project.trusted.${projectId}`, workspacePath, now());
        if (updated)
          writeProjectMetadata(
            connection,
            projectId,
            {
              pinned: typeof body.pinned === "boolean" ? body.pinned : metadata.pinned,
              section:
                body.section === null
                  ? null
                  : typeof body.section === "string"
                    ? body.section.trim()
                    : metadata.section,
              sourceFolders: folders ?? metadata.sourceFolders,
            },
            now(),
          );
        return updated;
      });
    } else {
      if (Object.keys(body).length > 0) throw invalidRequest(`${action} takes no fields.`);
      project = await services.database.commit((connection) => {
        const current = found(readProject(connection, projectId));
        if (action === "archive-chats") {
          if (current.status !== "active")
            throw new DurableProjectError(
              "PROJECT_ARCHIVED",
              "Restore this project before archiving its chats.",
            );
          const rows = connection
            .prepare(
              "SELECT conversation_id FROM conversations WHERE project_id=? AND status='active'",
            )
            .all(projectId) as { conversation_id: string }[];
          for (const row of rows) archiveConversation(connection, row.conversation_id, now());
          archivedChats = rows.length;
          return current;
        }
        return action === "restore"
          ? restoreProject(connection, projectId, now())
          : archiveProject(connection, projectId, now());
      });
    }
    writeRuntimeJson(response, 200, {
      project: enrich(found(project)),
      projectFeatures: PROJECT_FEATURES,
      ...(archivedChats === undefined ? {} : { archivedChats }),
    });
  } catch (error: unknown) {
    if (
      error instanceof RuntimeProjectRequestError ||
      error instanceof DurableProjectError ||
      error instanceof SetupRequestError
    ) {
      const statusCode =
        error instanceof RuntimeProjectRequestError || error instanceof SetupRequestError
          ? error.statusCode
          : error.code === "PROJECT_ARCHIVED"
            ? 409
            : 400;
      writeRuntimeJson(response, statusCode, {
        error: {
          code: error.code,
          reason: error.message,
          ...("field" in error && error.field !== undefined ? { field: error.field } : {}),
        },
      });
      return;
    }
    throw error;
  }
}
