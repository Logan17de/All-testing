import { reasonOf } from "./workspace-types";

export type WorkspaceResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly reason: string };

/**
 * Call a workspace endpoint through this app's guarded proxy.
 *
 * With a body the request is a POST; without one it is a GET. The browser never
 * talks to the runtime directly and never holds its CSRF token.
 */
export async function workspaceRequest<T>(
  path: string,
  body?: unknown,
): Promise<WorkspaceResult<T>> {
  try {
    const response = await fetch(
      `/api/editor/workspace/${path}`,
      body === undefined
        ? { cache: "no-store" }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
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
