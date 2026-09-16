import type { IncomingMessage, ServerResponse } from "node:http";

import type { SqliteDatabase } from "@zet-harness/db";
import {
  DurableModelError,
  MODEL_CREDENTIALS,
  MODEL_PROFILES,
  deleteModelConfig,
  listModelConfigs,
  readModelConfig,
  replaceModelConfig,
  saveModelConfig,
  type DurableModelCredential,
  type DurableModelErrorCode,
  type DurableModelProfile,
} from "@zet-harness/db/durable-model-records";

import { RuntimeApiSecurityError, type RuntimeApiSecurity } from "./runtime-api-security.js";
import { writeRuntimeJson } from "./runtime-approval-http.js";

/** What a check found when it asked a configured model to answer. */
export interface ModelCheckResult {
  readonly ok: boolean;
  /** A stable code when it failed: the transport's own, or MODEL_NOT_REGISTERED. */
  readonly code?: string;
  readonly reason?: string;
  /** The endpoint's HTTP status, when it answered with an error. */
  readonly status?: number;
  readonly latencyMs?: number;
}

export interface RuntimeModelHttpServices {
  readonly database: SqliteDatabase;
  /** UTC epoch milliseconds. Defaults to the system clock. */
  readonly now?: () => number;
  /** Register or re-register a model, so a change takes effect without a restart. */
  readonly refresh?: (modelId: string) => void;
  /** Stop offering a model. */
  readonly remove?: (modelId: string) => void;
  /** Ask a model to answer, which proves the endpoint, the key and the model name. */
  readonly check?: (modelId: string) => Promise<ModelCheckResult>;
}

const MAX_MODEL_BODY_BYTES = 16_384;
const MODELS_PATH = /^\/api\/models$/u;
const MODEL_PATH = /^\/api\/models\/([^/]+)$/u;
const MODEL_CHECK_PATH = /^\/api\/models\/([^/]+)\/check$/u;
const MODEL_FIELDS: readonly string[] = [
  "modelId",
  "title",
  "profile",
  "baseUrl",
  "model",
  "credential",
  "credentialEnv",
  "apiKey",
  "tools",
  "streaming",
  "contextWindowTokens",
];

const STATUS_FOR: Readonly<Record<DurableModelErrorCode, number>> = {
  MODEL_CONFIG_INVALID: 400,
  MODEL_CONFIG_NOT_FOUND: 404,
  MODEL_CONFIG_EXISTS: 409,
};

class RuntimeModelRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly field: string | undefined;

  constructor(code: string, message: string, statusCode: number, field?: string) {
    super(message);
    this.name = "RuntimeModelRequestError";
    this.code = code;
    this.statusCode = statusCode;
    this.field = field;
  }
}

function invalidRequest(message: string, field?: string): RuntimeModelRequestError {
  return new RuntimeModelRequestError("MODEL_CONFIG_INVALID", message, 400, field);
}

function modelNotFound(): RuntimeModelRequestError {
  return new RuntimeModelRequestError(
    "MODEL_CONFIG_NOT_FOUND",
    "No model with this id is configured.",
    404,
  );
}

/** Model paths this handler owns; everything else falls through to the server. */
export function isModelHttpPath(pathname: string): boolean {
  return MODELS_PATH.test(pathname) || MODEL_PATH.test(pathname) || MODEL_CHECK_PATH.test(pathname);
}

function methodNotAllowed(response: ServerResponse, allowed: readonly string[]): void {
  response.setHeader("allow", allowed.join(", "));
  writeRuntimeJson(response, 405, { error: "method_not_allowed", allowed });
}

function idFrom(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw modelNotFound();
  }
}

/** A JSON object, or an empty object when the request has no body. */
async function readModelBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    size += buffer.length;
    if (size > MAX_MODEL_BODY_BYTES) {
      request.resume();
      throw new RuntimeApiSecurityError("LOCAL_API_BODY_TOO_LARGE", "Request exceeds 16 KiB.", 413);
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
    if (!MODEL_FIELDS.includes(field)) {
      throw invalidRequest(`A model has no '${field}' field.`, field);
    }
  }
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw invalidRequest(`${field} must be text.`, field);
  return value;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalidRequest(`${field} must be true or false.`, field);
  return value;
}

function profileOf(body: Record<string, unknown>): DurableModelProfile {
  const value = body["profile"];
  if (typeof value !== "string" || !MODEL_PROFILES.includes(value as DurableModelProfile)) {
    throw invalidRequest(`profile must be one of: ${MODEL_PROFILES.join(", ")}.`, "profile");
  }
  return value as DurableModelProfile;
}

function credentialOf(body: Record<string, unknown>): DurableModelCredential | undefined {
  const value = body["credential"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !MODEL_CREDENTIALS.includes(value as DurableModelCredential)) {
    throw invalidRequest(
      `credential must be one of: ${MODEL_CREDENTIALS.join(", ")}.`,
      "credential",
    );
  }
  return value as DurableModelCredential;
}

