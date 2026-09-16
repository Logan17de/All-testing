import type { IncomingMessage, ServerResponse } from "node:http";

import type { SqliteDatabase } from "@zet-harness/db";
import type { GraphJsonV1DiagnosticContext } from "@zet-harness/graph";

import { RuntimeApiSecurityError, type RuntimeApiSecurity } from "./runtime-api-security.js";
import { writeRuntimeJson } from "./runtime-approval-http.js";
import { forkRun } from "./runtime-fork.js";
import {
  RuntimeGraphError,
  compileEditorGraph,
  createStoredGraphResolver,
  createRunFromCompiledGraph,
  listPaletteNodes,
  listRecentRuns,
  readRunView,
  type GraphSources,
} from "./runtime-graphs.js";
import { replayRecordedRun } from "./runtime-replay.js";

/** Services the editor endpoints need; supplied by the daemon. */
export interface RuntimeGraphHttpServices {
  readonly database: SqliteDatabase;
  /** Read at request time: plugins load after the HTTP server is constructed. */
  readonly sources: () => GraphSources;
  readonly capabilityAuthority: () => GraphJsonV1DiagnosticContext["capabilityAuthority"];
  readonly redact: (value: unknown) => unknown;
  /** Wake the dispatcher for a new run; undefined when no executor is configured. */
  readonly dispatch: ((runId: string) => void) | undefined;
}

/**
 * Graphs are larger than approval payloads. The cap still exists: a local API
 * that buffers an unbounded body is a trivial way to exhaust the daemon.
 */
const MAX_GRAPH_BODY_BYTES = 1_048_576;

async function readBodyText(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    size += buffer.length;
    if (size > MAX_GRAPH_BODY_BYTES) {
      request.resume();
      throw new RuntimeApiSecurityError("LOCAL_API_BODY_TOO_LARGE", "Request exceeds 1 MiB.", 413);
    }
    parts.push(buffer);
  }
  return Buffer.concat(parts).toString("utf8");
}

async function readGraphBody(request: IncomingMessage): Promise<unknown> {
  const text = await readBodyText(request);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new RuntimeGraphError("GRAPH_INVALID", "Request body is not valid JSON.", 400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("graph" in value)) {
    throw new RuntimeGraphError("GRAPH_INVALID", 'Request body must be { "graph": ... }.', 400);
  }
  return (value as { readonly graph: unknown }).graph;
}

