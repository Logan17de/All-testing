import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { SqliteDatabase } from "@zet-harness/db";
import {
  deleteProviderConnection,
  listModelConfigs,
  readProviderConnection,
  saveProviderConnection,
} from "@zet-harness/db/durable-model-records";

import { RuntimeApiSecurityError, type RuntimeApiSecurity } from "./runtime-api-security.js";
import { writeRuntimeJson } from "./runtime-approval-http.js";

/** OpenRouter's own site, where people sign in and apps exchange codes for keys. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai";

const SIGN_IN_LIFETIME_MS = 10 * 60_000;
const MODEL_LIST_LIFETIME_MS = 10 * 60_000;
const MAX_BODY_BYTES = 8_192;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const CONNECTIONS_PATH = "/api/connections";
const OPENROUTER_PATH = /^\/api\/connections\/openrouter\/(start|complete|sign-out|models)$/u;

export interface RuntimeConnectionHttpServices {
  readonly database: SqliteDatabase;
  /** Keys seen here never appear in events, payloads or logs again. */
  readonly registerSecret?: (secret: string) => void;
  /** Defaults to OpenRouter itself; a test points it at a stand-in. */
  readonly openRouterUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** UTC epoch milliseconds. Defaults to the system clock. */
  readonly now?: () => number;
}

interface PendingSignIn {
  readonly verifier: string;
  readonly expiresAtMs: number;
}

export interface OpenRouterModel {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number;
}

class ConnectionRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "ConnectionRequestError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function isConnectionHttpPath(pathname: string): boolean {
  return pathname === CONNECTIONS_PATH || OPENROUTER_PATH.test(pathname);
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
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
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Fall through to the shared refusal.
  }
  throw new ConnectionRequestError(
    "CONNECTION_REQUEST_INVALID",
    "The request must be a JSON object.",
    400,
  );
}

