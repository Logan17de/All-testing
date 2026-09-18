/**
 * Why something failed, in words a person can act on.
 *
 * The runtime records a failure as codes, never as an exception's text, so the
 * words live here. A model check and a failed run both end up saying the same
 * thing about the same code, because a refused key is a refused key wherever it
 * turns up.
 */

export const MODEL_FAILURE_REASONS: Readonly<Record<string, string>> = {
  MODEL_CREDENTIAL_UNAVAILABLE:
    "No key was available: store one, sign in again, or set the environment variable and restart the runtime.",
  MODEL_NETWORK_ERROR: "The endpoint could not be reached. Is the server running at that URL?",
  MODEL_TIMEOUT: "The endpoint took too long to answer.",
  MODEL_RESPONSE_INVALID: "Something answered, but not in the Chat Completions format.",
  MODEL_RESPONSE_LIMIT: "The endpoint's answer was larger than the harness accepts.",
  MODEL_STREAM_TRUNCATED: "The endpoint stopped part way through its answer.",
  MODEL_REQUEST_UNSUPPORTED: "The endpoint does not support what this step asked for.",
  MODEL_CONFIGURATION_INVALID: "The runtime could not use this endpoint URL.",
  MODEL_NOT_REGISTERED: "The runtime has not loaded this model yet. Restart the runtime.",
  AGENT_NO_MODEL:
    "No connected model could take this step: connect one on Models, or pick a different model for this chat.",
  AGENT_CONVERSATION_NOT_FOUND: "The conversation this step answers is gone.",
  AGENT_PROJECT_BUSY: "Another run is already working on this project.",
  AGENT_BUDGET_EXCEEDED: "The step reached the limit set for it.",
  AGENT_CONFIG_INVALID: "A step's settings are not valid; open the workflow in the editor.",
  PERMISSION_DENIED: "A step asked for something it was not allowed to do.",
  RUNTIME_BUDGET_EXCEEDED: "The run reached the limit set for it.",
};

/** What an HTTP status from a model endpoint means, in the same words everywhere. */
export function httpFailureReason(status: number): string {
  if (status === 401 || status === 403) {
    return `The endpoint refused the key (HTTP ${String(status)}).`;
  }
  if (status === 402) {
    return "The provider says this account cannot pay for the request (HTTP 402). Check your credit or billing with them.";
  }
  if (status === 404) {
    return "The endpoint answered 404: check the URL ends where the API starts (often /v1), and the model name.";
  }
  if (status === 429)
    return "The endpoint is rate limiting this key (HTTP 429). Try again shortly.";
  if (status >= 500) return `The endpoint had a server error (HTTP ${String(status)}).`;
  return `The endpoint refused the request (HTTP ${String(status)}); check the model name.`;
}

/** One code, with the endpoint's status when it answered, or nothing for a code we have no words for. */
export function failureReason(code: string, status?: number): string | undefined {
  if (code === "MODEL_HTTP_ERROR" && status !== undefined) return httpFailureReason(status);
  return MODEL_FAILURE_REASONS[code];
}

/**
 * What a recorded failure says, or nothing when it says only that it failed.
 *
 * A failure is `{ code, cause? }`: the code is the runtime's own, and the cause
 * is what the step reported. The cause is the useful half, so it wins.
 */
export function describeFailure(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  const cause = record["cause"];
  if (typeof cause === "object" && cause !== null) {
    const inner = cause as Record<string, unknown>;
    const code = inner["code"];
    if (typeof code === "string") {
      const status = inner["status"];
      return failureReason(code, typeof status === "number" ? status : undefined) ?? null;
    }
  }
  const code = record["code"];
  if (typeof code !== "string") return null;
  return MODEL_FAILURE_REASONS[code] ?? null;
}
