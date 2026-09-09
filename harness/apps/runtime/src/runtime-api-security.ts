import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const RUNTIME_CSRF_HEADER = "x-zet-csrf" as const;

export class RuntimeApiSecurityError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly remediation = "use-trusted-local-origin-and-current-session";

  constructor(code: string, message: string, statusCode = 403) {
    super(message);
    this.name = "RuntimeApiSecurityError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Host/origin checks are not authentication for other processes on the same machine. */
export class RuntimeApiSecurity {
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #csrfToken = randomBytes(32).toString("base64url");

  constructor(allowedOrigins: readonly string[] = []) {
    this.#allowedOrigins = new Set(
      allowedOrigins.map((origin) => {
        const url = new URL(origin);
        if (
          url.origin !== origin ||
          !LOCAL_HOSTS.has(url.hostname) ||
          (url.protocol !== "http:" && url.protocol !== "https:")
        ) {
          throw new TypeError("Allowed UI origins must be exact loopback HTTP(S) origins.");
        }
        return origin;
      }),
    );
  }

  /** Only return through the origin-guarded no-store session endpoint. Never log this value. */
  sessionToken(): string {
    return this.#csrfToken;
  }

  check(request: IncomingMessage, port: number): string | undefined {
    const host = request.headers.host;
    const allowedHosts = [...LOCAL_HOSTS].map((name) => `${name}:${String(port)}`);
    if (typeof host !== "string" || !allowedHosts.includes(host)) {
      throw new RuntimeApiSecurityError("LOCAL_API_HOST_REJECTED", "Untrusted local API host.");
    }
    if (
      request.url === undefined ||
      !request.url.startsWith("/") ||
      request.url.startsWith("//")
    ) {
      throw new RuntimeApiSecurityError("LOCAL_API_TARGET_REJECTED", "Invalid request target.", 400);
    }
    const origin = request.headers.origin;
    const ownOrigins = allowedHosts.map((name) => `http://${name}`);
    if (
      origin !== undefined &&
      (Array.isArray(origin) ||
        (!ownOrigins.includes(origin) && !this.#allowedOrigins.has(origin)))
    ) {
      throw new RuntimeApiSecurityError("LOCAL_API_ORIGIN_REJECTED", "Untrusted local API origin.");
    }
    const fetchSite = request.headers["sec-fetch-site"];
    if (
      fetchSite === "cross-site" &&
      (origin === undefined || !this.#allowedOrigins.has(origin))
    ) {
      throw new RuntimeApiSecurityError(
        "LOCAL_API_CROSS_SITE",
        "Cross-site local API requests are blocked.",
      );
    }
    return origin;
  }

  checkMutation(request: IncomingMessage): void {
    const token = request.headers[RUNTIME_CSRF_HEADER];
    if (
      typeof token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(this.#csrfToken))
    ) {
      throw new RuntimeApiSecurityError(
        "LOCAL_API_CSRF_REJECTED",
        "A current session token is required.",
      );
    }
    const contentType = request.headers["content-type"];
    if (
      typeof contentType !== "string" ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
    ) {
      throw new RuntimeApiSecurityError(
        "LOCAL_API_JSON_REQUIRED",
        "JSON content type is required.",
        415,
      );
    }
  }
}

export function assertLoopbackHost(host: string): void {
  if (!LOCAL_HOSTS.has(host === "::1" ? "[::1]" : host)) {
    throw new TypeError("The local runtime API must bind to a loopback host.");
  }
}