/** Where OpenRouter sends the person back: this app, on this machine, and nowhere else. */
function checkCallback(value: unknown): string {
  if (typeof value !== "string") {
    throw new ConnectionRequestError("CONNECTION_REQUEST_INVALID", "callbackUrl is required.", 400);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectionRequestError(
      "CONNECTION_REQUEST_INVALID",
      "callbackUrl must be a URL.",
      400,
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !LOOPBACK.has(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new ConnectionRequestError(
      "CONNECTION_REQUEST_INVALID",
      "The sign-in can only return to this app on this machine.",
      400,
    );
  }
  return url.href;
}

function methodNotAllowed(response: ServerResponse, allowed: readonly string[]): void {
  response.setHeader("allow", allowed.join(", "));
  writeRuntimeJson(response, 405, { error: "method_not_allowed", allowed });
}

/**
 * Signing in to a provider instead of pasting a key.
 *
 * OpenRouter offers a sign-in made for apps like this one: the person approves
 * the app on OpenRouter's own site, OpenRouter sends them back here with a
 * one-time code, and the code — together with a secret only this runtime holds
 * (PKCE) — is exchanged for a key. The key is stored once, as the connection
 * every OpenRouter model reads, and is never returned by any endpoint.
 *
 * One sign-in may be in progress at a time, and it expires after ten minutes:
 * this is a single-person app, and a stale code should fail rather than linger.
 */
export function createConnectionHttpHandler(services: RuntimeConnectionHttpServices) {
  const now = services.now ?? (() => Date.now());
  const base = (services.openRouterUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/u, "");
  const transport = services.fetch ?? globalThis.fetch.bind(globalThis);
  let pending: PendingSignIn | undefined;
  let modelList: { readonly models: readonly OpenRouterModel[]; readonly atMs: number } | undefined;

  const status = () => {
    const connection = readProviderConnection(services.database.connection(), "openrouter");
    const models = listModelConfigs(services.database.connection()).filter(
      (model) => model.credential === "connection" && model.connection === "openrouter",
    ).length;
    return {
      provider: "openrouter",
      title: "OpenRouter",
      method: "oauth",
      connected: connection !== undefined,
      connectedAtMs: connection?.connectedAtMs ?? null,
      models,
      // The only address a model using this sign-in may call.
      apiBaseUrl: `${base}/api/v1`,
    };
  };

  const exchange = async (code: string, verifier: string): Promise<string> => {
    let response: Response;
    try {
      response = await transport(`${base}/api/v1/auth/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ConnectionRequestError(
        "CONNECTION_UNREACHABLE",
        "OpenRouter could not be reached to finish signing in.",
        502,
      );
    }
    const body = (await response.json().catch(() => null)) as { readonly key?: unknown } | null;
    if (!response.ok || typeof body?.key !== "string" || body.key.length === 0) {
      throw new ConnectionRequestError(
        "CONNECTION_REFUSED",
        `OpenRouter did not accept the sign-in (${String(response.status)}). Try signing in again.`,
        502,
      );
    }
    return body.key;
  };

  const listModels = async (): Promise<readonly OpenRouterModel[]> => {
    if (modelList !== undefined && now() - modelList.atMs < MODEL_LIST_LIFETIME_MS) {
      return modelList.models;
    }
    let response: Response;
    try {
      response = await transport(`${base}/api/v1/models`, {
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ConnectionRequestError(
        "CONNECTION_UNREACHABLE",
        "OpenRouter's model list could not be reached.",
        502,
      );
    }
    const body = (await response.json().catch(() => null)) as { readonly data?: unknown } | null;
    if (!response.ok || !Array.isArray(body?.data)) {
      throw new ConnectionRequestError(
        "CONNECTION_REFUSED",
        "OpenRouter did not return its model list.",
        502,
      );
    }
    const models = body.data
      .flatMap((entry: unknown): OpenRouterModel[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const record = entry as Record<string, unknown>;
        const parameters = record["supported_parameters"];
        const tools = Array.isArray(parameters) && parameters.includes("tools");
        const id = record["id"];
        if (!tools || typeof id !== "string") return [];
        const context = record["context_length"];
        return [
          {
            id,
            name: typeof record["name"] === "string" ? record["name"] : id,
            contextLength:
              typeof context === "number" && Number.isSafeInteger(context) && context > 0
                ? context
                : 32_000,
          },
        ];
      })
      .sort((left: OpenRouterModel, right: OpenRouterModel) => left.id.localeCompare(right.id));
    modelList = { models, atMs: now() };
    return models;
  };

  return async function handleConnectionHttp(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    security: RuntimeApiSecurity,
  ): Promise<void> {
    try {
      if (url.pathname === CONNECTIONS_PATH) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        writeRuntimeJson(response, 200, { connections: [status()] });
        return;
      }

      const action = OPENROUTER_PATH.exec(url.pathname)?.[1];
      if (action === "models") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        writeRuntimeJson(response, 200, { models: await listModels() });
        return;
      }
      if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
      security.checkMutation(request);
      const body = await readBody(request);

      if (action === "start") {
        const callbackUrl = checkCallback(body["callbackUrl"]);
        const verifier = base64Url(randomBytes(48));
        const challenge = base64Url(createHash("sha256").update(verifier).digest());
        pending = { verifier, expiresAtMs: now() + SIGN_IN_LIFETIME_MS };
        const query = new URLSearchParams({
          callback_url: callbackUrl,
          code_challenge: challenge,
          code_challenge_method: "S256",
          // Names the key on the person's OpenRouter account, so they can find and revoke it.
          key_label: "Zet Harness",
        });
        writeRuntimeJson(response, 200, { authorizeUrl: `${base}/auth?${query.toString()}` });
        return;
      }

      if (action === "complete") {
        const code = body["code"];
        if (typeof code !== "string" || code.length === 0 || code.length > 1_000) {
          throw new ConnectionRequestError(
            "CONNECTION_REQUEST_INVALID",
            "The sign-in came back without a code.",
            400,
          );
        }
        const started = pending;
        // A code is tried once; a second attempt must start over.
        pending = undefined;
        if (started === undefined || now() > started.expiresAtMs) {
          throw new ConnectionRequestError(
            "CONNECTION_NOT_STARTED",
            "This sign-in has expired or was not started here. Start it again.",
            409,
          );
        }
        const key = await exchange(code, started.verifier);
        services.registerSecret?.(key);
        await services.database.commit((connection) =>
          saveProviderConnection(connection, "openrouter", key, now()),
        );
        writeRuntimeJson(response, 200, { connection: status() });
        return;
      }

      // sign-out
      await services.database.commit((connection) =>
        deleteProviderConnection(connection, "openrouter"),
      );
      writeRuntimeJson(response, 200, { connection: status() });
    } catch (error: unknown) {
      if (error instanceof ConnectionRequestError) {
        writeRuntimeJson(response, error.statusCode, {
          error: { code: error.code, reason: error.message },
        });
        return;
      }
      throw error;
    }
  };
}
