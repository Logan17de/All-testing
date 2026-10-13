"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { readTerminals, terminalAction, type TerminalSnapshot } from "./terminal-transport";
import { TerminalRenderer } from "./terminal-renderer";
import { Icon } from "../ui/workspace-icon";

export function TerminalDock({
  conversationId,
  embedded = false,
  visible = true,
}: {
  conversationId: string;
  cwd?: string;
  embedded?: boolean;
  visible?: boolean;
}) {
  const [dockOpen, setOpen] = useState(false);
  const open = embedded || dockOpen;
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | null>(null);
  const [selected, setSelected] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmedNonce, setConfirmedNonce] = useState("");
  const [height, setHeight] = useState(240);
  const output = useRef<HTMLPreElement>(null);
  const inputQueue = useRef<Promise<unknown>>(Promise.resolve());
  const inputAllowed = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inputAllowed.current = false;
    };
  }, []);
  useEffect(() => {
    if (!conversationId || !visible) return;
    let stale = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const result = await readTerminals(conversationId);
      if (stale) return;
      if (result.ok) {
        setSnapshot(result.data);
        setError("");
      } else {
        setError(result.reason);
        setSnapshot(null);
      }
      timer = setTimeout(() => {
        void poll();
      }, 1000);
    };
    void poll();
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [conversationId, visible]);
  const sessions = snapshot?.sessions.filter((s) => s.conversationId === conversationId) ?? [];
  const active = sessions.find((s) => s.id === selected) ?? sessions[0];
  useEffect(() => {
    if (output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [active?.cursor]);
  const run = async (action: string, fields: Record<string, unknown> = {}) => {
    setBusy(true);
    const result = await terminalAction(conversationId, action, fields);
    if (!result.ok) {
      setError(result.reason);
      setSnapshot(null);
      setConfirmedNonce("");
    } else {
      const read = await readTerminals(conversationId);
      if (read.ok) {
        setSnapshot(read.data);
        setError("");
      } else {
        setSnapshot(null);
        setError(read.reason);
      }
    }
    setBusy(false);
  };
  const running = active?.status === "running";
  const canInput = visible && !error && running && snapshot?.capability.input === true;
  useLayoutEffect(() => {
    inputAllowed.current = Boolean(canInput && !busy);
  }, [canInput, busy]);
  const sendInput = (terminalId: string, text: string) => {
    inputQueue.current = inputQueue.current.then(async () => {
      if (!mounted.current || !inputAllowed.current) return;
      const result = await terminalAction(conversationId, "input", { terminalId, text });
      if (mounted.current && !result.ok) {
        inputAllowed.current = false;
        setError(result.reason);
        setSnapshot(null);
      }
    });
  };
  const review = snapshot?.grantReview;
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <section
      className="terminalDock"
      data-open={open}
      data-embedded={embedded}
      aria-label="Integrated terminal"
      style={open && !embedded ? { height } : undefined}
    >
      <header className="terminalDockHeader">
        {embedded ? (
          <h2>Terminal</h2>
        ) : (
          <button
            type="button"
            aria-expanded={open}
            aria-controls="terminal-dock-body"
            onClick={() => setOpen(!open)}
          >
            <Icon name="terminal" size={15} /> Terminal {open ? "Hide" : "Show"}
          </button>
        )}
        <span className="muted">
          {sessions.length
            ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}`
            : "No terminal sessions"}
        </span>
        {open && (
          <>
            <button
              type="button"
              disabled={busy || !conversationId || !snapshot?.capability.launch}
              onClick={() => {
                void run("create", { cols: 80, rows: 24 });
              }}
            >
              <Icon name="plus" size={14} /> New terminal
            </button>
            {!embedded ? (
              <label className="terminalDockResize">
                Dock height{" "}
                <input
                  aria-label="Terminal dock height"
                  type="range"
                  min={140}
                  max={500}
                  value={height}
                  onChange={(e) => setHeight(Number(e.target.value))}
                />
              </label>
            ) : null}
          </>
        )}
      </header>
      {open && (
        <div id="terminal-dock-body" className="terminalDockBody">
          {sessions.length > 0 && (
            <div className="terminalTabs" role="tablist" aria-label="Terminal sessions">
              {sessions.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={active?.id === s.id}
                  onClick={() => setSelected(s.id)}
                >
                  Terminal {i + 1} / {s.status}
                </button>
              ))}
            </div>
          )}
          {!conversationId ? (
            <p>Select a chat to use its terminal dock.</p>
          ) : !snapshot && !error ? (
            <p role="status">Checking terminal availability…</p>
          ) : null}
          {snapshot && !snapshot.capability.launch && (
            <p role="status">{snapshot.capability.reason || "Interactive terminal unavailable."}</p>
          )}
          {error && <p role="alert">{error}</p>}
          {review && (
            <TerminalGrantReview
              review={review}
              now={now}
              confirmed={confirmedNonce === review.nonce}
              busy={busy}
              onConfirm={(value) => setConfirmedNonce(value ? review.nonce : "")}
              onGrant={() => {
                setConfirmedNonce("");
                void run("grant", { nonce: review.nonce, confirm: true });
              }}
            />
          )}
          {active && (
            <>
              <div className="terminalDockStatus">
                {active.identity && <span>{active.identity}</span>}
                {active.shell && <code>{active.shell}</code>}
                <span>Chat {active.conversationId}</span>
                <code>{active.cwd}</code>
                <span>
                  {active.status}
                  {active.exitCode !== null ? `  /  Exit ${active.exitCode}` : ""}
                </span>
                <button
                  disabled={busy || !running || !snapshot?.capability.interrupt}
                  onClick={() => {
                    void run("interrupt", { terminalId: active.id });
                  }}
                >
                  Interrupt
                </button>
                <button
                  disabled={busy || !running}
                  onClick={() => {
                    void run("stop", { terminalId: active.id });
                  }}
                >
                  Stop
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    void run("close", { terminalId: active.id });
                  }}
                >
                  Close
                </button>
                <label>
                  Columns{" "}
                  <input
                    aria-label="Terminal columns"
                    type="number"
                    min={10}
                    max={300}
                    key={`${active.id}-cols-${active.cols}`}
                    defaultValue={active.cols}
                    disabled={busy || !running || !snapshot?.capability.resize}
                    onBlur={(e) => {
                      if (Number(e.target.value) !== active.cols)
                        void run("resize", {
                          terminalId: active.id,
                          cols: Number(e.target.value),
                          rows: active.rows,
                        });
                    }}
                  />
                </label>
                <label>
                  Rows{" "}
                  <input
                    key={`${active.id}-rows-${active.rows}`}
                    aria-label="Terminal rows"
                    type="number"
                    min={2}
                    max={120}
                    defaultValue={active.rows}
                    disabled={busy || !running || !snapshot?.capability.resize}
                    onBlur={(e) => {
                      if (Number(e.target.value) !== active.rows)
                        void run("resize", {
                          terminalId: active.id,
                          cols: active.cols,
                          rows: Number(e.target.value),
                        });
                    }}
                  />
                </label>
              </div>
              {snapshot?.capability.mode === "process-output" && (
                <p className="muted">
                  Live process output. This process has no interactive terminal input or PTY resize.
                </p>
              )}
              {snapshot?.capability.mode === "human-host-pty" ? (
                <TerminalRenderer
                  key={active.id}
                  session={active}
                  enabled={Boolean(canInput && !busy)}
                  onInput={(text) => sendInput(active.id, text)}
                  onResize={(cols, rows) => {
                    if (snapshot.capability.resize)
                      void run("resize", { terminalId: active.id, cols, rows });
                  }}
                />
              ) : (
                <pre ref={output} className="terminalOutput" aria-label="Terminal output">
                  {active.truncated && "[Earlier output discarded]\n"}
                  {active.chunks.map((chunk) => (
                    <span key={chunk.sequence} data-stream={chunk.stream}>
                      {chunk.text}
                    </span>
                  ))}
                </pre>
              )}
              {snapshot?.capability.mode !== "human-host-pty" && (
                <form
                  className="terminalInput"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!canInput || !input) return;
                    void run("input", { terminalId: active.id, text: input + "\r" });
                    setInput("");
                  }}
                >
                  <label>
                    Human terminal input{" "}
                    <input
                      value={input}
                      maxLength={4095}
                      disabled={busy || !canInput}
                      autoComplete="off"
                      onChange={(e) => setInput(e.target.value)}
                    />
                  </label>
                  <button disabled={busy || !canInput || !input}>Send input</button>
                </form>
              )}
            </>
          )}
          {!active && snapshot && (
            <p className="muted">
              No process has been started. Terminal input is separate from agent tools.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function TerminalGrantReview({
  review,
  now,
  confirmed,
  busy,
  onConfirm,
  onGrant,
}: {
  review: NonNullable<TerminalSnapshot["grantReview"]>;
  now: number;
  confirmed: boolean;
  busy: boolean;
  onConfirm: (value: boolean) => void;
  onGrant: () => void;
}) {
  return (
    <fieldset className="terminalGrantReview">
      <legend>Human terminal access for this chat</legend>
      <dl>
        <dt>Windows identity</dt>
        <dd>{review.identity}</dd>
        <dt>Shell</dt>
        <dd>{review.shell}</dd>
        <dt>Folder</dt>
        <dd>{review.cwd}</dd>
        <dt>Chat</dt>
        <dd>{review.conversationId}</dd>
      </dl>
      <p>
        This shell runs as the Windows identity shown above, with that account&apos;s access. The
        folder is a starting directory, not filesystem isolation. This grant does not give agents
        terminal access.
      </p>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => onConfirm(event.target.checked)}
        />{" "}
        I approve this identity, shell and folder for this chat.
      </label>
      <button
        type="button"
        disabled={busy || !confirmed || !now || review.expiresAt <= now}
        onClick={onGrant}
      >
        Grant human terminal access
      </button>
    </fieldset>
  );
}
