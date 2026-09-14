"use client";

import "@xyflow/react/dist/style.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type NodeChange,
} from "@xyflow/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  findManifest,
  parseGraphDocument,
  type GraphDataEdge,
  type GraphNode,
  type PaletteEntry,
} from "../../../lib/graph-document";
import { harnessNodeTypes, type HarnessFlowNode } from "../../harness-node";
import { ApprovalCards } from "./approval-cards";

interface RunNodeState {
  readonly opIndex: number;
  readonly nodeId: string;
  readonly type: string;
  readonly version: string;
  readonly status: string;
  readonly attemptsStarted: number;
}

interface RunAttempt {
  readonly opIndex: number;
  readonly attempt: number;
  readonly status: string;
  readonly outputs: unknown;
  readonly error: unknown;
  readonly usage: unknown;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
}

interface RunEvent {
  readonly eventId: number;
  readonly eventType: string;
  readonly opIndex: number | null;
  readonly attempt: number | null;
  readonly occurredAtMs: number;
}

interface RunView {
  readonly runId: string;
  readonly status: string;
  readonly graphId: string;
  readonly revisionId: string;
  readonly createdAtMs: number;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly graph: unknown;
  readonly nodes: readonly RunNodeState[];
  readonly attempts: readonly RunAttempt[];
  readonly timeline: readonly RunEvent[];
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
const POLL_MS = 1000;
const TIMELINE_LIMIT = 500;

const STATUS_TEXT: Readonly<Record<string, string>> = {
  pending: "Stored, not started yet",
  running: "Running",
  waiting: "Waiting for a decision",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function isRunView(value: unknown): value is RunView {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["runId"] === "string" &&
    typeof record["status"] === "string" &&
    Array.isArray(record["nodes"]) &&
    Array.isArray(record["attempts"]) &&
    Array.isArray(record["timeline"])
  );
}

function reasonOf(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { readonly error: unknown }).error;
    if (typeof error === "object" && error !== null && "reason" in error) {
      const reason = (error as { readonly reason: unknown }).reason;
      if (typeof reason === "string") return reason;
    }
  }
  return fallback;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "(not serializable)";
  }
}

