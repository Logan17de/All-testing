/**
 * Read-only client for the runtime daemon.
 *
 * `RUNTIME.md` settles the ownership question: the daemon owns SQLite,
 * plugins, runs and events, and this Next.js app is a client. Fetching happens
 * on the server so the daemon stays bound to loopback and the browser never
 * needs a cross-origin grant into it.
 */

const DEFAULT_RUNTIME_ORIGIN = "http://127.0.0.1:3211";

export function runtimeOrigin(): string {
  const configured = process.env["HARNESS_RUNTIME_URL"];
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_RUNTIME_ORIGIN;
}

export interface RuntimeHealth {
  readonly status: string;
  readonly service: string;
}

export interface PluginView {
  readonly packageName: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly enabled: boolean;
  readonly requestedCapabilities: readonly string[];
  readonly grantedCapabilities: readonly string[];
  readonly withheldCapabilities: readonly string[];
  readonly declaredNodes: readonly string[];
  readonly unsigned: boolean;
}

export interface PluginReport {
  readonly directory: string;
  /** Whether this harness installs plugins at all, and from where; absent on older daemons. */
  readonly install?: { readonly npm: boolean; readonly git: boolean };
  readonly installed: readonly PluginView[];
  readonly activated: readonly string[];
  readonly failures: readonly {
    readonly code: string;
    readonly packageName: string;
    readonly message: string;
  }[];
  readonly configDefects: readonly string[];
  readonly isolated: readonly string[];
}

export type RuntimeFetch<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly reason: string };

/**
 * Fetch one runtime endpoint.
 *
 * A daemon that is not running is an ordinary state for a local-first app, not
 * an error page: the UI has to render something useful before anything is
 * started.
 */
async function readRuntime<T>(path: string): Promise<RuntimeFetch<T>> {
  try {
    const response = await fetch(`${runtimeOrigin()}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return { ok: false, reason: `The runtime answered ${String(response.status)}.` };
    }
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, reason: "The runtime daemon is not reachable." };
  }
}

export function fetchRuntimeHealth(): Promise<RuntimeFetch<RuntimeHealth>> {
  return readRuntime<RuntimeHealth>("/api/health");
}

export function fetchPluginReport(): Promise<RuntimeFetch<PluginReport>> {
  return readRuntime<PluginReport>("/api/plugins");
}

export interface RuntimeResponse {
  readonly status: number;
  readonly body: unknown;
}

const RUNTIME_UNREACHABLE: RuntimeResponse = {
  status: 503,
  body: { error: { code: "RUNTIME_UNREACHABLE", reason: "The runtime daemon is not reachable." } },
};

async function sendToRuntime(path: string, init: RequestInit): Promise<RuntimeResponse> {
  try {
    const response = await fetch(`${runtimeOrigin()}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    try {
      return {
        status: response.status,
        body: text.length === 0 ? null : (JSON.parse(text) as unknown),
      };
    } catch {
      return {
        status: 502,
        body: {
          error: {
            code: "RUNTIME_BAD_RESPONSE",
            reason: "The runtime returned a non-JSON response.",
          },
        },
      };
    }
  } catch {
    return RUNTIME_UNREACHABLE;
  }
}

export function getFromRuntime(path: string): Promise<RuntimeResponse> {
  return sendToRuntime(path, { method: "GET" });
}

/** The methods a proxy route may use to change something in the runtime. */
export type RuntimeMutationMethod = "POST" | "PATCH" | "DELETE";

/**
 * Change something in the daemon on the user's behalf.
 *
 * The CSRF token is fetched here, on the server, and never sent to the browser:
 * a page cannot leak a token it never held. Callers must have passed
 * `guardLocalRequest` first, or this would authorize a cross-site request.
 *
 * A delete carries no body, but still declares the JSON content type, because
 * that declaration is what a plain cross-site form cannot make.
 */
export async function mutateRuntime(
  path: string,
  method: RuntimeMutationMethod,
  body?: unknown,
): Promise<RuntimeResponse> {
  const session = await getFromRuntime("/api/session");
  const token =
    typeof session.body === "object" && session.body !== null && "csrfToken" in session.body
      ? (session.body as { readonly csrfToken: unknown }).csrfToken
      : undefined;
  if (session.status !== 200 || typeof token !== "string") {
    return session.status === 200 ? RUNTIME_UNREACHABLE : session;
  }
  return sendToRuntime(path, {
    method,
    headers: { "content-type": "application/json", "x-zet-csrf": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function postToRuntime(path: string, body: unknown): Promise<RuntimeResponse> {
  return mutateRuntime(path, "POST", body);
}

export interface RunSummary {
  readonly runId: string;
  readonly status: string;
  readonly graphId: string;
  readonly createdAtMs: number;
  /** The run this one was forked from; absent from older daemons. */
  readonly parentRunId?: string | null;
}

export function fetchRecentRuns(): Promise<RuntimeFetch<{ readonly runs: readonly RunSummary[] }>> {
  return readRuntime<{ readonly runs: readonly RunSummary[] }>("/api/runs");
}
export interface ProjectSummary {
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly updatedAtMs: number;
}

export function fetchProjects(): Promise<
  RuntimeFetch<{ readonly projects: readonly ProjectSummary[] }>
> {
  return readRuntime<{ readonly projects: readonly ProjectSummary[] }>("/api/projects?status=all");
}

/** The models a person configured; keys are never part of this answer. */
export function fetchModels(): Promise<RuntimeFetch<{ readonly models: readonly unknown[] }>> {
  return readRuntime<{ readonly models: readonly unknown[] }>("/api/models");
}

export interface SetupStatus {
  readonly workspace: { readonly path: string; readonly exists: boolean } | null;
  readonly modelsConfigured: number;
  readonly complete: boolean;
}

/** Whether first-run setup is done: where the harness works, and whether a model is connected. */
export function fetchSetup(): Promise<RuntimeFetch<{ readonly setup: SetupStatus }>> {
  return readRuntime<{ readonly setup: SetupStatus }>("/api/setup");
}
