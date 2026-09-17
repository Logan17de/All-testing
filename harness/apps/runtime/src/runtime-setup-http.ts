import { existsSync, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import type { SqliteDatabase } from "@zet-harness/db";
import { listModelConfigs } from "@zet-harness/db/durable-model-records";
import { readSetting, writeSetting } from "@zet-harness/db/durable-setting-records";

import { RuntimeApiSecurityError, type RuntimeApiSecurity } from "./runtime-api-security.js";
import { writeRuntimeJson } from "./runtime-approval-http.js";

export interface RuntimeSetupHttpServices {
  readonly database: SqliteDatabase;
  /** UTC epoch milliseconds. Defaults to the system clock. */
  readonly now?: () => number;
  /** Where the folder browser starts. Defaults to the person's home folder. */
  readonly home?: string;
  /** Defaults to this machine's platform. */
  readonly platform?: NodeJS.Platform;
}

const SETUP_PATH = "/api/setup";
const WORKSPACE_PATH = "/api/setup/workspace";
const FOLDERS_PATH = "/api/setup/folders";
const MAX_BODY_BYTES = 8_192;
const MAX_FOLDERS = 500;

class SetupRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "SetupRequestError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function isSetupHttpPath(pathname: string): boolean {
  return pathname === SETUP_PATH || pathname === WORKSPACE_PATH || pathname === FOLDERS_PATH;
}

export interface WorkspaceView {
  readonly path: string;
  /** False when the folder was chosen once and has since gone. */
  readonly exists: boolean;
}

/** The workspace a person chose, if they have chosen one. */
export function readWorkspace(database: SqliteDatabase): WorkspaceView | undefined {
  const setting = readSetting(database.connection(), "workspace.root");
  const path = setting?.value;
  if (typeof path !== "string") return undefined;
  return { path, exists: existsSync(path) };
}

function methodNotAllowed(response: ServerResponse, allowed: readonly string[]): void {
  response.setHeader("allow", allowed.join(", "));
  writeRuntimeJson(response, 405, { error: "method_not_allowed", allowed });
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      throw new RuntimeApiSecurityError("LOCAL_API_BODY_TOO_LARGE", "Request exceeds 8 KiB.", 413);
    }
    parts.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Fall through to the shared refusal.
  }
  throw new SetupRequestError("SETUP_REQUEST_INVALID", "The request must be a JSON object.", 400);
}

function isRoot(path: string): boolean {
  return parse(path).root === path;
}

/**
 * The folder a workspace would be, or why it cannot be.
 *
 * A whole drive is refused: a workspace is where agent steps may read and change
 * files, and that should be a project folder, not everything on a disk.
 */
async function checkWorkspace(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SetupRequestError("WORKSPACE_INVALID", "Choose a folder.", 400);
  }
  const requested = value.trim();
  if (!isAbsolute(requested)) {
    throw new SetupRequestError(
      "WORKSPACE_INVALID",
      "Give the folder's full path, starting from the drive or /.",
      400,
    );
  }
  let info;
  try {
    info = await stat(requested);
  } catch {
    throw new SetupRequestError("WORKSPACE_NOT_FOUND", "That folder does not exist.", 404);
  }
  if (!info.isDirectory()) {
    throw new SetupRequestError("WORKSPACE_INVALID", "That is a file, not a folder.", 400);
  }
  const real = realpathSync.native(requested);
  if (isRoot(real)) {
    throw new SetupRequestError(
      "WORKSPACE_TOO_BROAD",
      "Choose a project folder rather than a whole drive.",
      400,
    );
  }
  return real;
}

function driveRoots(platform: NodeJS.Platform): readonly string[] {
  if (platform !== "win32") return ["/"];
  const roots: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

async function listFolders(
  requested: string,
  services: RuntimeSetupHttpServices,
): Promise<Record<string, unknown>> {
  const path = resolve(requested);
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    throw new SetupRequestError("FOLDER_UNREADABLE", "That folder cannot be opened.", 404);
  }
  const folders = entries
    .filter((entry) => entry.isDirectory() && !/^[.$]/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  return {
    path,
    parent: isRoot(path) ? null : dirname(path),
    home: services.home ?? homedir(),
    roots: driveRoots(services.platform ?? process.platform),
    folders: folders.slice(0, MAX_FOLDERS).map((name) => ({ name, path: join(path, name) })),
    truncated: folders.length > MAX_FOLDERS,
  };
}

/**
 * First-run setup: where the harness works, and whether a model is connected.
 *
 * The workspace is chosen before anything else because everything else refers to
 * it: new projects start there, and workspace tools read and change files only
 * inside it. The folder browser lists folders only — never files — on this
 * machine, for this machine's own interface.
 */
export async function handleSetupHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  security: RuntimeApiSecurity,
  services: RuntimeSetupHttpServices,
): Promise<void> {
  const now = services.now ?? (() => Date.now());
  try {
    if (url.pathname === SETUP_PATH) {
      if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
      const workspace = readWorkspace(services.database);
      const models = listModelConfigs(services.database.connection()).length;
      writeRuntimeJson(response, 200, {
        setup: {
          workspace: workspace ?? null,
          modelsConfigured: models,
          // A harness can run before a model is connected; it cannot sensibly run
          // before it knows where to work.
          complete: workspace !== undefined && workspace.exists,
        },
      });
      return;
    }

    if (url.pathname === FOLDERS_PATH) {
      if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
      const requested = url.searchParams.get("path");
      const start =
        requested === null || requested.length === 0
          ? (readWorkspace(services.database)?.path ?? services.home ?? homedir())
          : requested;
      if (!isAbsolute(start)) {
        throw new SetupRequestError("FOLDER_UNREADABLE", "Give a full path.", 400);
      }
      writeRuntimeJson(response, 200, { folders: await listFolders(start, services) });
      return;
    }

    if (request.method === "GET") {
      writeRuntimeJson(response, 200, { workspace: readWorkspace(services.database) ?? null });
      return;
    }
    if (request.method !== "POST") return methodNotAllowed(response, ["GET", "POST"]);
    security.checkMutation(request);
    const body = await readBody(request);
    const path = await checkWorkspace(body["path"]);
    await services.database.commit((connection) =>
      writeSetting(connection, "workspace.root", path, now()),
    );
    writeRuntimeJson(response, 200, { workspace: { path, exists: true } });
  } catch (error: unknown) {
    if (error instanceof SetupRequestError) {
      writeRuntimeJson(response, error.statusCode, {
        error: { code: error.code, reason: error.message },
      });
      return;
    }
    throw error;
  }
}
