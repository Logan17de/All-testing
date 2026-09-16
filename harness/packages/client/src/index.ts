/**
 * A client for a running harness.
 *
 * This is the bridge another program crosses to reach the harness: a phone app, a
 * chat client, a script on the same machine. It speaks only the client ingress —
 * a token instead of a browser session — and holds no state of its own beyond the
 * token and the origin, so a caller can create one per connection or keep one for
 * the life of the process.
 *
 * It has no dependencies: `fetch` and web streams are Node's own.
 */

export type HarnessClientScope = "read" | "messages" | "approvals";

export interface HarnessClientOptions {
  /** Where the daemon answers, for example `http://127.0.0.1:3211`. */
  readonly origin: string;
  /** The token the editor issued for this client. */
  readonly token: string;
  /** Replaced in tests; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface HarnessClientIdentity {
  readonly clientId: string;
  readonly name: string;
  readonly scopes: readonly HarnessClientScope[];
  readonly createdAtMs: number;
  readonly lastSeenAtMs: number | null;
  readonly revokedAtMs: number | null;
}

export interface HarnessRunSummary {
  readonly runId: string;
  readonly status: string;
  readonly graphId: string;
}

export interface HarnessApproval {
  readonly approvalId: string;
  readonly runId: string;
  readonly opIndex: number;
  readonly status: string;
  readonly requestJson: string | null;
}

export interface HarnessWake {
  readonly runId: string;
  readonly status: string;
  /** False when the run had already finished, or no executor is configured. */
  readonly woken: boolean;
}

export interface HarnessMessageSent {
  readonly messageId: string;
  readonly conversationId: string;
  readonly woken: boolean;
}

export interface HarnessStreamEvent {
  readonly id: number | null;
  readonly event: string;
  readonly data: unknown;
}

/** An error the harness answered with, carrying its code so a caller can act on it. */
export class HarnessClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "HarnessClientError";
    this.code = code;
    this.status = status;
  }
}

interface ErrorBody {
  readonly error?: { readonly code?: unknown; readonly reason?: unknown } | string;
}

function errorFrom(status: number, body: unknown): HarnessClientError {
  const error = (body as ErrorBody | undefined)?.error;
  if (typeof error === "object" && error !== null) {
    const code = typeof error.code === "string" ? error.code : "HARNESS_REQUEST_FAILED";
    const reason = typeof error.reason === "string" ? error.reason : "The harness refused this.";
    return new HarnessClientError(code, reason, status);
  }
  return new HarnessClientError(
    "HARNESS_REQUEST_FAILED",
    typeof error === "string" ? error : `The harness answered ${String(status)}.`,
    status,
  );
}

export class HarnessClient {
  readonly #origin: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HarnessClientOptions) {
    if (options.origin.trim().length === 0) throw new TypeError("A harness origin is required.");
    if (options.token.trim().length === 0) throw new TypeError("A client token is required.");
    this.#origin = options.origin.replace(/\/+$/u, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async #request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.#fetch(`${this.#origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      ...(signal === undefined ? {} : { signal }),
    });
    const parsed: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw errorFrom(response.status, parsed);
    return parsed as T;
  }

  /** Who this token belongs to, and what it may do. */
  async whoami(): Promise<HarnessClientIdentity> {
    const body = await this.#request<{ readonly client: HarnessClientIdentity }>(
      "GET",
      "/api/client/whoami",
    );
    return body.client;
  }

  /** One run, as the inspector sees it. */
  async run(runId: string): Promise<Record<string, unknown>> {
    const body = await this.#request<{ readonly run: Record<string, unknown> }>(
      "GET",
      `/api/client/runs/${encodeURIComponent(runId)}`,
    );
    return body.run;
  }

  /**
   * Ask the harness to look at a run again.
   *
   * This never creates work, so it is safe to call after a reconnect, on a timer, or
   * twice by accident: a finished run simply answers `woken: false`.
   */
  wake(runId: string): Promise<HarnessWake> {
    return this.#request<HarnessWake>("POST", `/api/client/runs/${encodeURIComponent(runId)}/wake`);
  }

  /** Human decisions still waiting, for one run or for all of them. */
  async pendingApprovals(runId?: string): Promise<readonly HarnessApproval[]> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    const body = await this.#request<{ readonly approvals: readonly HarnessApproval[] }>(
      "GET",
      `/api/client/approvals${query}`,
    );
    return body.approvals;
  }

  /**
   * Answer a waiting approval.
   *
   * Answering the same way twice is safe and comes back as `duplicate: true`; a
   * different answer to an approval already settled is refused rather than applied.
   */
  answerApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    payload?: unknown,
  ): Promise<{ readonly approval: HarnessApproval; readonly duplicate: boolean }> {
    return this.#request("POST", `/api/client/approvals/${encodeURIComponent(approvalId)}`, {
      decision,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  /** Add a message to a conversation, and optionally wake the run working on it. */
  async sendMessage(
    conversationId: string,
    text: string,
    options: { readonly wakeRunId?: string } = {},
  ): Promise<HarnessMessageSent> {
    const body = await this.#request<{
      readonly message: { readonly messageId: string; readonly conversationId: string };
      readonly woken: boolean;
    }>("POST", `/api/client/conversations/${encodeURIComponent(conversationId)}/messages`, {
      text,
      ...(options.wakeRunId === undefined ? {} : { runId: options.wakeRunId }),
    });
    return {
      messageId: body.message.messageId,
      conversationId: body.message.conversationId,
      woken: body.woken,
    };
  }

  /**
   * The harness's event stream, as an async iterator.
   *
   * Pass the last id seen to carry on where a dropped connection left off. The
   * iterator ends when the signal aborts or the server closes the stream; a caller
   * that wants to keep watching calls it again with the last id it received, which
   * is the only state a reconnect needs.
   */
  async *events(
    options: { readonly cursor?: number; readonly signal?: AbortSignal } = {},
  ): AsyncGenerator<HarnessStreamEvent> {
    const query = options.cursor === undefined ? "" : `?cursor=${String(options.cursor)}`;
    const response = await this.#fetch(`${this.#origin}/api/events${query}`, {
      headers: { authorization: `Bearer ${this.#token}`, accept: "text/event-stream" },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok || response.body === null) {
      throw errorFrom(response.status, await response.json().catch(() => undefined));
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseFrame(frame);
        if (parsed !== undefined) yield parsed;
        boundary = buffer.indexOf("\n\n");
      }
    }
  }
}

/** One `text/event-stream` frame: its id, its event name and its parsed data. */
function parseFrame(frame: string): HarnessStreamEvent | undefined {
  let id: number | null = null;
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":") || line.trim().length === 0) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).trimStart();
    if (field === "id") {
      const parsed = Number(value);
      id = Number.isSafeInteger(parsed) ? parsed : null;
    } else if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  if (data.length === 0) return undefined;
  const text = data.join("\n");
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // A stream that is not JSON is still an event; hand the caller the text.
  }
  return Object.freeze({ id, event, data: parsed });
}