/** An empty body or `{}` forks from the run's latest event; `{ "throughEventId": 12 }` from event 12. */
async function readForkBody(
  request: IncomingMessage,
): Promise<{ readonly throughEventId?: number }> {
  const text = (await readBodyText(request)).trim();
  if (text.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new RuntimeGraphError("FORK_POINT_INVALID", "Request body is not valid JSON.", 400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeGraphError(
      "FORK_POINT_INVALID",
      'Request body must be an object, such as { "throughEventId": 12 }.',
      400,
    );
  }
  const throughEventId = (value as { readonly throughEventId?: unknown }).throughEventId;
  if (throughEventId === undefined) return {};
  if (
    typeof throughEventId !== "number" ||
    !Number.isSafeInteger(throughEventId) ||
    throughEventId < 1
  ) {
    throw new RuntimeGraphError(
      "FORK_POINT_INVALID",
      "throughEventId must be a positive whole number.",
      422,
    );
  }
  return { throughEventId };
}

function decodeRunId(segment: string | undefined): string {
  try {
    return decodeURIComponent(segment ?? "");
  } catch {
    throw new RuntimeGraphError("RUN_NOT_FOUND", "No run exists with this id.", 404);
  }
}

function writeGraphError(response: ServerResponse, error: RuntimeGraphError): void {
  writeRuntimeJson(response, error.statusCode, {
    error: { code: error.code, reason: error.message },
    diagnostics: error.diagnostics,
  });
}

function methodNotAllowed(response: ServerResponse, allowed: readonly string[]): void {
  response.setHeader("allow", allowed.join(", "));
  writeRuntimeJson(response, 405, { error: "method_not_allowed", allowed });
}

/** Editor paths this handler owns; everything else falls through to the server. */
export function isGraphHttpPath(pathname: string): boolean {
  return (
    pathname === "/api/nodes" ||
    pathname === "/api/graphs/validate" ||
    pathname === "/api/runs" ||
    pathname.startsWith("/api/runs/")
  );
}

/**
 * Editor endpoints.
 *
 * Every POST passes the same CSRF check as approval decisions, including
 * validation, which changes nothing: a body-accepting endpoint that skips the
 * check is exactly the shape a cross-site form post exploits, and consistency is
 * cheaper than remembering which POSTs happen to be harmless.
 */
export async function handleGraphHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  security: RuntimeApiSecurity,
  services: RuntimeGraphHttpServices,
): Promise<void> {
  try {
    if (url.pathname === "/api/nodes") {
      if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
      writeRuntimeJson(response, 200, { nodes: listPaletteNodes(services.sources()) });
      return;
    }

    if (url.pathname === "/api/graphs/validate") {
      if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
      security.checkMutation(request);
      const graph = await readGraphBody(request);
      const result = await compileEditorGraph(
        graph,
        { ...services.sources(), graphs: createStoredGraphResolver(services.database) },
        services.capabilityAuthority(),
      );
      writeRuntimeJson(response, 200, {
        valid: result.valid,
        diagnostics: result.valid ? [] : result.diagnostics,
        ...(result.valid ? { semanticHash: result.compiled.identity.semanticHash } : {}),
      });
      return;
    }

    if (url.pathname === "/api/runs") {
      if (request.method === "GET") {
        writeRuntimeJson(response, 200, { runs: listRecentRuns(services.database) });
        return;
      }
      if (request.method !== "POST") return methodNotAllowed(response, ["GET", "POST"]);
      security.checkMutation(request);
      const graph = await readGraphBody(request);
      const result = await compileEditorGraph(
        graph,
        { ...services.sources(), graphs: createStoredGraphResolver(services.database) },
        services.capabilityAuthority(),
      );
      if (!result.valid) {
        throw new RuntimeGraphError(
          "GRAPH_INVALID",
          "The graph has errors and was not run.",
          422,
          result.diagnostics,
        );
      }
      const created = await createRunFromCompiledGraph(services.database, result.compiled);
      services.dispatch?.(created.runId);
      writeRuntimeJson(response, 201, {
        ...created,
        // A run with no executor stays pending; say so rather than implying it started.
        dispatched: services.dispatch !== undefined,
      });
      return;
    }

    // 9.1: a read-only replay of the run's recorded journal; it runs nothing.
    const replayMatch = /^\/api\/runs\/([^/]+)\/replay$/u.exec(url.pathname);
    if (replayMatch !== null) {
      if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
      writeRuntimeJson(response, 200, {
        replay: replayRecordedRun(
          services.database.connection(),
          decodeRunId(replayMatch[1]),
          services.redact,
        ),
      });
      return;
    }

    // 9.2: a new run from a point in this run's history; the parent run is never written.
    const forkMatch = /^\/api\/runs\/([^/]+)\/fork$/u.exec(url.pathname);
    if (forkMatch !== null) {
      if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
      security.checkMutation(request);
      const parentRunId = decodeRunId(forkMatch[1]);
      const fork = await forkRun(services.database, parentRunId, await readForkBody(request));
      services.dispatch?.(fork.runId);
      writeRuntimeJson(response, 201, {
        fork,
        // Without an executor the fork stays pending, like any new run.
        dispatched: services.dispatch !== undefined,
      });
      return;
    }

    const match = /^\/api\/runs\/([^/]+)$/u.exec(url.pathname);
    if (match === null) {
      writeRuntimeJson(response, 404, { error: "not_found" });
      return;
    }
    if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
    writeRuntimeJson(response, 200, {
      run: readRunView(services.database, decodeRunId(match[1]), services.redact),
    });
  } catch (error: unknown) {
    if (error instanceof RuntimeGraphError) {
      writeGraphError(response, error);
      return;
    }
    throw error;
  }
}