function duration(start: number, end: number | null): string {
  if (end === null) return "in progress";
  const ms = Math.max(0, end - start);
  return ms < 1000 ? `${String(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export default function RunInspector({ runId }: { readonly runId: string }) {
  return (
    <ReactFlowProvider>
      <Inspector runId={runId} />
    </ReactFlowProvider>
  );
}

/**
 * Live view of one run.
 *
 * Node state is the runtime's durable frontier, polled until the run ends, so the
 * overlay shows what the runtime would resume from after a restart rather than a
 * guess made in the browser.
 */
function Inspector({ runId }: { readonly runId: string }) {
  const [run, setRun] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [palette, setPalette] = useState<readonly PaletteEntry[] | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // React Flow keeps a controlled node hidden until its measured size comes back
  // through onNodesChange, so a read-only canvas still has to record dimensions.
  const [measured, setMeasured] = useState<
    Readonly<Record<string, { readonly width: number; readonly height: number }>>
  >({});

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = (): void => {
      fetch(`/api/editor/runs/${encodeURIComponent(runId)}`, { cache: "no-store" })
        .then(async (response) => {
          const body = (await response.json()) as unknown;
          if (cancelled) return;
          if (!response.ok) {
            setError(reasonOf(body, "The run could not be loaded."));
            if (response.status !== 404) timer = window.setTimeout(poll, POLL_MS * 3);
            return;
          }
          const view =
            typeof body === "object" && body !== null && "run" in body
              ? (body as { readonly run: unknown }).run
              : undefined;
          if (!isRunView(view)) {
            setError("The runtime returned a run in an unexpected shape.");
            return;
          }
          setError(null);
          setRun(view);
          if (!TERMINAL.has(view.status)) timer = window.setTimeout(poll, POLL_MS);
        })
        .catch(() => {
          if (cancelled) return;
          setError("The runtime daemon is not reachable. Retrying…");
          timer = window.setTimeout(poll, POLL_MS * 3);
        });
    };
    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runId]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/editor/nodes", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as unknown;
        if (cancelled || !response.ok) return;
        const nodes =
          typeof body === "object" && body !== null && "nodes" in body
            ? (body as { readonly nodes: unknown }).nodes
            : [];
        setPalette(Array.isArray(nodes) ? (nodes as PaletteEntry[]) : []);
      })
      .catch(() => {
        // The palette only adds titles and permissions; the run view works without it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const graph = useMemo(() => (run === null ? undefined : parseGraphDocument(run.graph)), [run]);
  const stateByNode = useMemo(
    () => new Map((run?.nodes ?? []).map((state) => [state.nodeId, state])),
    [run],
  );
  const nodeByOp = useMemo(
    () => new Map((run?.nodes ?? []).map((state) => [state.opIndex, state.nodeId])),
    [run],
  );

  const flowNodes = useMemo<HarnessFlowNode[]>(
    () =>
      (graph?.nodes ?? []).map((node, index) => {
        const entry = findManifest(palette, node.type, node.version);
        const state = stateByNode.get(node.id);
        const size = measured[node.id];
        return {
          id: node.id,
          type: "harness",
          position: graph?.editor?.nodes?.[node.id]?.position ?? {
            x: 60 + (index % 4) * 240,
            y: 60 + Math.floor(index / 4) * 170,
          },
          selected: node.id === selectedNodeId,
          draggable: false,
          ...(size === undefined ? {} : { measured: size }),
          data: {
            title: entry?.manifest.title ?? node.type,
            type: `${node.type}@${node.version}`,
            inputs: Object.keys(entry?.manifest.inputs ?? {}),
            outputs: Object.keys(entry?.manifest.outputs ?? {}),
            diagnostics: [],
            isolated: entry?.isolated ?? false,
            readOnly: true,
            ...(state === undefined ? {} : { status: state.status }),
          },
        };
      }),
    [graph, palette, stateByNode, selectedNodeId, measured],
  );

  const onNodesChange = useCallback((changes: NodeChange<HarnessFlowNode>[]) => {
    const sizes: Record<string, { width: number; height: number }> = {};
    for (const change of changes) {
      if (change.type === "dimensions" && change.dimensions !== undefined) {
        sizes[change.id] = change.dimensions;
      }
    }
    if (Object.keys(sizes).length > 0) setMeasured((current) => ({ ...current, ...sizes }));
  }, []);

  const flowEdges = useMemo<Edge[]>(
    () =>
      (graph?.edges ?? [])
        .filter((edge): edge is GraphDataEdge => edge.kind === "data")
        .map((edge) => ({
          id: edge.id,
          source: edge.from.nodeId,
          sourceHandle: edge.from.port,
          target: edge.to.nodeId,
          targetHandle: edge.to.port,
          animated: stateByNode.get(edge.to.nodeId)?.status === "running",
        })),
    [graph, stateByNode],
  );

  if (run === null) {
    return (
      <div className="panel">
        {error === null ? (
          <p className="muted">Loading the run…</p>
        ) : (
          <p className="warn">{error}</p>
        )}
      </div>
    );
  }

  const active = !TERMINAL.has(run.status);
  const firstEventAt = run.timeline[0]?.occurredAtMs ?? run.createdAtMs;
  const selectedNode = graph?.nodes.find((node) => node.id === selectedNodeId);
  const selectedState = selectedNodeId === null ? undefined : stateByNode.get(selectedNodeId);

  return (
    <>
      <header className="runHeader">
        <h1 className="pageTitle runTitle">{run.graphId}</h1>
        <span className={`runStatus runStatus--${run.status}`}>{run.status}</span>
        <span className="runHeader__meta">
          {STATUS_TEXT[run.status] ?? run.status}
          {run.startedAtMs === null ? "" : ` · ${duration(run.startedAtMs, run.finishedAtMs)}`}
        </span>
        <Link className="btn" href="/editor">
          Open editor
        </Link>
      </header>
      {error === null ? null : (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      {run.status === "pending" ? (
        <p className="muted small">
          A run that stays pending has no executor: start the runtime with a plugins directory so
          enabled plugins can run its nodes.
        </p>
      ) : null}

      <div className="runLayout">
        <section className="canvas" aria-label="Run graph">
          {graph === undefined ? (
            <p className="muted">This run&apos;s graph could not be displayed.</p>
          ) : (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={harnessNodeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              onNodesChange={onNodesChange}
              onNodeClick={(_event, node) => {
                setSelectedNodeId(node.id);
              }}
              onPaneClick={() => {
                setSelectedNodeId(null);
              }}
              colorMode="dark"
              fitView
              fitViewOptions={{ maxZoom: 1 }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </section>

        <aside className="editorPanel" aria-label="Run details">
          <ApprovalCards
            runId={run.runId}
            active={active}
            describeOp={(opIndex) => nodeByOp.get(opIndex) ?? `op ${String(opIndex)}`}
          />
          {selectedNode === undefined ? (
            <Timeline
              events={run.timeline}
              startedAt={firstEventAt}
              nodeByOp={nodeByOp}
              onSelect={setSelectedNodeId}
            />
          ) : (
            <NodeDetails
              node={selectedNode}
              entry={findManifest(palette, selectedNode.type, selectedNode.version)}
              state={selectedState}
              attempts={
                selectedState === undefined
                  ? []
                  : run.attempts.filter((attempt) => attempt.opIndex === selectedState.opIndex)
              }
              events={
                selectedState === undefined
                  ? []
                  : run.timeline.filter((event) => event.opIndex === selectedState.opIndex)
              }
              startedAt={firstEventAt}
              onBack={() => {
                setSelectedNodeId(null);
              }}
            />
          )}
        </aside>
      </div>
    </>
  );
}

function Timeline({
  events,
  startedAt,
  nodeByOp,
  onSelect,
}: {
  readonly events: readonly RunEvent[];
  readonly startedAt: number;
  readonly nodeByOp: ReadonlyMap<number, string>;
  readonly onSelect: (nodeId: string) => void;
}) {
  return (
    <>
      <h2 className="panelTitle">Timeline</h2>
      {events.length === 0 ? (
        <p className="muted small">Nothing has happened yet.</p>
      ) : (
        <ol className="timeline">
          {events.map((event) => {
            const nodeId = event.opIndex === null ? undefined : nodeByOp.get(event.opIndex);
            const content = (
              <>
                <span className="timeline__time">+{String(event.occurredAtMs - startedAt)}ms</span>
                <span className="timeline__type">
                  {event.eventType}
                  {nodeId === undefined ? null : (
                    <span className="timeline__node">
                      {nodeId}
                      {event.attempt === null ? "" : ` · attempt ${String(event.attempt)}`}
                    </span>
                  )}
                </span>
              </>
            );
            return (
              <li key={event.eventId}>
                {nodeId === undefined ? (
                  <div className="timeline__row">{content}</div>
                ) : (
                  <button
                    type="button"
                    className="timeline__row"
                    onClick={() => {
                      onSelect(nodeId);
                    }}
                  >
                    {content}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {events.length >= TIMELINE_LIMIT ? (
        <p className="muted small">Showing the first {String(TIMELINE_LIMIT)} events.</p>
      ) : null}
      <p className="muted small">
        Select a node to inspect it. Event payloads are not shown here; values come from redacted
        attempt records.
      </p>
    </>
  );
}

function NodeDetails({
  node,
  entry,
  state,
  attempts,
  events,
  startedAt,
  onBack,
}: {
  readonly node: GraphNode;
  readonly entry: PaletteEntry | undefined;
  readonly state: RunNodeState | undefined;
  readonly attempts: readonly RunAttempt[];
  readonly events: readonly RunEvent[];
  readonly startedAt: number;
  readonly onBack: () => void;
}) {
  const manifest = entry?.manifest;
  return (
    <>
      <div className="btnRow">
        <button type="button" className="btn" onClick={onBack}>
          Back to timeline
        </button>
      </div>
      <h2 className="panelTitle">{manifest?.title ?? node.type}</h2>
      <p className="cardMeta">
        <code>{node.id}</code> · {node.type}@{node.version}
      </p>
      <p className="statusLine">
        <span className={`runStatus runStatus--${state?.status ?? "pending"}`}>
          {state?.status ?? "not scheduled"}
        </span>
        {state === undefined ? null : (
          <span className="muted small">
            {state.attemptsStarted === 1
              ? "1 attempt started"
              : `${String(state.attemptsStarted)} attempts started`}
          </span>
        )}
      </p>

      {manifest === undefined ? null : (
        <>
          <h3 className="sectionTitle">Permissions</h3>
          {manifest.behavior.requiredCapabilities.length === 0 ? (
            <p className="muted small">Needs no capabilities.</p>
          ) : (
            <div className="chips">
              {manifest.behavior.requiredCapabilities.map((capability) => (
                <span key={capability} className="chip">
                  {capability}
                </span>
              ))}
            </div>
          )}
          <p className="muted small">
            Effect: {manifest.behavior.effect} · idempotency: {manifest.behavior.idempotency} ·
            recovery: {manifest.behavior.recovery}
          </p>
        </>
      )}

      <h3 className="sectionTitle">Configuration</h3>
      <pre className="codeBlock">{pretty(node.config)}</pre>
      <h3 className="sectionTitle">Inputs</h3>
      <pre className="codeBlock">{pretty(node.bindings ?? [])}</pre>

      <h3 className="sectionTitle">Attempts and retries</h3>
      {attempts.length === 0 ? (
        <p className="muted small">No attempts yet.</p>
      ) : (
        attempts.map((attempt) => (
          <div key={attempt.attempt} className="attempt">
            <div className="attempt__head">
              <strong>Attempt {String(attempt.attempt)}</strong>
              <span className={`runStatus runStatus--${attempt.status}`}>{attempt.status}</span>
            </div>
            <p className="muted small">{duration(attempt.startedAtMs, attempt.finishedAtMs)}</p>
            {attempt.outputs === null ? null : (
              <>
                <h4 className="subTitle">Outputs</h4>
                <pre className="codeBlock">{pretty(attempt.outputs)}</pre>
              </>
            )}
            {attempt.error === null ? null : (
              <>
                <h4 className="subTitle">Error</h4>
                <pre className="codeBlock codeBlock--error">{pretty(attempt.error)}</pre>
              </>
            )}
            {attempt.usage === null ? null : (
              <>
                <h4 className="subTitle">Tokens and cost</h4>
                <pre className="codeBlock">{pretty(attempt.usage)}</pre>
              </>
            )}
          </div>
        ))
      )}

      <h3 className="sectionTitle">Events</h3>
      {events.length === 0 ? (
        <p className="muted small">None recorded.</p>
      ) : (
        <ul className="timeline">
          {events.map((event) => (
            <li key={event.eventId}>
              <div className="timeline__row">
                <span className="timeline__time">+{String(event.occurredAtMs - startedAt)}ms</span>
                <span className="timeline__type">{event.eventType}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        Model routes, tool calls, logs and artifacts are not recorded per node yet, so none are
        shown.
      </p>
    </>
  );
}
