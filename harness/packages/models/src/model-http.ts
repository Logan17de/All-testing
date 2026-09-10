import type { AdapterInvocationContext } from "@zet-harness/plugin-api";

import { assertModelJson } from "./model-json.js";

export type ModelTransportErrorCode =
  | "MODEL_CONFIGURATION_INVALID"
  | "MODEL_REQUEST_UNSUPPORTED"
  | "MODEL_CREDENTIAL_UNAVAILABLE"
  | "MODEL_HTTP_ERROR"
  | "MODEL_NETWORK_ERROR"
  | "MODEL_TIMEOUT"
  | "MODEL_RESPONSE_INVALID"
  | "MODEL_RESPONSE_LIMIT"
  | "MODEL_STREAM_TRUNCATED";

const ERROR_CODES: readonly ModelTransportErrorCode[] = [
  "MODEL_CONFIGURATION_INVALID",
  "MODEL_REQUEST_UNSUPPORTED",
  "MODEL_CREDENTIAL_UNAVAILABLE",
  "MODEL_HTTP_ERROR",
  "MODEL_NETWORK_ERROR",
  "MODEL_TIMEOUT",
  "MODEL_RESPONSE_INVALID",
  "MODEL_RESPONSE_LIMIT",
  "MODEL_STREAM_TRUNCATED",
];
const TRANSPORT_ERRORS = new WeakSet<object>();

/** Safe by construction: no provider body, URL, credentials, or nested exception is exposed. */
export class ModelTransportError extends Error {
  readonly code: ModelTransportErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(code: ModelTransportErrorCode, status?: number) {
    const safeCode = ERROR_CODES.includes(code) ? code : "MODEL_RESPONSE_INVALID";
    super(safeCode);
    this.name = "ModelTransportError";
    this.code = safeCode;
    if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
      this.status = status;
    }
    this.retryable =
      safeCode === "MODEL_NETWORK_ERROR" ||
      safeCode === "MODEL_TIMEOUT" ||
      (safeCode === "MODEL_HTTP_ERROR" &&
        (this.status === 429 || (this.status !== undefined && this.status >= 500)));
    TRANSPORT_ERRORS.add(this);
    Object.freeze(this);
  }

  toJSON(): {
    readonly code: ModelTransportErrorCode;
    readonly status?: number;
    readonly retryable: boolean;
  } {
    return {
      code: this.code,
      ...(this.status === undefined ? {} : { status: this.status }),
      retryable: this.retryable,
    };
  }
}

export interface ModelHttpOptions {
  readonly baseUrl: string;
  readonly credentialPort?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

export interface ModelHttpSession {
  readonly signal: AbortSignal;
  send(body: string): Promise<Response>;
  normalize(error: unknown): unknown;
  close(): void;
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelTransportError("MODEL_RESPONSE_INVALID");
  }
  return value as Record<string, unknown>;
}

export function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    assertModelJson(value);
    return value;
  } catch {
    throw new ModelTransportError("MODEL_RESPONSE_INVALID");
  }
}

export function immutable<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export function limit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 2_147_483_647) {
    throw new ModelTransportError("MODEL_CONFIGURATION_INVALID");
  }
  return result;
}

