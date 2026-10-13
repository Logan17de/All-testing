import { randomUUID } from "node:crypto";

export interface TerminalIdentity {
  readonly ownerKey: string;
  readonly conversationId: string;
}
export interface HumanTerminalGrant extends TerminalIdentity {
  readonly cwd: string;
  readonly shell: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly windowsIdentity: string;
}
export interface TerminalChunk {
  readonly sequence: number;
  readonly stream: "stdout" | "stderr" | "terminal";
  readonly text: string;
}
export interface TerminalView {
  readonly id: string;
  readonly conversationId: string;
  readonly cwd: string;
  readonly identity?: string;
  readonly shell?: string;
  readonly status: "running" | "exited" | "closed" | "failed";
  readonly exitCode: number | null;
  readonly cols: number;
  readonly rows: number;
  readonly chunks: readonly TerminalChunk[];
  readonly cursor: number;
  readonly truncated: boolean;
}
/** Host-authored adapter only. Never exposed as agent authority or request data.
 * Human host ConPTY is a distinct explicitly granted authority, never agent sandbox fallback. */
export interface SandboxedTerminalAdapter {
  readonly authority?: { readonly windowsIdentity: string; readonly shell: string };
  readonly capabilities: {
    readonly interactive: boolean;
    readonly input: boolean;
    readonly resize: boolean;
    readonly interrupt: boolean;
    readonly mode: "sandbox-pty" | "process-output" | "human-host-pty";
  };
  launch(request: {
    identity: TerminalIdentity;
    grant?: HumanTerminalGrant;
    cwd: string;
    cols: number;
    rows: number;
    signal: AbortSignal;
    output: (stream: "stdout" | "stderr" | "terminal", text: string) => void;
    exit: (code: number | null) => void;
  }): Promise<{
    input(text: string): Promise<void>;
    resize(cols: number, rows: number): Promise<void>;
    interrupt(): Promise<void>;
    close(): Promise<void>;
  }>;
}
export class TerminalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
const BLOCKED =
  "Interactive terminals require a verified sandbox-compatible Windows ConPTY adapter. No host shell fallback is enabled.";
