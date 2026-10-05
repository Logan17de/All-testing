"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceRequest } from "../../lib/workspace-client";
import {
  agentRuns,
  agentEvents,
  agentEventLabel,
  mutationApprovals,
  type AgentRun,
} from "./agent-view";
import { ChatGraphPanel } from "./chat-graph-panel";
import { ChatMessages } from "./chat-messages";
import { MutationApprovalCard } from "./mutation-approval";
import { ApprovalCards } from "../runs/[id]/approval-cards";

type Value = Record<string, unknown>;
const object = (value: unknown): Value =>
  value && typeof value === "object" ? (value as Value) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const preStyle = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  maxHeight: 420,
  overflow: "auto",
} as const;

export function AgentWorkspace({ initialSessionId = "" }: { initialSessionId?: string }) {
  const [models, setModels] = useState<Value[]>([]);
  const [sessions, setSessions] = useState<Value[]>([]);
  const [modelId, setModelId] = useState("");
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [archived, setArchived] = useState(false);
  const [transcript, setTranscript] = useState<unknown>(null);
  const [prompt, setPrompt] = useState("");
  const [instructions, setInstructions] = useState("");
  const [mutationConsent, setMutationConsent] = useState(false);
  const [subagentsEnabled, setSubagentsEnabled] = useState(false);
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [desktopEnabled, setDesktopEnabled] = useState(false);
  const [runs, setRuns] = useState<Record<string, AgentRun>>({});
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<Value | null>(null);
  const generation = useRef<number | null>(null);
  const actionVersion = useRef(0);
  const currentRun = runs[sessionId];
  const runStatus = currentRun?.status;
  const active = currentRun !== undefined && !terminal.has(currentRun.status);

  const action = useCallback(async (name: string, params: Value = {}) => {
    const expected = generation.current;
    actionVersion.current++;
    const result = await workspaceRequest<{ result: unknown }>("agent", { action: name, params });
    actionVersion.current++;
    if (expected !== null && generation.current !== expected)
      throw new Error("The workspace changed. Select a session in the current workspace.");
    if (!result.ok) throw new Error(result.reason);
    return result.data.result;
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const expectedVersion = actionVersion.current;
      const result = await workspaceRequest<Value>("agent");
      if (disposed) return;
      if (result.ok && expectedVersion === actionVersion.current) {
        const next =
          typeof result.data.scopeGeneration === "number" ? result.data.scopeGeneration : 0;
        if (generation.current !== null && generation.current !== next) {
          setModels([]);
          setSessions([]);
          setModelId("");
          setSessionId("");
          setTranscript(null);
          setPrompt("");
          setInstructions("");
          setMutationConsent(false);
          setSubagentsEnabled(false);
          setSearchEnabled(false);
          setBrowserEnabled(false);
          setDesktopEnabled(false);
          setRuns({});
          setArchived(false);
          setError("");
        }
        generation.current = next;
        setRuns(agentRuns(result.data.activeTurns));
        setSnapshot(result.data);
        setPollError("");
      } else if (!result.ok) setPollError(result.reason);
      timer = setTimeout(() => {
        void poll();
      }, 1500);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!sessionId || !runStatus) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expected = generation.current;
    async function readProgress() {
      const result = await workspaceRequest<{ result: unknown }>("agent", {
        action: "session/read",
        params: { sessionId },
      });
      if (disposed || generation.current !== expected) return;
      if (result.ok) setTranscript(result.data.result);
      else setPollError(result.reason);
      if (runStatus && !terminal.has(runStatus))
        timer = setTimeout(() => {
          void readProgress();
        }, 2000);
    }
    void readProgress();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, currentRun?.id, runStatus]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (sessionId) url.searchParams.set("session", sessionId);
    else url.searchParams.delete("session");
    window.history.replaceState(null, "", url);
    if (!sessionId) return;
    let stale = false;
    void action("session/read", { sessionId })
      .then((result) => {
        if (!stale) setTranscript(result);
      })
      .catch((cause) => {
        if (!stale) setError(cause instanceof Error ? cause.message : "Chat could not be loaded.");
      });
    return () => {
      stale = true;
    };
  }, [action, sessionId]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Coding request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function loadSessions(showArchived: boolean) {
    const result = object(await action("session/list", { archived: showArchived }));
    setSessions((Array.isArray(result.data) ? result.data : []).map(object));
  }

  async function refresh() {
    const [modelResult] = await Promise.all([action("model/list"), loadSessions(archived)]);
    const data = object(modelResult).data;
    setModels((Array.isArray(data) ? data : []).map(object));
  }

  async function loadSession(name: "session/start" | "session/resume" | "session/read") {
    const result = object(await action(name, name === "session/start" ? {} : { sessionId }));
    const session = object(result.session);
    const id = text(session.id);
    if (id) setSessionId(id);
    if (name === "session/start") {
      setArchived(false);
      await loadSessions(false);
    }
    const runId = text(session.lastRunId) || text(session.runId);
    if (id && runId)
      setRuns((previous) => ({
        ...previous,
        [id]: { id: runId, status: text(session.status) || "pending" },
      }));
    setTranscript(result);
  }

  return (
    <>
      <details className="panel" aria-label="Coding runtime">
        <summary>Runtime and provider models</summary>
        <p role="status">
          {snapshot
            ? snapshot.available === false
              ? "The coding runtime is unavailable."
              : "Harness runtime is ready."
            : "Checking runtime…"}
        </p>
        <button
          disabled={busy}
          onClick={() => {
            void run(refresh);
          }}
        >
          Refresh models and sessions
        </button>
        <p className="muted">
          <Link href="/models">Manage provider models and credentials</Link>. This workspace uses
          configured provider inference and the harness agent loop.
        </p>
      </details>
      {error ? (
        <p role="alert" className="panel panel--warn">
          {error}
        </p>
      ) : null}
      {pollError ? (
        <p role="alert" className="panel panel--warn">
          {pollError}
        </p>
      ) : null}
      <div className="chatWorkspace">
        <section className="panel chatWorkspaceMain" aria-label="Coding sessions">
          <h2 className="panelTitle">Chat</h2>
          <label>
            Provider model{" "}
            <select
              disabled={busy}
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            >
              <option value="">Choose a configured model</option>
              {models.map((model) => (
                <option key={text(model.id)} value={text(model.id)}>
                  {text(model.displayName) || text(model.id)}
                  {text(model.provider) ? ` (${text(model.provider)})` : ""}
                </option>
              ))}
            </select>
          </label>{" "}
          <button
            disabled={busy}
            onClick={() => {
              void run(() => loadSession("session/start"));
            }}
          >
            New chat
          </button>
          <p>
            <label>
              Saved chat{" "}
              <select
                disabled={busy}
                value={sessionId}
                onChange={(event) => {
                  setSessionId(event.target.value);
                  setTranscript(null);
                }}
              >
                <option value="">Choose a session</option>
                {sessionId && !sessions.some((session) => session.id === sessionId) ? (
                  <option value={sessionId}>{sessionId}</option>
                ) : null}
                {sessions.map((session) => (
                  <option key={text(session.id)} value={text(session.id)}>
                    {text(session.preview) || text(session.id)}
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
                  setSessionId("");
                  setTranscript(null);
                  void run(() => loadSessions(value));
                }}
              />{" "}
              Browse archived sessions
            </label>{" "}
            <button
              disabled={busy || archived || !sessionId}
              onClick={() => {
                void run(() => loadSession("session/resume"));
              }}
            >
              Resume
            </button>{" "}
            <button
              disabled={busy || !sessionId}
              onClick={() => {
                void run(() => loadSession("session/read"));
              }}
            >
              Read transcript
            </button>{" "}
            <button
              disabled={busy || !sessionId || active}
              onClick={() => {
                void run(async () => {
                  await action(archived ? "session/restore" : "session/archive", { sessionId });
                  setSessionId("");
                  setTranscript(null);
                  await loadSessions(archived);
                });
              }}
            >
              {archived ? "Restore session" : "Archive session"}
            </button>
          </p>
          <ChatMessages transcript={transcript} />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await action("session/resume", { sessionId });
                const result = object(
                  await action("turn/start", {
                    sessionId,
                    text: prompt,
                    modelId,
                    mutationConsent,
                    subagentsEnabled,
                    searchEnabled,
                    browserEnabled,
                    desktopEnabled,
                    ...(instructions.trim() ? { instructions } : {}),
                  }),
                );
                const turn = object(result.turn);
                const id = text(turn.id);
                if (!id) throw new Error("The runtime did not return a task ID.");
                setRuns((previous) => ({
                  ...previous,
                  [sessionId]: { id, status: text(turn.status) || "pending" },
                }));
                setPrompt("");
                setMutationConsent(false);
                setSubagentsEnabled(false);
                setSearchEnabled(false);
                setBrowserEnabled(false);
                setDesktopEnabled(false);
              });
            }}
          >
            <details>
              <summary>Task instructions (optional)</summary>
              <label htmlFor="coding-instructions">Session instructions (optional)</label>
              <br />
              <textarea
                id="coding-instructions"
                rows={2}
                style={{ width: "100%" }}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
            </details>
            <label htmlFor="coding-prompt">Coding task</label>
            <br />
            <textarea
              id="coding-prompt"
              rows={5}
              style={{ width: "100%" }}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              required
            />
            <p>
              <label>
                <input
                  type="checkbox"
                  disabled={busy || active}
                  checked={mutationConsent}
                  onChange={(event) => setMutationConsent(event.target.checked)}
                />{" "}
                Allow workspace mutation requests for the next task. Each requested action still
                needs separate approval.
              </label>
            </p>
            <p>
              <label>
                <input
                  type="checkbox"
                  disabled={busy || active}
                  checked={subagentsEnabled}
                  onChange={(event) => setSubagentsEnabled(event.target.checked)}
                />{" "}
                Allow bounded read-only subagents for the next task (additional model inference).
              </label>
            </p>
            <p>
              <label>
                <input
                  type="checkbox"
                  disabled={busy || active}
                  checked={searchEnabled}
                  onChange={(event) => setSearchEnabled(event.target.checked)}
                />{" "}
                Allow Codex web research for the next task (requires a connected account and
                configured search model).
              </label>
              <br />
              <small>
                Only search queries and findings are exchanged. This research helper receives no
                coding, filesystem or shell permissions.
              </small>
            </p>
            <p>
              <label>
                <input
                  type="checkbox"
                  disabled={busy || active}
                  checked={browserEnabled}
                  onChange={(event) => setBrowserEnabled(event.target.checked)}
                />{" "}
                Allow tools from an explicitly armed isolated browser session for the next task.
                Every browser input still needs approval.
              </label>
            </p>
            <p>
              <label>
                <input
                  type="checkbox"
                  disabled={busy || active}
                  checked={desktopEnabled}
                  onChange={(event) => setDesktopEnabled(event.target.checked)}
                />{" "}
                Allow native desktop tools for the next task using a separately armed local desktop
                session. Each input requires exact approval; screenshot sharing requires approval of
                the destination model, chat, current turn and reuse limit.
              </label>
            </p>
            <p>
              <Link
                href={
                  currentRun ? `/desktop?task=${encodeURIComponent(currentRun.id)}` : "/desktop"
                }
              >
                Open a separate local desktop session
              </Link>
              . Desktop capture and input are disabled until explicitly armed and are not enabled by
              this browser checkbox.
            </p>
            <p role="status">
              {currentRun ? `Task ${currentRun.status}.` : "Ready for a task."}
              {currentRun ? (
                <>
                  {" "}
                  <Link href={`/runs/${encodeURIComponent(currentRun.id)}`}>
                    Run details and live tool progress
                  </Link>
                </>
              ) : null}
            </p>
            <button
              disabled={busy || archived || active || !sessionId || !modelId || !prompt.trim()}
            >
              Send task
            </button>{" "}
            <button
              type="button"
              disabled={busy || !active || !currentRun}
              onClick={() => {
                void run(async () => {
                  await action("turn/interrupt", { sessionId, turnId: currentRun?.id });
                });
              }}
            >
              Cancel task
            </button>
          </form>
        </section>
        {sessionId ? (
          <ChatGraphPanel
            key={`${String(snapshot?.scopeGeneration)}:${sessionId}`}
            sessionId={sessionId}
            revision={currentRun?.id ? `${currentRun.id}:${currentRun.status}` : ""}
            action={action}
          />
        ) : (
          <aside className="panel">
            <h2 className="panelTitle">Connected graph</h2>
            <p>Select or start a chat to view its graph connection.</p>
          </aside>
        )}
      </div>
      {mutationApprovals(snapshot?.toolApprovals, sessionId, currentRun?.id).map((request) => (
        <MutationApprovalCard
          key={`${String(snapshot?.scopeGeneration)}:${request.requestGeneration}:${request.id}`}
          request={request}
          respond={async (decision) => {
            await action("tool-approval/respond", {
              id: request.id,
              decision,
              requestGeneration: request.requestGeneration,
            });
          }}
        />
      ))}
      {currentRun ? (
        <ApprovalCards
          key={`${String(snapshot?.scopeGeneration)}:${currentRun.id}`}
          runId={currentRun.id}
          active={active}
          describeOp={(index) => `Tool operation ${index}`}
        />
      ) : null}
      <section className="panel" aria-label="Task events">
        <h2 className="panelTitle">Live agent progress</h2>
        <p>
          Recent runtime events refresh every 1.5 seconds. Tool calls, model output, approvals and
          errors are available in the{" "}
          <Link href={currentRun ? `/runs/${encodeURIComponent(currentRun.id)}` : "/runs"}>
            run inspector
          </Link>
          .
        </p>
        {agentEvents(snapshot?.events, currentRun?.id).length ? (
          agentEvents(snapshot?.events, currentRun?.id).map((event) => (
            <details key={event.sequence}>
              <summary>
                {event.sequence}: {agentEventLabel(event)}
              </summary>
              <pre style={preStyle}>{pretty(event.params)}</pre>
            </details>
          ))
        ) : (
          <p>Waiting for task events.</p>
        )}
      </section>
    </>
  );
}
