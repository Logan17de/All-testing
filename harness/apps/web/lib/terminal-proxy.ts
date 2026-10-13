import { randomBytes } from "node:crypto";
import { guardLocalRequest, readJsonObject } from "./local-request-guard";
import { getFromRuntime, runtimeOrigin } from "./runtime-client";

const cookieName = "zet-terminal-owner-v1";
const validOwner = /^[A-Za-z0-9_-]{43}$/;

/** Session identity only, not permission to launch a process. Never exposed to model context. */
export async function proxyTerminal(request: Request): Promise<Response> {
  const rejected = guardLocalRequest(request, request.method === "GET" ? "read" : "mutation");
  if (rejected) return rejected;
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  const existing = cookie !== undefined && validOwner.test(cookie);
  const owner = existing ? cookie : randomBytes(32).toString("base64url");
  const url = new URL(request.url);
  let body: Readonly<Record<string, unknown>> | undefined;
  if (request.method === "POST") {
    const value = await readJsonObject(request);
    if (value instanceof Response) return value;
    body = value;
  }
  const session = await getFromRuntime("/api/session");
  const token =
    session.body && typeof session.body === "object" && "csrfToken" in session.body
      ? session.body.csrfToken
      : undefined;
  if (session.status !== 200 || typeof token !== "string")
    return Response.json(
      { error: { code: "TERMINAL_UNAVAILABLE", reason: "The runtime is unavailable." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  try {
    const reply = await fetch(
      `${runtimeOrigin()}/api/terminal${request.method === "GET" ? url.search : ""}`,
      {
        method: request.method,
        headers: {
          "content-type": "application/json",
          "x-zet-csrf": token,
          "x-zet-terminal-owner": owner,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
        signal: AbortSignal.timeout(body?.action === "create" ? 70_000 : 15_000),
      },
    );
    const response = Response.json(await reply.json(), {
      status: reply.status,
      headers: { "cache-control": "no-store" },
    });
    if (!existing)
      response.headers.append(
        "set-cookie",
        `${cookieName}=${owner}; Path=/api/editor/terminal; HttpOnly; SameSite=Strict${url.protocol === "https:" ? "; Secure" : ""}`,
      );
    return response;
  } catch {
    return Response.json(
      { error: { code: "TERMINAL_UNAVAILABLE", reason: "The runtime is unavailable." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