type RecordEntry = {
  identity: TerminalIdentity;
  view: TerminalView;
  controller: AbortController;
  process?: Awaited<ReturnType<SandboxedTerminalAdapter["launch"]>>;
  lease: number;
  grant?: HumanTerminalGrant;
};
export class RuntimeTerminalService {
  readonly #sessions = new Map<string, RecordEntry>();
  readonly #pending = new Map<string, number>();
  readonly #adapter: SandboxedTerminalAdapter | undefined;
  readonly #now: () => number;
  readonly #validateCwd: ((identity: TerminalIdentity, cwd: string) => Promise<string>) | undefined;
  readonly #humanGrant:
    ((identity: TerminalIdentity) => HumanTerminalGrant | undefined) | undefined;
  readonly #revokeHumanGrant: ((identity: TerminalIdentity) => void) | undefined;
  #disposed = false;
  #generation = 0;
  constructor(
    options: {
      adapter?: SandboxedTerminalAdapter;
      now?: () => number;
      validateCwd?: (identity: TerminalIdentity, cwd: string) => Promise<string>;
      humanGrant?: (identity: TerminalIdentity) => HumanTerminalGrant | undefined;
      revokeHumanGrant?: (identity: TerminalIdentity) => void;
    } = {},
  ) {
    this.#adapter = options.adapter;
    this.#now = options.now ?? Date.now;
    this.#validateCwd = options.validateCwd;
    this.#humanGrant = options.humanGrant;
    this.#revokeHumanGrant = options.revokeHumanGrant;
    if (options.adapter && !options.validateCwd)
      throw new Error("Terminal adapter requires trusted cwd validation.");
    if (
      options.adapter?.capabilities.mode === "human-host-pty" &&
      (!options.humanGrant || !options.adapter.authority)
    )
      throw new Error(
        "Human terminal requires trusted grant getter and actual Windows authority identity.",
      );
  }
  capability(identity?: TerminalIdentity) {
    const human = this.#adapter?.capabilities.mode === "human-host-pty";
    const granted =
      !human || Boolean(identity && this.#validGrant(identity, this.#humanGrant?.(identity)));
    return {
      launch: Boolean(this.#adapter) && !this.#disposed && granted,
      interactive: Boolean(this.#adapter?.capabilities.interactive) && !this.#disposed && granted,
      input: Boolean(this.#adapter?.capabilities.input) && !this.#disposed && granted,
      resize: Boolean(this.#adapter?.capabilities.resize) && !this.#disposed && granted,
      interrupt: Boolean(this.#adapter?.capabilities.interrupt) && !this.#disposed && granted,
      mode: this.#adapter?.capabilities.mode ?? "unavailable",
      requiresGrant: human,
      authorityIdentity: this.#adapter?.authority?.windowsIdentity ?? "",
      shell: this.#adapter?.authority?.shell ?? "",
      reason: this.#disposed
        ? "Terminal service is stopped."
        : human && !granted
          ? "Human terminal requires a current owner/chat authority grant."
          : this.#adapter
            ? ""
            : BLOCKED,
    };
  }
  #validGrant(identity: TerminalIdentity, grant: HumanTerminalGrant | undefined, cwd?: string) {
    return Boolean(
      grant &&
      grant.ownerKey === identity.ownerKey &&
      grant.conversationId === identity.conversationId &&
      (!cwd || grant.cwd === cwd) &&
      grant.cwd &&
      grant.shell === this.#adapter?.authority?.shell &&
      grant.windowsIdentity === this.#adapter?.authority?.windowsIdentity &&
      typeof grant.nonce === "string" &&
      /^[A-Za-z0-9_-]{32,128}$/u.test(grant.nonce) &&
      Number.isSafeInteger(grant.expiresAt) &&
      grant.expiresAt > this.#now(),
    );
  }
  async #liveOwned(identity: TerminalIdentity, id: string) {
    const entry = this.#owned(identity, id);
    if (entry.grant) {
      const current = this.#humanGrant?.(identity);
      if (
        !this.#validGrant(identity, current, entry.view.cwd) ||
        current?.nonce !== entry.grant.nonce
      ) {
        await this.close(identity, id);
        throw new TerminalError(
          "TERMINAL_GRANT_REVOKED",
          "Human terminal grant expired or was revoked; processes terminated.",
          403,
        );
      }
    }
    return entry;
  }
  #identity(identity: TerminalIdentity) {
    if (!identity.ownerKey || !identity.conversationId)
      throw new TerminalError("TERMINAL_AUTH_REQUIRED", "Human session identity required.", 403);
  }
  #owned(identity: TerminalIdentity, id: string) {
    this.#identity(identity);
    const entry = this.#sessions.get(id);
    if (
      !entry ||
      entry.identity.ownerKey !== identity.ownerKey ||
      entry.identity.conversationId !== identity.conversationId
    )
      throw new TerminalError("TERMINAL_NOT_FOUND", "Terminal not found.", 404);
    entry.lease = this.#now();
    return entry;
  }
  #geometry(cols: number, rows: number) {
    if (
      !Number.isInteger(cols) ||
      cols < 10 ||
      cols > 300 ||
      !Number.isInteger(rows) ||
      rows < 2 ||
      rows > 120
    )
      throw new TerminalError("TERMINAL_INVALID", "Terminal size is invalid.");
  }
  list(identity: TerminalIdentity, after = 0) {
    this.#identity(identity);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new TerminalError("TERMINAL_INVALID", "Invalid output cursor.");
    return {
      capability: this.capability(identity),
      sessions: [...this.#sessions.values()]
        .filter(
          (e) =>
            e.identity.ownerKey === identity.ownerKey &&
            e.identity.conversationId === identity.conversationId,
        )
        .map((e) => {
          e.lease = this.#now();
          return { ...e.view, chunks: e.view.chunks.filter((c) => c.sequence > after) };
        }),
    };
  }
  async create(identity: TerminalIdentity, cwd: string, cols = 80, rows = 24) {
    this.#identity(identity);
    this.#geometry(cols, rows);
    if (!this.#adapter || !this.#validateCwd || this.#disposed)
      throw new TerminalError("TERMINAL_UNAVAILABLE", this.capability().reason, 409);
    if (typeof cwd !== "string" || !cwd || cwd.length > 4096 || /[\x00-\x1f]/u.test(cwd))
      throw new TerminalError("TERMINAL_INVALID", "Invalid cwd.");
    const pending = this.#pending.get(identity.ownerKey) ?? 0;
    if (
      [...this.#sessions.values()].filter((e) => e.identity.ownerKey === identity.ownerKey).length +
        pending >=
        8 ||
      this.#sessions.size + [...this.#pending.values()].reduce((n, v) => n + v, 0) >= 64
    )
      throw new TerminalError("TERMINAL_LIMIT", "Close a terminal before opening another.", 409);
    this.#pending.set(identity.ownerKey, pending + 1);
    const generation = this.#generation;
    let canonical: string;
    try {
      canonical = await this.#validateCwd(identity, cwd);
    } finally {
      const remaining = (this.#pending.get(identity.ownerKey) ?? 1) - 1;
      if (remaining) this.#pending.set(identity.ownerKey, remaining);
      else this.#pending.delete(identity.ownerKey);
    }
    if (this.#disposed || generation !== this.#generation)
      throw new TerminalError("TERMINAL_UNAVAILABLE", "Terminal service is stopped.", 409);
    const grant =
      this.#adapter.capabilities.mode === "human-host-pty"
        ? this.#humanGrant?.(identity)
        : undefined;
    if (
      this.#adapter.capabilities.mode === "human-host-pty" &&
      !this.#validGrant(identity, grant, canonical)
    )
      throw new TerminalError(
        "TERMINAL_GRANT_REQUIRED",
        "Current human terminal authority grant required.",
        403,
      );
    const entry: RecordEntry = {
      identity: { ...identity },
      controller: new AbortController(),
      lease: this.#now(),
      ...(grant ? { grant: { ...grant } } : {}),
      view: {
        id: randomUUID(),
        conversationId: identity.conversationId,
        cwd: canonical,
        ...(grant ? { identity: grant.windowsIdentity, shell: grant.shell } : {}),
        status: "running",
        exitCode: null,
        cols,
        rows,
        chunks: [],
        cursor: 0,
        truncated: false,
      },
    };
    this.#sessions.set(entry.view.id, entry);
    try {
      entry.process = await this.#adapter.launch({
        identity: { ...identity },
        ...(grant ? { grant: { ...grant } } : {}),
        cwd: canonical,
        cols,
        rows,
        signal: entry.controller.signal,
        output: (stream, text) => {
          if (entry.view.status !== "running") return;
          const bounded = text.slice(-16_384);
          const chunks = [
            ...entry.view.chunks,
            { sequence: entry.view.cursor + 1, stream, text: bounded },
          ];
          let size = chunks.reduce((n, c) => n + c.text.length, 0);
          let truncated = bounded !== text || entry.view.truncated;
          while (size > 65_536 || chunks.length > 256) {
            size -= chunks.shift()!.text.length;
            truncated = true;
          }
          entry.view = { ...entry.view, chunks, cursor: entry.view.cursor + 1, truncated };
        },
        exit: (code) => {
          if (entry.view.status === "running")
            entry.view = { ...entry.view, status: "exited", exitCode: code };
        },
      });
      if (
        entry.controller.signal.aborted ||
        generation !== this.#generation ||
        (grant &&
          (!this.#validGrant(identity, this.#humanGrant?.(identity), canonical) ||
            this.#humanGrant?.(identity)?.nonce !== grant.nonce))
      ) {
        await entry.process.close();
        throw new Error("Terminal launch authority revoked.");
      }
      return { ...entry.view };
    } catch {
      entry.controller.abort();
      this.#sessions.delete(entry.view.id);
      throw new TerminalError(
        "TERMINAL_LAUNCH_FAILED",
        "Sandbox terminal launch failed; no host fallback.",
        409,
      );
    }
  }
  async input(identity: TerminalIdentity, id: string, text: string) {
    const entry = await this.#liveOwned(identity, id);
    if (!this.#adapter?.capabilities.input)
      throw new TerminalError("TERMINAL_UNSUPPORTED", "This process has no stdin support.", 409);
    if (typeof text !== "string" || !text || text.length > 4096)
      throw new TerminalError("TERMINAL_INVALID", "Input exceeds terminal bounds.");
    if (entry.view.status !== "running" || !entry.process)
      throw new TerminalError("TERMINAL_NOT_RUNNING", "Terminal is not running.", 409);
    await entry.process.input(text);
  }
  async resize(identity: TerminalIdentity, id: string, cols: number, rows: number) {
    const entry = await this.#liveOwned(identity, id);
    if (!this.#adapter?.capabilities.resize)
      throw new TerminalError(
        "TERMINAL_UNSUPPORTED",
        "PTY resize unsupported by this adapter.",
        409,
      );
    this.#geometry(cols, rows);
    if (entry.view.status !== "running" || !entry.process)
      throw new TerminalError("TERMINAL_NOT_RUNNING", "Terminal is not running.", 409);
    await entry.process.resize(cols, rows);
    entry.view = { ...entry.view, cols, rows };
  }
  async interrupt(identity: TerminalIdentity, id: string) {
    const entry = await this.#liveOwned(identity, id);
    if (!this.#adapter?.capabilities.interrupt)
      throw new TerminalError(
        "TERMINAL_UNSUPPORTED",
        "Console interrupt unsupported by this adapter.",
        409,
      );
    if (entry.view.status !== "running" || !entry.process)
      throw new TerminalError("TERMINAL_NOT_RUNNING", "Terminal is not running.", 409);
    await entry.process.interrupt();
  }
  async close(identity: TerminalIdentity, id: string) {
    const entry = this.#owned(identity, id);
    entry.controller.abort();
    try {
      await entry.process?.close();
    } catch (error) {
      entry.view = { ...entry.view, status: "failed" };
      throw error;
    }
    entry.view = { ...entry.view, status: "closed" };
    this.#sessions.delete(id);
  }
  async stop(identity: TerminalIdentity, id: string) {
    const entry = this.#owned(identity, id);
    entry.controller.abort();
    try {
      await entry.process?.close();
    } catch (error) {
      entry.view = { ...entry.view, status: "failed" };
      throw error;
    }
    delete entry.process;
    entry.view = { ...entry.view, status: "exited" };
  }
  async expireLeases(maxIdleMs = 30_000) {
    for (const [id, e] of this.#sessions)
      if (
        this.#now() - e.lease >= maxIdleMs ||
        (e.grant &&
          (!this.#validGrant(e.identity, this.#humanGrant?.(e.identity), e.view.cwd) ||
            this.#humanGrant?.(e.identity)?.nonce !== e.grant.nonce))
      ) {
        if (e.grant) this.#revokeHumanGrant?.(e.identity);
        await this.close(e.identity, id);
      }
  }
  async dispose() {
    this.#disposed = true;
    await this.revokeAll();
  }
  /** Abort synchronously before awaiting teardown. Pending launches cannot revive authority. */
  async revokeAll() {
    this.#generation++;
    const entries = [...this.#sessions];
    for (const [, e] of entries) e.controller.abort();
    await Promise.all(entries.map(([id, e]) => this.close(e.identity, id)));
  }
}