/** Abort even if a host resolver or injected fetch implementation fails to cooperate. */
export async function abortable<T>(value: PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
  let onAbort = (): void => undefined;
  const aborted = new Promise<{ readonly aborted: true }>((resolve) => {
    onAbort = (): void => {
      resolve({ aborted: true });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const result = await Promise.race([
      Promise.resolve(value).then((result) => ({ value: result })),
      aborted,
    ]);
    // AbortSignal permits any caller-owned reason. Let its own API preserve that
    // identity instead of normalizing it or manually rejecting an untyped value.
    signal.throwIfAborted();
    if ("value" in result) return result.value;
    throw new ModelTransportError("MODEL_RESPONSE_INVALID");
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Host-configured endpoint, never selected from request/model data. */
export function createModelHttp(options: ModelHttpOptions, path: string) {
  let endpoint: URL;
  try {
    if (options.baseUrl.includes("\\")) throw new Error();
    endpoint = new URL(options.baseUrl);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && local)) throw new Error();
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${path}`;
  } catch {
    throw new ModelTransportError("MODEL_CONFIGURATION_INVALID");
  }
  const url = endpoint.href;
  const capability = endpoint.protocol === "https:" ? "network:https" : "network:http";
  const credentialPort = options.credentialPort;
  if (credentialPort !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(credentialPort)) {
    throw new ModelTransportError("MODEL_CONFIGURATION_INVALID");
  }
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = limit(options.timeoutMs, 120_000);
  const maxRequestBytes = limit(options.maxRequestBytes, 8 * 1024 * 1024);
  const maxResponseBytes = limit(options.maxResponseBytes, 8 * 1024 * 1024);

  return Object.freeze({
    capability,
    maxRequestBytes,
    maxResponseBytes,
    session(context: AdapterInvocationContext): ModelHttpSession {
      const originalSignal = context.signal;
      originalSignal.throwIfAborted();
      const secrets = context.secrets;
      const controller = new AbortController();
      const signal = AbortSignal.any([originalSignal, controller.signal]);
      const timer = setTimeout(() => {
        controller.abort(new ModelTransportError("MODEL_TIMEOUT"));
      }, timeoutMs);
      return Object.freeze({
        signal,
        async send(body: string): Promise<Response> {
          signal.throwIfAborted();
          if (new TextEncoder().encode(body).byteLength > maxRequestBytes) {
            throw new ModelTransportError("MODEL_REQUEST_UNSUPPORTED");
          }
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (credentialPort !== undefined) {
            try {
              if (secrets === undefined) throw new Error();
              const secret = await abortable(secrets.get(credentialPort), signal);
              const value = secret.revealText();
              if (value.length === 0 || /[\r\n]/.test(value)) throw new Error();
              headers.authorization = `Bearer ${value}`;
            } catch {
              signal.throwIfAborted();
              throw new ModelTransportError("MODEL_CREDENTIAL_UNAVAILABLE");
            }
          }
          signal.throwIfAborted();
          let response: Response;
          try {
            response = await abortable(
              transport(url, {
                method: "POST",
                headers,
                body,
                signal,
                redirect: "error",
                credentials: "omit",
              }),
              signal,
            );
          } catch {
            signal.throwIfAborted();
            throw new ModelTransportError("MODEL_NETWORK_ERROR");
          }
          if (!response.ok) {
            void response.body?.cancel().catch(() => undefined);
            throw new ModelTransportError("MODEL_HTTP_ERROR", response.status);
          }
          return response;
        },
        normalize(error: unknown): unknown {
          if (originalSignal.aborted) return originalSignal.reason;
          if (signal.aborted) return signal.reason;
          return typeof error === "object" && error !== null && TRANSPORT_ERRORS.has(error)
            ? error
            : new ModelTransportError("MODEL_RESPONSE_INVALID");
        },
        close(): void {
          clearTimeout(timer);
          controller.abort();
        },
      });
    },
  });
}

async function* chunks(response: Response, maxBytes: number, signal: AbortSignal) {
  if (response.body === null) throw new ModelTransportError("MODEL_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxBytes) throw new ModelTransportError("MODEL_RESPONSE_LIMIT");
      yield decoder.decode(item.value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    // Do not retain a generator waiting for an uncooperative source's cancel callback.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readModelJson(response: Response, maxBytes: number, signal: AbortSignal) {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    void response.body?.cancel().catch(() => undefined);
    throw new ModelTransportError("MODEL_RESPONSE_INVALID");
  }
  let text = "";
  for await (const chunk of chunks(response, maxBytes, signal)) text += chunk;
  return record(parseJson(text));
}

/** SSE framing is independent of provider semantics, including split CRLF and UTF-8 boundaries. */
export async function* readModelSse(response: Response, maxBytes: number, signal: AbortSignal) {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "text/event-stream") {
    void response.body?.cancel().catch(() => undefined);
    throw new ModelTransportError("MODEL_RESPONSE_INVALID");
  }
  let buffer = "";
  let data: string[] = [];
  let eventBytes = 0;
  const maxEventBytes = Math.min(maxBytes, 1024 * 1024);
  const line = (value: string): string | undefined => {
    if (value === "") {
      const result = data.length === 0 ? undefined : data.join("\n");
      data = [];
      eventBytes = 0;
      return result;
    }
    eventBytes += new TextEncoder().encode(value).byteLength;
    if (eventBytes > maxEventBytes) throw new ModelTransportError("MODEL_RESPONSE_LIMIT");
    if (value.startsWith("data:")) data.push(value.slice(value[5] === " " ? 6 : 5));
    return undefined;
  };
  for await (const chunk of chunks(response, maxBytes, signal)) {
    buffer += chunk;
    let index: number;
    while ((index = buffer.search(/[\r\n]/)) !== -1) {
      if (buffer[index] === "\r" && index === buffer.length - 1) break;
      const width = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      const event = line(buffer.slice(0, index));
      buffer = buffer.slice(index + width);
      if (event !== undefined) yield event;
    }
    if (buffer.length > maxEventBytes) throw new ModelTransportError("MODEL_RESPONSE_LIMIT");
  }
  if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
  if (buffer !== "") line(buffer);
  const last = line("");
  if (last !== undefined) yield last;
}
