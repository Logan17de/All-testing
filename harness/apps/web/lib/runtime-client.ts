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