function contextWindowOf(body: Record<string, unknown>): number {
  const value = body["contextWindowTokens"];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidRequest(
      "contextWindowTokens must be a positive whole number.",
      "contextWindowTokens",
    );
  }
  return value;
}

function saveInput(
  body: Record<string, unknown>,
  modelId: string,
  nowMs: number,
): Parameters<typeof saveModelConfig>[1] {
  const credential = credentialOf(body);
  const credentialEnv = body["credentialEnv"];
  if (credentialEnv !== undefined && credentialEnv !== null && typeof credentialEnv !== "string") {
    throw invalidRequest("credentialEnv must be text.", "credentialEnv");
  }
  const apiKey = body["apiKey"];
  if (apiKey !== undefined && apiKey !== null && typeof apiKey !== "string") {
    throw invalidRequest("apiKey must be text.", "apiKey");
  }
  const tools = optionalBoolean(body, "tools");
  const streaming = optionalBoolean(body, "streaming");
  return {
    modelId,
    title: requiredString(body, "title"),
    profile: profileOf(body),
    baseUrl: requiredString(body, "baseUrl"),
    model: requiredString(body, "model"),
    ...(credential === undefined ? {} : { credential }),
    ...(credentialEnv === undefined ? {} : { credentialEnv }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(tools === undefined ? {} : { tools }),
    ...(streaming === undefined ? {} : { streaming }),
    contextWindowTokens: contextWindowOf(body),
    nowMs,
  };
}

/**
 * The models this harness can call.
 *
 * A model is an OpenAI-compatible endpoint, the model name that endpoint knows,
 * and — when the endpoint asks for one — a key, either stored here or read from a
 * named environment variable. A key is never returned by any of these endpoints:
 * a reader is told which kind of credential a model uses, never the value.
 *
 * Configuring a model registers it at once, so a graph can use it without
 * restarting the runtime, and `check` asks the endpoint to answer so a person
 * finds out that a key or a model name is wrong here rather than mid-run.
 */
export async function handleModelHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  security: RuntimeApiSecurity,
  services: RuntimeModelHttpServices,
): Promise<void> {
  const now = services.now ?? (() => Date.now());
  const database = services.database;
  try {
    if (MODELS_PATH.test(url.pathname)) {
      if (request.method === "GET") {
        writeRuntimeJson(response, 200, {
          models: listModelConfigs(database.connection()),
          profiles: MODEL_PROFILES,
        });
        return;
      }
      if (request.method !== "POST") return methodNotAllowed(response, ["GET", "POST"]);
      security.checkMutation(request);
      const body = await readModelBody(request);
      onlyFields(body);
      const modelId = requiredString(body, "modelId");
      const model = await database.commit((connection) =>
        saveModelConfig(connection, saveInput(body, modelId, now())),
      );
      services.refresh?.(model.modelId);
      writeRuntimeJson(response, 201, { model });
      return;
    }

    const checkMatch = MODEL_CHECK_PATH.exec(url.pathname);
    if (checkMatch !== null) {
      if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
      security.checkMutation(request);
      const modelId = idFrom(checkMatch[1] ?? "");
      if (readModelConfig(database.connection(), modelId) === undefined) throw modelNotFound();
      if (services.check === undefined) {
        writeRuntimeJson(response, 503, {
          error: {
            code: "MODEL_CHECK_UNAVAILABLE",
            reason: "This runtime cannot call models.",
          },
        });
        return;
      }
      writeRuntimeJson(response, 200, { check: await services.check(modelId) });
      return;
    }

    const match = MODEL_PATH.exec(url.pathname);
    if (match === null) {
      writeRuntimeJson(response, 404, { error: "not_found" });
      return;
    }
    const modelId = idFrom(match[1] ?? "");

    if (request.method === "GET") {
      const model = readModelConfig(database.connection(), modelId);
      if (model === undefined) throw modelNotFound();
      writeRuntimeJson(response, 200, { model });
      return;
    }
    if (request.method === "DELETE") {
      security.checkMutation(request);
      const forgotten = await database.commit((connection) =>
        deleteModelConfig(connection, modelId),
      );
      if (!forgotten) throw modelNotFound();
      services.remove?.(modelId);
      writeRuntimeJson(response, 200, { forgotten: true });
      return;
    }
    if (request.method !== "PATCH") {
      return methodNotAllowed(response, ["GET", "PATCH", "DELETE"]);
    }
    security.checkMutation(request);
    const body = await readModelBody(request);
    onlyFields(body);
    if (typeof body["modelId"] === "string" && body["modelId"] !== modelId) {
      throw invalidRequest("A model keeps its id.", "modelId");
    }
    const model = await database.commit((connection) =>
      replaceModelConfig(connection, saveInput(body, modelId, now())),
    );
    services.refresh?.(model.modelId);
    writeRuntimeJson(response, 200, { model });
  } catch (error: unknown) {
    if (error instanceof RuntimeModelRequestError || error instanceof DurableModelError) {
      const statusCode =
        error instanceof RuntimeModelRequestError ? error.statusCode : STATUS_FOR[error.code];
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
