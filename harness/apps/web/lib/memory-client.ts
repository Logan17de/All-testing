import type { WorkspaceResult } from "./workspace-client";
import { reasonOf } from "./workspace-types";

/** The kinds of thing a project can remember, as the runtime defines them. */
export const MEMORY_KINDS = ["fact", "preference", "decision", "note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_TITLE_MAX_LENGTH = 200;
export const MEMORY_BODY_MAX_LENGTH = 8_000;

export interface MemoryView {
  readonly memoryId: string;
  readonly projectId: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly body: string;
  readonly pinned: boolean;
  readonly source: "person" | "agent";
  readonly sourceRunId: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** What a reader is asking the project to recall; an empty field asks for everything. */
export interface MemoryFilter {
  readonly search: string;
  readonly kind: MemoryKind | "";
  readonly pinnedOnly: boolean;
}

export const NO_MEMORY_FILTER: MemoryFilter = { search: "", kind: "", pinnedOnly: false };

/** What a person is writing down; the runtime decides whether it is acceptable. */
export interface MemoryDraft {
  readonly title: string;
  readonly body: string;
  readonly kind: MemoryKind;
}

/** What a person is changing about a memory; an absent field is left alone. */
export interface MemoryChange {
  readonly title?: string;
  readonly body?: string;
  readonly kind?: MemoryKind;
  readonly pinned?: boolean;
}

/**
 * The URL for a filtered recall.
 *
 * An empty search is left out rather than sent as an empty `q`, which the runtime
 * refuses: asking for everything is not the same as asking for nothing.
 */
export function memoryListUrl(projectId: string, filter: MemoryFilter): string {
  const query = new URLSearchParams();
  if (filter.pinnedOnly) query.set("pinned", "true");
  if (filter.kind !== "") query.set("kind", filter.kind);
  if (filter.search.trim().length > 0) query.set("q", filter.search.trim());
  const text = query.toString();
  return `/api/editor/projects/${encodeURIComponent(projectId)}/memories${
    text.length > 0 ? `?${text}` : ""
  }`;
}

async function send<T>(url: string, init?: RequestInit): Promise<WorkspaceResult<T>> {
  try {
    const response = await fetch(url, { cache: "no-store", ...init });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      return {
        ok: false,
        reason: reasonOf(payload, `The request failed (${String(response.status)}).`),
      };
    }
    return { ok: true, data: payload as T };
  } catch {
    return { ok: false, reason: "The runtime daemon is not reachable." };
  }
}

function withBody(method: "POST" | "PATCH" | "DELETE", body?: unknown): RequestInit {
  return {
    method,
    // The runtime asks for the JSON content type on every change, including a
    // delete that carries nothing: a plain cross-site form cannot send it.
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export async function listMemories(
  projectId: string,
  filter: MemoryFilter,
): Promise<WorkspaceResult<readonly MemoryView[]>> {
  const result = await send<{ readonly memories: readonly MemoryView[] }>(
    memoryListUrl(projectId, filter),
  );
  return result.ok ? { ok: true, data: result.data.memories } : result;
}

export async function rememberMemory(
  projectId: string,
  draft: MemoryDraft,
): Promise<WorkspaceResult<MemoryView>> {
  const result = await send<{ readonly memory: MemoryView }>(
    memoryListUrl(projectId, NO_MEMORY_FILTER),
    withBody("POST", draft),
  );
  return result.ok ? { ok: true, data: result.data.memory } : result;
}

export async function changeMemory(
  memoryId: string,
  change: MemoryChange,
): Promise<WorkspaceResult<MemoryView>> {
  const result = await send<{ readonly memory: MemoryView }>(
    `/api/editor/memories/${encodeURIComponent(memoryId)}`,
    withBody("PATCH", change),
  );
  return result.ok ? { ok: true, data: result.data.memory } : result;
}

/** Forgetting removes the memory; the harness keeps no quiet copy of it. */
export async function forgetMemory(memoryId: string): Promise<WorkspaceResult<true>> {
  const result = await send<unknown>(
    `/api/editor/memories/${encodeURIComponent(memoryId)}`,
    withBody("DELETE"),
  );
  return result.ok ? { ok: true, data: true } : result;
}
