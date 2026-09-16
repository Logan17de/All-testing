/**
 * The model endpoints the browser may reach through `/api/editor/models`.
 *
 * The proxy attaches the runtime's CSRF token, so only a well-formed model id
 * reaches the runtime; anything else is refused here.
 */

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** The runtime path for one configured model, or undefined when the id is not one. */
export function runtimeModelPath(modelId: string, action?: "check"): string | undefined {
  if (!MODEL_ID.test(modelId)) return undefined;
  return `/api/models/${modelId}${action === undefined ? "" : `/${action}`}`;
}
