/**
 * The memory endpoints the browser may reach through `/api/editor`.
 *
 * Like the workspace proxy, these routes attach the runtime's CSRF token on the
 * server, so they must never become a general-purpose tunnel into the daemon.
 * Only a well-formed id passes, and only these query parameters, taken once each
 * so a repeated parameter cannot smuggle a second value past the runtime.
 */

import { isSortableId } from "./ids";

const ALLOWED_LIST_KEYS: readonly string[] = ["pinned", "kind", "q", "limit"];

/** The runtime path for one project's memories, or undefined when it is not allowed. */
export function runtimeProjectMemoriesPath(
  projectId: string,
  search: URLSearchParams,
): string | undefined {
  if (!isSortableId(projectId)) return undefined;
  const query = new URLSearchParams();
  for (const key of ALLOWED_LIST_KEYS) {
    const value = search.get(key);
    if (value !== null && value.length > 0) query.set(key, value);
  }
  const text = query.toString();
  return `/api/projects/${projectId}/memories${text.length > 0 ? `?${text}` : ""}`;
}

/** The runtime path for one memory, or undefined when it is not allowed. */
export function runtimeMemoryPath(memoryId: string): string | undefined {
  return isSortableId(memoryId) ? `/api/memories/${memoryId}` : undefined;
}
