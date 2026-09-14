/**
 * Guard for the browser-facing proxy routes under `/api/editor`.
 *
 * Those routes fetch the runtime daemon's CSRF token on the server and attach it
 * to the forwarded request. That is what keeps the token out of the browser, but
 * it also means the proxy would turn any request it accepts into an authorized
 * one. So the proxy has to decide first whether the request came from this app:
 *
 * - the Host must be loopback, which stops a LAN peer and DNS rebinding;
 * - a browser that says the request is cross-site is refused;
 * - an Origin, when present, must be this app's own;
 * - a mutation must declare a JSON body, which a plain cross-site form cannot do
 *   without a CORS preflight this app never grants.
 */

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BODY_CHARACTERS = 1_048_576;

/** The parts of a request the guard reads; `Request` satisfies it. */
export interface GuardedRequest {
  readonly url: string;
  readonly headers: { get(name: string): string | null };
}

function reject(status: number, code: string, reason: string): Response {
  return Response.json(
    { error: { code, reason } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function hostOf(value: string): string | null {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).host;
  } catch {
    return null;
  }
}

function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

export function guardLocalRequest(
  request: GuardedRequest,
  kind: "read" | "mutation",
): Response | undefined {
  const host = request.headers.get("host") ?? hostOf(request.url);
  const hostname = host === null ? null : hostnameOf(host);
  if (host === null || hostname === null || !LOOPBACK_HOSTNAMES.has(hostname)) {
    return reject(403, "LOCAL_UI_HOST_REJECTED", "The editor API only answers loopback requests.");
  }

  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return reject(403, "LOCAL_UI_CROSS_SITE", "Cross-site requests to the editor API are blocked.");
  }

  const origin = request.headers.get("origin");
  if (origin !== null && hostOf(origin) !== host) {
    return reject(403, "LOCAL_UI_ORIGIN_REJECTED", "The request did not come from this app.");
  }

  if (kind === "mutation") {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return reject(415, "LOCAL_UI_JSON_REQUIRED", "Send the request body as application/json.");
    }
  }

  return undefined;
}

/** Read a bounded JSON object body, or return the error response to send. */
export async function readJsonObject(
  request: Request,
): Promise<Readonly<Record<string, unknown>> | Response> {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARACTERS) {
    return reject(413, "LOCAL_UI_BODY_TOO_LARGE", "The request body exceeds 1 MiB.");
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Readonly<Record<string, unknown>>;
    }
  } catch {
    // Fall through to the shared rejection.
  }
  return reject(400, "LOCAL_UI_INVALID_JSON", "The request body must be a JSON object.");
}

/** Forward a runtime response to the browser without caching it. */
export function relay(result: { readonly status: number; readonly body: unknown }): Response {
  return Response.json(result.body, {
    status: result.status,
    headers: { "cache-control": "no-store" },
  });
}
