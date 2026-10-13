"use client";

import "./coding-workspace.css";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { workspaceRequest } from "../../lib/workspace-client";
import {
  agentRuns,
  agentEvents,
  agentEventLabel,
  mutationApprovals,
  type AgentRun,
} from "./agent-view";
import { ChatGraphPanel } from "./chat-graph-panel";
import { useAppNavigation } from "../app-shell";
import { CHAT_TOOL_OPTIONS, chatTaskOptions, useChatPreferences } from "./chat-preferences";
import {
  composerShortcutHint,
  shouldSubmitComposer,
  useConfirmBeforeClose,
  useGeneralPreferences,
} from "./general-preferences";
import { notificationApprovals, useAgentNotifications } from "./agent-notifications";
import { ChatMessages } from "./chat-messages";
import { TerminalDock } from "./terminal-dock";
import { ChatExportLink } from "./chat-export-link";
import { sessionTranscript, type SessionTranscript } from "./session-transcript";
import { MutationApprovalCard } from "./mutation-approval";
import { ApprovalCards } from "../runs/[id]/approval-cards";
import { Icon } from "../ui/workspace-icon";
import { ResizeHandle, usePanelWidth } from "../ui/resize-handle";

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

const desktopQuery = "(min-width: 1100px)";
function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(desktopQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const desktopSnapshot = () => window.matchMedia(desktopQuery).matches;
const desktopServerSnapshot = () => true;

export function canSubmitTask({
  busy,
  archived,
  active,
  sessionId,
  modelId,
  prompt,
}: {
  busy: boolean;
  archived: boolean;
  active: boolean;
  sessionId: string;
  modelId: string;
  prompt: string;
}): boolean {
  return !busy && !archived && !active && Boolean(sessionId && modelId && prompt.trim());
}

export function modelContextHint(model: Value | undefined): string {
  const tokens = model?.contextWindowTokens;
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0
    ? `Context window: ${tokens.toLocaleString("en-US")} tokens. Usage is unavailable.`
    : "Context window usage is unavailable.";
}

export function availableModelId(models: readonly Value[], selection: string): string {
  return selection && models.some((model) => text(model.id) === selection) ? selection : "";
}

export function AgentWorkspace({ initialSessionId = "" }: { initialSessionId?: string }) {
  const generalPreferences = useGeneralPreferences();
  const [graphChoice, setGraphOpen] = useState<boolean | null>(null);
  const desktop = useSyncExternalStore(subscribeDesktop, desktopSnapshot, desktopServerSnapshot);
  const graphOpen = graphChoice ?? (desktop && generalPreferences.openSidePanelByDefault);
  const [inspectorTab, setInspectorTab] = useState<"graph" | "activity" | "terminal">("graph");
  const [inspectorWidth, setInspectorWidth] = usePanelWidth(
    "zet:chat-inspector-width",
    380,
    280,
    720,
  );
  const main = useRef<HTMLDivElement>(null);
  const [mainWidth, setMainWidth] = useState(0);
  // Reserve 360px for the conversation and 10px for its resize handle.
  const inspectorMax = Math.max(280, Math.min(720, mainWidth ? mainWidth - 370 : 720));
  const displayedInspectorWidth = Math.min(inspectorWidth, inspectorMax);
  const inspectorModal = graphOpen && !desktop;
  const inspector = useRef<HTMLElement>(null);
  const inspectorBackdrop = useRef<HTMLButtonElement>(null);
  const chatActions = useRef<HTMLDetailsElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const container = main.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setMainWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!inspectorModal) return;
    const panel = inspector.current;
    if (!panel) return;
    const trigger = inspectorToggle.current;
    const background: { element: HTMLElement; inert: boolean }[] = [];
    // Isolate all background branches, including the surrounding app navigation.
    for (
      let branch: HTMLElement | null = panel;
      branch?.parentElement && branch !== document.body;
      branch = branch.parentElement
    ) {
      for (const sibling of branch.parentElement.children) {
        if (
          !(sibling instanceof HTMLElement) ||
          sibling === branch ||
          sibling === inspectorBackdrop.current
        )
          continue;
        background.push({ element: sibling, inert: sibling.inert });
        sibling.inert = true;
      }
    }
    panel.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    return () => {
      for (const { element, inert } of background) element.inert = inert;
      if (panel.isConnected && panel.hidden)
        queueMicrotask(() => {
          if (trigger?.isConnected) trigger.focus({ preventScroll: true });
        });
    };
  }, [inspectorModal]);
  const closeInspector = () => {
    setGraphOpen(false);
    if (desktop) inspectorToggle.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !chatActions.current?.contains(event.target))
        chatActions.current?.removeAttribute("open");
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && chatActions.current?.open) {
        chatActions.current.open = false;
        chatActions.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  const { sessions, refreshSessions } = useAppNavigation();
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [models, setModels] = useState<Value[]>([]);
  const [modelChoice, setModelId] = useState("");
  // Validate during render so a catalogue refresh immediately gates every submit path.
  const modelId = availableModelId(models, modelChoice);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [previousPanelSession, setPreviousPanelSession] = useState(sessionId);
  if (previousPanelSession !== sessionId) {
    setPreviousPanelSession(sessionId);
    setGraphOpen(null);
  }
  const preferences = useChatPreferences();
  const [loadedTranscript, setLoadedTranscript] = useState<SessionTranscript | null>(null);
  const transcript = sessionTranscript(loadedTranscript, sessionId);
  const archived = object(object(transcript).session).status === "archived";
  const [prompt, setPrompt] = useState("");
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
  useConfirmBeforeClose({
    enabled: generalPreferences.confirmBeforeClose,
    prompt,
    active: Object.values(runs).some((run) => !terminal.has(run.status)),
  });
  useAgentNotifications(
    {
      scopeKey: String(snapshot?.scopeGeneration),
      ready: snapshot !== null,
      runs,
      approvals: notificationApprovals(snapshot?.toolApprovals, snapshot?.pendingApprovals, runs),
    },
    generalPreferences,
  );

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
          setModelId("");
          setSessionId("");
          setLoadedTranscript(null);
          setPrompt("");
          setRuns({});
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
  }, [setSessionId]);

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
      if (result.ok) setLoadedTranscript({ sessionId, value: result.data.result });
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
    if (!sessionId) return;
    let stale = false;
    void action("session/read", { sessionId })
      .then((result) => {
        if (!stale) setLoadedTranscript({ sessionId, value: result });
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

  async function loadSession(name: "session/resume" | "session/read") {
    const result = object(await action(name, { sessionId }));
    const session = object(result.session);
    const id = text(session.id);
    if (id) setSessionId(id);
    setLoadedTranscript({ sessionId: id || sessionId, value: result });
    const runId = text(session.lastRunId) || text(session.runId);
    if (id && runId)
      setRuns((previous) => ({
        ...previous,
        [id]: { id: runId, status: text(session.status) || "pending" },
      }));
  }

  // Load the selectors on entry and after a workspace switch. Never carry a
  // response across workspace generations, including a late OAuth/model refresh.
  const scopeGeneration = snapshot?.scopeGeneration;
  useEffect(() => {
    if (scopeGeneration === undefined) return;
    let disposed = false;
    const expected = generation.current;
    async function loadCatalog() {
      try {
        const modelResult = await action("model/list");
        if (disposed || generation.current !== expected) return;
        const modelData = object(modelResult).data;
        setModels((Array.isArray(modelData) ? modelData : []).map(object));
      } catch (cause) {
        if (!disposed && generation.current === expected)
          setError(
            cause instanceof Error ? cause.message : "Models and chats could not be loaded.",
          );
      } finally {
        if (!disposed) setCatalogLoading(false);
      }
    }
    void loadCatalog();
    const onFocus = () => {
      void loadCatalog();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("zet:settings-closed", onFocus);
    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("zet:settings-closed", onFocus);
    };
  }, [action, scopeGeneration]);

  useEffect(() => {
    function selectSession(event: Event) {
      const id: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof id !== "string" || !id) return;
      setSessionId(id);
      setLoadedTranscript(null);
    }
    window.addEventListener("zet:session-selected", selectSession);
    return () => window.removeEventListener("zet:session-selected", selectSession);
  }, [setSessionId]);
  useEffect(() => {
    function archivedSession(event: Event) {
      if ((event as CustomEvent<unknown>).detail !== sessionId) return;
      setSessionId("");
      setLoadedTranscript(null);
    }
    window.addEventListener("zet:session-archived", archivedSession);
    function deletedSession(event: Event) {
      const detail = object((event as CustomEvent<unknown>).detail);
      if (detail.sessionId !== sessionId) return;
      setSessionId("");
      setLoadedTranscript(null);
    }
    window.addEventListener("zet:session-deleted", deletedSession);
    return () => {
      window.removeEventListener("zet:session-archived", archivedSession);
      window.removeEventListener("zet:session-deleted", deletedSession);
    };
  }, [sessionId, setSessionId]);
  const [previousInitialSession, setPreviousInitialSession] = useState(initialSessionId);
  if (previousInitialSession !== initialSessionId) {
    setPreviousInitialSession(initialSessionId);
    setSessionId(initialSessionId);
    setLoadedTranscript(null);
  }

  const permissionsCount = CHAT_TOOL_OPTIONS.filter((option) => preferences[option]).length;
  const taskHint =
    currentRun && active
      ? `Task ${currentRun.status}.`
      : archived
        ? "Restore this chat to continue."
        : !sessionId
          ? "Create or choose a chat to begin."
          : !modelId
            ? "Choose a model to continue."
            : "Ready for your next task.";
  const events = agentEvents(snapshot?.events, currentRun?.id);
  return (
    <div className="codingShell">
      <div className="codingContent">
        <header className="codingHeader">
          <div className="codingHeaderTitle">
            <div>
              <h1>
                {sessions.find((session) => text(session.id) === sessionId)?.preview
                  ? text(sessions.find((session) => text(session.id) === sessionId)?.preview)
                  : "New chat"}
              </h1>
            </div>
          </div>
          <div className="codingHeaderActions">
            <span className="codingRuntimeState" role="status">
              <span data-ready={Boolean(snapshot && snapshot.available !== false && !pollError)} />
              {pollError
                ? "Connection issue"
                : !snapshot
                  ? "Connecting"
                  : snapshot.available === false
                    ? "Unavailable"
                    : active
                      ? "Working"
                      : "Ready"}
            </span>
            <details className="codingHistory" ref={chatActions}>
              <summary aria-label="Chat actions" title="Chat actions">
                <Icon name="more" />
              </summary>
              <div className="codingHistoryPanel">
                <h2>Chat actions</h2>
                {sessionId ? (
                  <div className="codingSessionActions">
                    <span>Current chat</span>
                    <ChatExportLink
                      sessionId={sessionId}
                      available={object(snapshot?.sessionFeatures).export === true}
                      busy={busy}
                    />
                    <button
                      disabled={busy || archived}
                      onClick={() => {
                        void run(() => loadSession("session/resume"));
                      }}
                    >
                      Resume
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        void run(() => loadSession("session/read"));
                      }}
                    >
                      Read transcript
                    </button>
                    <button
                      disabled={busy || active || archived}
                      onClick={() => {
                        void run(async () => {
                          await action("session/archive", {
                            sessionId,
                          });
                          setSessionId("");
                          setLoadedTranscript(null);
                          refreshSessions();
                        });
                      }}
                    >
                      Archive chat
                    </button>
                  </div>
                ) : null}
              </div>
            </details>
            <button
              ref={inspectorToggle}
              type="button"
              className="codingIconButton"
              aria-label={graphOpen ? "Hide side panel" : "Show side panel"}
              title={graphOpen ? "Hide side panel" : "Show graph, activity and terminal"}
              aria-expanded={graphOpen}
              aria-controls="coding-inspector"
              onClick={() => setGraphOpen(!graphOpen)}
            >
              <Icon name="panel-right" />
            </button>
          </div>
        </header>
        {error ? (
          <p role="alert" className="codingAlert">
            {error}
          </p>
        ) : null}
        {pollError && pollError !== error ? (
          <p role="alert" className="codingAlert">
            {pollError}
          </p>
        ) : null}
        <div
          ref={main}
          className={`codingMain${graphOpen ? " codingMain--graph" : ""}`}
          style={{ "--coding-inspector-width": `${displayedInspectorWidth}px` } as CSSProperties}
        >
          <section className="codingConversation" aria-label="Coding sessions">
            <div className="codingScroll">
              <ChatMessages transcript={transcript} />
              {currentRun?.status === "failed" ? (
                <div className="codingRunOutcome" role="alert">
                  <strong>This task failed.</strong>
                  <p>
                    The runtime stopped before completing the response. Your message is saved. Open
                    the run details to inspect the failed step before trying again.
                  </p>
                  <Link href={`/runs/${encodeURIComponent(currentRun.id)}`}>
                    Inspect failed run
                  </Link>
                </div>
              ) : currentRun?.status === "cancelled" || currentRun?.status === "interrupted" ? (
                <div className="codingRunOutcome" role="status">
                  <strong>
                    {currentRun.status === "cancelled" ? "Task cancelled." : "Task interrupted."}
                  </strong>
                  <p>Your conversation is saved. You can send a new task when ready.</p>
                </div>
              ) : null}
              {mutationApprovals(snapshot?.toolApprovals, sessionId, currentRun?.id).map(
                (request) => (
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
                ),
              )}
              {currentRun ? (
                <ApprovalCards
                  key={`${String(snapshot?.scopeGeneration)}:${currentRun.id}`}
                  runId={currentRun.id}
                  active={active}
                  describeOp={(index) => `Tool operation ${index}`}
                />
              ) : null}
            </div>
            <form
              className="codingComposer"
              onSubmit={(event) => {
                event.preventDefault();
                if (!canSubmitTask({ busy, archived, active, sessionId, modelId, prompt })) return;
                const taskOptions = chatTaskOptions(preferences);
                void run(async () => {
                  await action("session/resume", { sessionId });
                  const result = object(
                    await action("turn/start", {
                      sessionId,
                      text: prompt,
                      modelId,
                      ...taskOptions,
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
                });
              }}
            >
              <label className="codingSrOnly" htmlFor="coding-prompt">
                Do anything
              </label>
              <textarea
                id="coding-prompt"
                rows={2}
                placeholder="Do anything"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (shouldSubmitComposer(event.nativeEvent, generalPreferences.sendShortcut)) {
                    event.preventDefault();
                    if (canSubmitTask({ busy, archived, active, sessionId, modelId, prompt }))
                      event.currentTarget.form?.requestSubmit();
                  }
                }}
                aria-describedby="coding-composer-hint"
                required
              />
              <span id="coding-composer-hint" className="codingSrOnly">
                {composerShortcutHint(generalPreferences.sendShortcut)} {taskHint}
              </span>
              <div className="codingComposerTools">
                <span
                  className="codingApprovalStatus"
                  title={`${permissionsCount} next-task permissions selected. Actions still require approval.`}
                >
                  Ask for approval
                </span>

                <label
                  className="codingModelPicker"
                  title={modelContextHint(models.find((model) => text(model.id) === modelId))}
                >
                  <span className="codingSrOnly">Provider model</span>
                  <select
                    disabled={busy || active}
                    value={modelId}
                    onChange={(event) => setModelId(event.target.value)}
                  >
                    <option value="">
                      {catalogLoading ? "Loading models…" : "Choose a model"}
                    </option>
                    {models.map((model) => (
                      <option key={text(model.id)} value={text(model.id)}>
                        {text(model.displayName) || text(model.id)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="codingSendActions">
                  {active ? (
                    <button
                      className="codingSend codingStop"
                      type="button"
                      aria-label="Stop task"
                      title="Stop task"
                      disabled={busy || !currentRun}
                      onClick={() => {
                        void run(async () => {
                          await action("turn/interrupt", { sessionId, turnId: currentRun?.id });
                        });
                      }}
                    >
                      <Icon name="stop" size={18} />
                    </button>
                  ) : (
                    <button
                      className="codingSend"
                      type="submit"
                      aria-label={busy ? "Working" : "Send task"}
                      title={taskHint}
                      disabled={
                        !canSubmitTask({ busy, archived, active, sessionId, modelId, prompt })
                      }
                    >
                      <Icon name="arrow-up" size={20} />
                    </button>
                  )}
                </div>
              </div>
            </form>
          </section>
          {graphOpen && desktop ? (
            <ResizeHandle
              label="Resize side panel"
              controls="coding-inspector"
              value={displayedInspectorWidth}
              min={280}
              max={inspectorMax}
              defaultValue={380}
              onChange={setInspectorWidth}
              side="right"
              className="codingInspectorResize"
            />
          ) : null}
          {inspectorModal ? (
            <button
              ref={inspectorBackdrop}
              type="button"
              tabIndex={-1}
              className="codingInspectorBackdrop"
              aria-label="Close side panel"
              onClick={closeInspector}
            />
          ) : null}
          <aside
            ref={inspector}
            id="coding-inspector"
            className="codingInspector"
            hidden={!graphOpen}
            aria-label="Chat side panel"
            role={desktop ? undefined : "dialog"}
            aria-modal={desktop ? undefined : true}
            onKeyDown={(event) => {
              if (event.defaultPrevented) return;
              if (
                event.key === "Escape" &&
                !(event.target instanceof HTMLSelectElement) &&
                !(event.target instanceof Element && event.target.closest(".terminalEmulator"))
              ) {
                event.preventDefault();
                closeInspector();
                return;
              }
              if (desktop || event.key !== "Tab") return;
              const focusable = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]',
                ),
              ).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <header className="codingInspectorHeader">
              <div className="codingInspectorTabs" role="tablist" aria-label="Chat details">
                {(["graph", "activity", "terminal"] as const).map((tab, index, tabs) => (
                  <button
                    key={tab}
                    id={`coding-${tab}-tab`}
                    type="button"
                    role="tab"
                    aria-selected={inspectorTab === tab}
                    aria-controls={`coding-${tab}`}
                    tabIndex={inspectorTab === tab ? 0 : -1}
                    onClick={() => setInspectorTab(tab)}
                    onKeyDown={(event) => {
                      const next =
                        event.key === "ArrowRight"
                          ? tabs[(index + 1) % tabs.length]
                          : event.key === "ArrowLeft"
                            ? tabs[(index + tabs.length - 1) % tabs.length]
                            : event.key === "Home"
                              ? tabs[0]
                              : event.key === "End"
                                ? tabs[tabs.length - 1]
                                : undefined;
                      if (!next) return;
                      event.preventDefault();
                      setInspectorTab(next);
                      document.getElementById(`coding-${next}-tab`)?.focus();
                    }}
                  >
                    <Icon name={tab} size={15} />
                    <span>{tab.charAt(0).toUpperCase() + tab.slice(1)}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="codingIconButton"
                aria-label="Close side panel"
                title="Close side panel"
                onClick={closeInspector}
              >
                <Icon name="x" size={16} />
              </button>
            </header>
            <div
              id="coding-graph"
              className="codingGraph codingInspectorPanel"
              role="tabpanel"
              aria-labelledby="coding-graph-tab"
              tabIndex={0}
              hidden={inspectorTab !== "graph"}
            >
              {sessionId ? (
                <ChatGraphPanel
                  key={`${String(snapshot?.scopeGeneration)}:${sessionId}`}
                  sessionId={sessionId}
                  revision={currentRun?.id ? `${currentRun.id}:${currentRun.status}` : ""}
                  action={action}
                />
              ) : (
                <div className="codingInspectorEmpty">
                  <Icon name="graph" size={28} />
                  <h2>Keep your workflow in view</h2>
                  <p>Start or select a chat to see its connected graph.</p>
                  <Link href="/editor">
                    <Icon name="external-link" size={14} /> Open graph editor
                  </Link>
                </div>
              )}
            </div>
            <div
              id="coding-activity"
              className="codingInspectorPanel codingActivity"
              role="tabpanel"
              aria-labelledby="coding-activity-tab"
              tabIndex={0}
              hidden={inspectorTab !== "activity"}
            >
              {currentRun ? (
                <>
                  <div className="codingActivityHeading">
                    <h2>Task activity</h2>
                    <span>{currentRun.status}</span>
                  </div>
                  <p>Model output, tool calls and approvals for this task.</p>
                  <Link
                    className="codingInspectorLink"
                    href={`/runs/${encodeURIComponent(currentRun.id)}`}
                  >
                    <Icon name="external-link" size={14} /> Open run details
                  </Link>
                  {events.length ? (
                    <div className="codingActivityEvents">
                      {events.map((event) => (
                        <details key={event.sequence}>
                          <summary>{agentEventLabel(event)}</summary>
                          <pre style={preStyle}>{pretty(event.params)}</pre>
                        </details>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">No task events yet.</p>
                  )}
                </>
              ) : (
                <div className="codingInspectorEmpty">
                  <Icon name="activity" size={28} />
                  <h2>Your task, step by step</h2>
                  <p>Activity appears here when you send a task.</p>
                </div>
              )}
            </div>
            <div
              id="coding-terminal"
              className="codingInspectorPanel codingTerminalPanel"
              role="tabpanel"
              aria-labelledby="coding-terminal-tab"
              tabIndex={0}
              hidden={inspectorTab !== "terminal"}
            >
              <TerminalDock
                key={sessionId}
                conversationId={sessionId}
                embedded
                visible={graphOpen && inspectorTab === "terminal"}
              />
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
