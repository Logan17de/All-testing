"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Terminal as Xterm } from "@xterm/xterm";
import type { TerminalSession } from "./terminal-transport";
import "@xterm/xterm/css/xterm.css";

export function terminalDelta(session: TerminalSession, cursor: number) {
  return session.chunks.filter((chunk) => chunk.sequence > cursor);
}
export function TerminalRenderer({
  session,
  enabled,
  onInput,
  onResize,
}: {
  session: TerminalSession;
  enabled: boolean;
  onInput: (text: string) => void;
  onResize: (cols: number, rows: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Xterm | null>(null);
  const latest = useRef({ enabled, onInput, onResize, session });
  useLayoutEffect(() => {
    latest.current = { enabled, onInput, onResize, session };
  }, [enabled, onInput, onResize, session]);
  const written = useRef(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !host.current) return;
        const term = new Terminal({
          disableStdin: !latest.current.enabled,
          fontFamily: getComputedStyle(host.current).fontFamily,
          fontSize: 13,
          scrollback: 2000,
          allowProposedApi: false,
          theme: { background: "#1d1d1d", foreground: "#ededed", cursor: "#ededed" },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(host.current);
        instance.current = term;
        const data = term.onData((text) => {
          if (latest.current.enabled) latest.current.onInput(text);
        });
        let dimensions = "";
        const resize = () => {
          if (!host.current?.clientWidth || !host.current.clientHeight) return;
          fit.fit();
          const next = `${term.cols}:${term.rows}`;
          if (latest.current.enabled && next !== dimensions) {
            dimensions = next;
            latest.current.onResize(term.cols, term.rows);
          }
        };
        const observer = new ResizeObserver(resize);
        observer.observe(host.current);
        resize();
        setReady(true);
        cleanup = () => {
          observer.disconnect();
          data.dispose();
          term.dispose();
          instance.current = null;
        };
      })
      .catch(() => {
        if (!disposed) setError("Terminal renderer could not be loaded.");
      });
    return () => {
      disposed = true;
      cleanup();
    };
  }, []);
  useEffect(() => {
    if (instance.current) instance.current.options.disableStdin = !enabled;
  }, [enabled, ready]);
  useEffect(() => {
    const term = instance.current;
    if (!term || !ready) return;
    const first = session.chunks[0]?.sequence ?? 0;
    if (written.current > session.cursor || (written.current && first > written.current + 1)) {
      term.reset();
      written.current = 0;
    }
    for (const chunk of terminalDelta(session, written.current)) {
      term.write(chunk.text);
      written.current = chunk.sequence;
    }
  }, [session, ready]);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <div ref={host} className="terminalEmulator" aria-label="Human interactive terminal" />
    </>
  );
}
