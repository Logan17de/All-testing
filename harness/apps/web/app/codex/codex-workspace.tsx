"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceRequest } from "../../lib/workspace-client";
import { CodexRequest } from "./codex-request";
import { eventView, mergeNativeEvents, updateTurnStates, type TurnState } from "./codex-event-view";

type RecordValue = Record<string, unknown>;
type Event = { sequence: number; method: string; params: unknown };
type Approval = { id: string | number; method: string; params: unknown };
type Status = {
  scopeGeneration: number;
  available: boolean;
  events: Event[];
  pendingApprovals: Approval[];
  cursor: number;
};
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" ? (value as RecordValue) : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const preStyle = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  maxHeight: 400,
  overflow: "auto",
} as const;

export function CodexWorkspace() {
  const [status, setStatus] = useState<Status | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [models, setModels] = useState<RecordValue[]>([]);
  const [threads, setThreads] = useState<RecordValue[]>([]);
  const [model, setModel] = useState("");
  const [sandbox, setSandbox] = useState("read-only");
  const [threadId, setThreadId] = useState("");
  const [turns, setTurns] = useState<Record<string, TurnState>>({});
  const [pollError, setPollError] = useState("");
  const [historyNotice, setHistoryNotice] = useState("");
  const [archived, setArchived] = useState(false);
  const [nextCursor, setNextCursor] = useState("");
  const [transcript, setTranscript] = useState<unknown>(null);
  const [prompt, setPrompt] = useState("");
  const [account, setAccount] = useState("Account status has not been checked.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [responding, setResponding] = useState<string | number | null>(null);
  const [loginConsent, setLoginConsent] = useState(false);
  const [login, setLogin] = useState<{ id: string; url: string } | null>(null);
  const cursor = useRef(0);
  const scopeGeneration = useRef<number | null>(null);

  const action = useCallback(async (name: string, params: RecordValue = {}) => {
    const expectedScope = scopeGeneration.current;
    const response = await workspaceRequest<{ result: unknown }>("codex", { action: name, params });
    if (expectedScope !== scopeGeneration.current)
      throw new Error(
        "The workspace changed while this request was running. Select a session in the current workspace.",
      );
    if (!response.ok) throw new Error(response.reason);
    return response.data.result;
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const result = await workspaceRequest<Status>(`codex?since=${cursor.current}`);
      if (disposed) return;
      if (result.ok) {
        const scopeChanged =
          scopeGeneration.current !== null &&
          result.data.scopeGeneration !== scopeGeneration.current;
        scopeGeneration.current = result.data.scopeGeneration;
        if (scopeChanged) {
          setModels([]);
          setThreads([]);
          setModel("");
          setSandbox("read-only");
          setThreadId("");
          setTranscript(null);
          setPrompt("");
          setAccount("Workspace changed. Refresh account and sessions.");
          setLogin(null);
          setLoginConsent(false);
          setResponding(null);
          setArchived(false);
          setNextCursor("");
          setError("");
        }
        setStatus(result.data);
        const reset = scopeChanged || result.data.cursor < cursor.current;
        const first = result.data.events[0]?.sequence;
        if (scopeChanged)
          setHistoryNotice("Workspace changed. Previous workspace content has been cleared.");
        else if (reset)
          setHistoryNotice(
            "The runtime restarted. Read the saved transcript to recover earlier history.",
          );
        else if (first !== undefined && first > cursor.current + 1)
          setHistoryNotice(
            "Some events have expired from the runtime buffer. Read the saved transcript for full history.",
          );
        cursor.current = result.data.cursor;
        setEvents((previous) => mergeNativeEvents(previous, result.data.events, reset));
        setTurns((previous) =>
          reset
            ? updateTurnStates({}, result.data.events)
            : updateTurnStates(previous, result.data.events),
        );
        setPollError("");
      } else setPollError(result.reason);
      timer = setTimeout(() => {
        void poll();
      }, 1500);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Codex request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function loadSessions(showArchived: boolean, pageCursor?: string) {
    const result = record(
      await action("thread/list", {
        archived: showArchived,
        ...(pageCursor ? { cursor: pageCursor } : {}),
      }),
    );
    const data = (Array.isArray(result.data) ? result.data : []).map(record);
    setThreads((previous) =>
      pageCursor
        ? [...new Map([...previous, ...data].map((item) => [string(item.id), item])).values()]
        : data,
    );
    setNextCursor(string(result.nextCursor));
  }

  async function refresh() {
    const [modelResult, threadResult, accountResult] = await Promise.all([
      action("model/list"),
      action("thread/list", { archived }),
      action("account/read"),
    ]);
    setModels(
      (Array.isArray(record(modelResult).data) ? (record(modelResult).data as unknown[]) : []).map(
        record,
      ),
    );
    setThreads(
      (Array.isArray(record(threadResult).data)
        ? (record(threadResult).data as unknown[])
        : []
      ).map(record),
    );
    setNextCursor(string(record(threadResult).nextCursor));
    const value = record(accountResult);
    const kind = string(record(value.account).type);
    if (kind) {
      setLogin(null);
      setLoginConsent(false);
    }
    setAccount(
      kind
        ? `Signed in through Codex (${kind}).`
        : "Codex is not signed in. Complete official CLI login on the runtime host.",
    );
  }

  async function selectThread(actionName: "thread/start" | "thread/resume") {
    const result = record(
      await action(actionName, {
        ...(actionName === "thread/resume" ? { threadId } : {}),
        sandbox,
        ...(model ? { model } : {}),
      }),
    );
    const thread = record(result.thread);
    setThreadId(string(thread.id));
    restoreTurn(thread);
    setTranscript(thread);
  }

  function restoreTurn(thread: RecordValue) {
    const last = Array.isArray(thread.turns) ? record(thread.turns.at(-1)) : {};
    const id = string(last.id);
    const currentThread = string(thread.id);
    if (id && currentThread)
      setTurns((previous) => ({
        ...previous,
        [currentThread]: { id, status: string(last.status) || "completed" },
      }));
  }

  async function respond(approval: Approval, decision: "accept" | "decline") {
    if (responding !== null) return;
    setResponding(approval.id);
    setError("");
    try {
      await action("approval/respond", { id: approval.id, decision });
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              pendingApprovals: previous.pendingApprovals.filter((item) => item.id !== approval.id),
            }
          : previous,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Approval response failed.");
    } finally {
      setResponding(null);
    }
  }

  const turnId = turns[threadId]?.id || "";
  const turnStatus = turns[threadId]?.status;
  const progress = {
    active: turnStatus === "inProgress" || turnStatus === "interruptRequested",
    label:
      turnStatus === "interruptRequested"
        ? "Interrupt requested. Waiting for Codex to stop."
        : turnStatus === "inProgress"
          ? "Codex is working. Tool output and approvals appear below."
          : turnStatus
            ? `Task ${turnStatus}.`
            : "Ready for a task.",
  };

  return (
    <>
      <section className="panel" aria-label="Codex connection">
        <h2 className="panelTitle">Connection and login</h2>
        <p role="status">
          {status
            ? status.available
              ? "Official Codex app server is connected."
              : "Codex app server has not started. Refresh to connect to the installed official CLI."
            : "Checking runtime…"}
        </p>
        <p>{account}</p>
        <button
          disabled={busy}
          onClick={() => {
            void run(refresh);
          }}
        >
          Refresh account, models and sessions
        </button>
        <p>
          <label>
            <input
              type="checkbox"
              checked={loginConsent}
              onChange={(event) => setLoginConsent(event.target.checked)}
            />{" "}
            I authorize the official Codex CLI to persist my login on this runtime host.
          </label>
        </p>
        <button
          disabled={busy || !loginConsent || login !== null}
          onClick={() => {
            void run(async () => {
              const result = record(
                await action("account/login/start", { type: "chatgpt", confirmPersistLogin: true }),
              );
              const url = new URL(string(result.authUrl));
              if (url.protocol !== "https:")
                throw new Error("Codex returned an invalid login URL.");
              setLogin({ id: string(result.loginId), url: url.href });
            });
          }}
        >
          Start official ChatGPT login
        </button>
        {login ? (
          <p>
            <a href={login.url} target="_blank" rel="noopener noreferrer">
              Complete official login and consent
            </a>{" "}
            <button
              disabled={busy}
              onClick={() => {
                void run(async () => {
                  await action("account/login/cancel", { loginId: login.id });
                  setLogin(null);
                });
              }}
            >
              Cancel login
            </button>
          </p>
        ) : null}
        <p className="muted">
          To authorize persistent subscription login, run{" "}
          <code>npm run codex -- login --confirm-persist-login</code> on the runtime host and
          complete the official browser consent. This page never starts login automatically or reads
          credentials.
        </p>
        <p className="muted">
          The workspace is the configured runtime root. Browser tools and subagents depend on the
          installed Codex version and its MCP configuration.
        </p>
      </section>
      {pollError ? (
        <p role="alert" className="panel panel--warn">
          {pollError} Live task status may be stale.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="panel panel--warn">
          {error}
        </p>
      ) : null}
      <section className="panel" aria-label="Codex sessions">
        <h2 className="panelTitle">Session</h2>
        <label>
          Model{" "}
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="">Codex default</option>
            {models.map((item) => (
              <option key={string(item.id)} value={string(item.model) || string(item.id)}>
                {string(item.displayName) || string(item.model) || string(item.id)}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Sandbox{" "}
          <select value={sandbox} onChange={(event) => setSandbox(event.target.value)}>
            <option value="read-only">Read only</option>
            <option value="workspace-write">Allow workspace writes</option>
          </select>
        </label>{" "}
        <button
          disabled={busy}
          onClick={() => {
            void run(() => selectThread("thread/start"));
          }}
        >
          Start session
        </button>
        <p>
          <label>
            Saved session{" "}
            <select
              disabled={busy}
              value={threadId}
              onChange={(event) => {
                setThreadId(event.target.value);
                setTranscript(null);
              }}
            >
              <option value="">Choose a session</option>
              {threadId && !threads.some((item) => item.id === threadId) ? (
                <option value={threadId}>{threadId}</option>
              ) : null}
              {threads.map((item) => (
                <option key={string(item.id)} value={string(item.id)}>
                  {string(item.preview) || string(item.id)}
                </option>
              ))}
            </select>
          </label>{" "}
          <label>
            <input
              type="checkbox"
              checked={archived}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.checked;
                setArchived(value);
                setThreadId("");
                setTranscript(null);
                void run(() => loadSessions(value));
              }}
            />{" "}
            Browse archived sessions
          </label>{" "}
          {nextCursor ? (
            <button
              disabled={busy}
              onClick={() => {
                void run(() => loadSessions(archived, nextCursor));
              }}
            >
              Load more sessions
            </button>
          ) : null}{" "}
          <button
            disabled={busy || archived || !threadId}
            onClick={() => {
              void run(() => selectThread("thread/resume"));
            }}
          >
            Resume
          </button>{" "}
          <button
            disabled={busy || !threadId}
            onClick={() => {
              void run(async () => {
                const result = await action("thread/read", { threadId });
                restoreTurn(record(record(result).thread));
                setTranscript(result);
              });
            }}
          >
            Read transcript
          </button>{" "}
          <button
            disabled={busy || archived || !threadId || progress.active}
            onClick={() => {
              void run(async () => {
                await action("thread/resume", { threadId, sandbox, ...(model ? { model } : {}) });
                await action("thread/compact/start", { threadId });
                setHistoryNotice(
                  "Context compaction requested. Follow native agent events for completion.",
                );
              });
            }}
          >
            Compact context
          </button>{" "}
          <button
            disabled={busy || !threadId || progress.active}
            onClick={() => {
              void run(async () => {
                if (!archived)
                  await action("thread/resume", { threadId, sandbox, ...(model ? { model } : {}) });
                await action(archived ? "thread/unarchive" : "thread/archive", { threadId });
                setThreadId("");
                setTranscript(null);
                await loadSessions(archived);
              });
            }}
          >
            {archived ? "Restore session" : "Archive session"}
          </button>
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await action("thread/resume", { threadId, sandbox, ...(model ? { model } : {}) });
              const result = record(
                await action("turn/start", {
                  threadId,
                  sandbox,
                  text: prompt,
                  ...(model ? { model } : {}),
                }),
              );
              const turn = record(result.turn);
              setTurns((previous) => ({
                ...previous,
                [threadId]: { id: string(turn.id), status: string(turn.status) || "inProgress" },
              }));
              setPrompt("");
            });
          }}
        >
          <label htmlFor="codex-prompt">Task for this session</label>
          <br />
          <textarea
            id="codex-prompt"
            rows={5}
            style={{ width: "100%" }}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            required
          />
          <p role="status">{progress.label}</p>
          <button disabled={busy || archived || progress.active || !threadId || !prompt.trim()}>
            Send task
          </button>{" "}
          <button
            type="button"
            disabled={busy || !threadId || !progress.active}
            onClick={() => {
              void run(async () => {
                setTurns((previous) => ({
                  ...previous,
                  [threadId]: { id: turnId, status: "interruptRequested" },
                }));
                try {
                  await action("turn/interrupt", { threadId, turnId });
                } catch (cause) {
                  setTurns((previous) =>
                    previous[threadId]?.id === turnId &&
                    previous[threadId]?.status === "interruptRequested"
                      ? { ...previous, [threadId]: { id: turnId, status: "inProgress" } }
                      : previous,
                  );
                  throw cause;
                }
              });
            }}
          >
            Interrupt turn
          </button>
        </form>
        {transcript !== null ? (
          <details open>
            <summary>Saved transcript</summary>
            <pre style={preStyle}>{pretty(transcript)}</pre>
          </details>
        ) : null}
      </section>
      <section className="panel" aria-label="Codex approvals">
        <h2 className="panelTitle">Pending approvals</h2>
        {!status?.pendingApprovals.length ? (
          <p>No pending approvals.</p>
        ) : (
          status.pendingApprovals.map((approval) => (
            <div className="card" key={`${status.scopeGeneration}:${String(approval.id)}`}>
              <p>{approval.method}</p>
              <p>
                Session:{" "}
                <code>{string(record(approval.params).threadId) || "Not specified by Codex"}</code>
                {record(approval.params).threadId === threadId
                  ? " (selected session)"
                  : " (review this session context before responding)"}
              </p>
              {approval.method === "item/tool/requestUserInput" ||
              approval.method === "mcpServer/elicitation/request" ? (
                <CodexRequest
                  request={approval}
                  disabled={responding !== null}
                  respond={async (name, params) => {
                    if (responding !== null) return;
                    setResponding(approval.id);
                    setError("");
                    try {
                      await action(name, params);
                      setStatus((previous) =>
                        previous
                          ? {
                              ...previous,
                              pendingApprovals: previous.pendingApprovals.filter(
                                (item) => item.id !== approval.id,
                              ),
                            }
                          : previous,
                      );
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : "Response failed.");
                    } finally {
                      setResponding(null);
                    }
                  }}
                />
              ) : (
                <>
                  <pre style={preStyle}>{pretty(approval.params)}</pre>
                  <button
                    disabled={responding !== null}
                    onClick={() => {
                      void respond(approval, "accept");
                    }}
                  >
                    Approve once
                  </button>{" "}
                  <button
                    disabled={responding !== null}
                    onClick={() => {
                      void respond(approval, "decline");
                    }}
                  >
                    Decline
                  </button>
                </>
              )}
            </div>
          ))
        )}
      </section>
      <section className="panel" aria-label="Codex live events">
        <h2 className="panelTitle">Live agent events</h2>
        <p className="muted">
          Polled every 1.5 seconds; latest 200 events. Events may include generated text and tool
          output.
        </p>
        {historyNotice ? <p role="status">{historyNotice}</p> : null}
        {events.length ? (
          events.map((event) => (
            <details key={event.sequence} open={event.method.includes("delta")}>
              <summary>
                {event.sequence}: {eventView(event).title}
              </summary>
              {eventView(event).text ? <pre style={preStyle}>{eventView(event).text}</pre> : null}
              <details>
                <summary>Native protocol details</summary>
                <pre style={preStyle}>{pretty(event.params)}</pre>
              </details>
            </details>
          ))
        ) : (
          <p>Waiting for Codex events.</p>
        )}
      </section>
    </>
  );
}
