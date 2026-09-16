/**
 * The runtime endpoints the browser may reach through `/api/editor/workspace`.
 *
 * The proxy attaches the runtime's CSRF token on the server, so it must never
 * become a general-purpose tunnel into the daemon. Only these paths, with ids in
 * the runtime's sortable format, and only these query parameters pass.
 */

import { SORTABLE_ID_SOURCE as ID } from "./ids";

const ALLOWED_PATHS: readonly RegExp[] = [
  /^projects$/u,
  new RegExp(`^projects/${ID}$`, "u"),
  new RegExp(`^projects/${ID}/(archive|restore|conversations|goals)$`, "u"),
  new RegExp(`^projects/${ID}/todos/(next|runnable)$`, "u"),
  new RegExp(`^conversations/${ID}$`, "u"),
  new RegExp(`^conversations/${ID}/(archive|restore|messages)$`, "u"),
  new RegExp(`^conversations/${ID}/messages/${ID}/path$`, "u"),
  new RegExp(`^goals/${ID}$`, "u"),
  new RegExp(`^goals/${ID}/(status|todos)$`, "u"),
  new RegExp(`^todos/${ID}$`, "u"),
  new RegExp(`^todos/${ID}/status$`, "u"),
];

const ALLOWED_QUERY_KEYS: ReadonlySet<string> = new Set(["status", "goalId", "limit"]);

/** The runtime path for a workspace request, or undefined when it is not allowed. */
export function runtimeWorkspacePath(
  segments: readonly string[],
  search: URLSearchParams,
): string | undefined {
  if (segments.some((segment) => segment.length === 0 || /[/\\]/u.test(segment))) return undefined;
  const path = segments.join("/");
  if (!ALLOWED_PATHS.some((rule) => rule.test(path))) return undefined;
  const query = new URLSearchParams();
  for (const [key, value] of search) {
    if (ALLOWED_QUERY_KEYS.has(key)) query.append(key, value);
  }
  const text = query.toString();
  return `/api/${path}${text.length > 0 ? `?${text}` : ""}`;
}
