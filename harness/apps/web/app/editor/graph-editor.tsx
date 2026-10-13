"use client";

import "@xyflow/react/dist/style.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";

import {
  addControlEdge,
  addDataEdge,
  addNode,
  controlHandleId,
  controlPortOf,
  controlPortsOf,
  emptyGraph,
  fedPorts,
  finalizeGraph,
  findManifest,
  freePosition,
  literalFor,
  NODE_FOOTPRINT,
  nextNodeId,
  parseGraphDocument,
  removeEdge,
  removeNode,
  semanticDocument,
  setConfigValue,
  setLiteral,
  setPosition,
  type EditorDiagnostic,
  type EditorPoint,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
  type JsonValue,
  type PaletteEntry,
} from "../../lib/graph-document";
import { OUTPUT_BOX_TYPE, TEXT_BOX_TYPE, orderPalette, textBoxValue } from "../../lib/boxes";
import { harnessNodeTypes, type HarnessFlowNode } from "../harness-node";
import { behaviourLabel, capabilityLabel, fieldLabel, pluginLabel } from "../../lib/plain-words";
import { workspaceRequest } from "../../lib/workspace-client";
import { SchemaField } from "./schema-field";
import { canRequestRun, currentValidation, type Validation } from "./editor-state";
import { Icon } from "../ui/workspace-icon";
import { ResizeHandle, usePanelWidth } from "../ui/resize-handle";
import { ConnectionBuilder, ConnectionList } from "./connection-panel";
import { connectionIssue } from "./connections";
import { useGraphHistory } from "./graph-history";

const DRAFT_KEY = "zet-harness.editor.draft.v1";
const DRAG_TYPE = "application/x-zet-harness-node";

function loadDraft(): GraphDocument {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (raw !== null) {
      const parsed = parseGraphDocument(JSON.parse(raw) as unknown);
      if (parsed !== undefined) return parsed;
    }
  } catch {
    // Storage can be unavailable (private windows, blocked site data); start fresh.
  }
  return emptyGraph(`graph-${crypto.randomUUID().slice(0, 8)}`);
}

function errorReason(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { readonly error: unknown }).error;
    if (typeof error === "object" && error !== null && "reason" in error) {
      const reason = (error as { readonly reason: unknown }).reason;
      if (typeof reason === "string") return reason;
    }
  }
  return fallback;
}

function diagnosticsOf(body: unknown): readonly EditorDiagnostic[] {
  if (typeof body !== "object" || body === null || !("diagnostics" in body)) return [];
  const list = (body as { readonly diagnostics: unknown }).diagnostics;
  return Array.isArray(list) ? (list as EditorDiagnostic[]) : [];
}

function withoutKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key));
}

function countLabel(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function validationText(validation: Validation, problems: number, shown: boolean): string {
  switch (validation) {
    case "idle":
      return "Add a node to start.";
    case "checking":
      return "Checking with the compiler…";
    case "valid":
      return "Ready to run.";
    case "invalid":
      // Until someone tries to run, a half-drawn graph is not a graph with mistakes
      // in it: it is a graph that is not finished. Saying so beats marking it wrong.
      if (!shown) return "Not ready to run yet.";
      return problems === 1 ? "1 problem to fix." : `${String(problems)} problems to fix.`;
    case "unreachable":
      return "Can't reach the runtime to check this graph.";
  }
}

export default function GraphEditor() {
  return (
    <ReactFlowProvider>
      <EditorWorkspace />
    </ReactFlowProvider>
  );
}

/**
 * The graph editor.
 *
 * The Graph JSON document is the only state that matters. React Flow's nodes
 * and edges are derived from it on every render, and every canvas gesture is
 * written back into the document, so what is saved, exported and run is always
 * plain Graph JSON rather than a React Flow persistence format.
 */
function EditorWorkspace() {
  const router = useRouter();
  const { screenToFlowPosition } = useReactFlow();
  const canvasRef = useRef<HTMLElement>(null);
  const connectionPanelRef = useRef<HTMLElement>(null);

  const [palette, setPalette] = useState<readonly PaletteEntry[] | null>(null);
  const [paletteError, setPaletteError] = useState<string | null>(null);
  const { graph, setGraph, undo, redo, canUndo, canRedo } = useGraphHistory(loadDraft);
  const [paletteWidth, setPaletteWidth] = usePanelWidth("zet.editor.palette-width", 208, 168, 360);
  const [inspectorWidth, setInspectorWidth] = usePanelWidth(
    "zet.editor.inspector-width",
    300,
    240,
    480,
  );
  const [paletteSearch, setPaletteSearch] = useState("");
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [feedback, setFeedback] = useState("Click or drag a node from the library to begin.");
  const [autosaveError, setAutosaveError] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [dragPositions, setDragPositions] = useState<Readonly<Record<string, EditorPoint>>>({});
  const [measured, setMeasured] = useState<
    Readonly<Record<string, { readonly width: number; readonly height: number }>>
  >({});
  const [diagnostics, setDiagnostics] = useState<readonly EditorDiagnostic[]>([]);
  // Problems are held back until someone asks to run; see `problemsShown` below.
  const [problemsRequested, setProblemsRequested] = useState(false);
  const [validation, setValidation] = useState<Validation>("idle");
  const [checkedBody, setCheckedBody] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);

  useEffect(() => {
    if (!connectionsOpen) return;
    connectionPanelRef.current?.querySelector("select")?.focus({ preventScroll: true });
    connectionPanelRef.current?.scrollIntoView({ block: "nearest" });
  }, [connectionsOpen]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/editor/nodes", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as unknown;
        if (cancelled) return;
        if (!response.ok) {
          setPaletteError(errorReason(body, "The node palette could not be loaded."));
          setPalette([]);
          return;
        }
        const nodes =
          typeof body === "object" && body !== null && "nodes" in body
            ? (body as { readonly nodes: unknown }).nodes
            : [];
        setPalette(Array.isArray(nodes) ? orderPalette(nodes as PaletteEntry[]) : []);
      })
      .catch(() => {
        if (cancelled) return;
        setPaletteError("The runtime daemon is not reachable, so no nodes are available.");
        setPalette([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A link from a conversation opens that conversation's workflow here.
  const graphNow = useRef(graph);
  useEffect(() => {
    graphNow.current = graph;
  }, [graph]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const workflow = params.get("workflow");
    if (workflow === null) return;
    const conversation = params.get("conversation") ?? "";
    let cancelled = false;
    void workspaceRequest<{ readonly graph: unknown }>(
      `workflows/${encodeURIComponent(workflow)}?conversationId=${encodeURIComponent(conversation)}`,
    ).then((result) => {
      if (cancelled) return;
      window.history.replaceState(null, "", window.location.pathname);
      if (!result.ok) {
        setRunError(result.reason);
        return;
      }
      const opened = parseGraphDocument(result.data.graph);
      if (opened === undefined) {
        setRunError("That workflow could not be opened.");
        return;
      }
      if (
        graphNow.current.nodes.length > 0 &&
        !window.confirm("Replace the graph you are editing with this workflow?")
      ) {
        return;
      }
      setGraph(opened);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setDragPositions({});
    });
    return () => {
      cancelled = true;
    };
  }, [setGraph]);

  useEffect(() => {
    let failed = false;
    let active = true;
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(graph));
    } catch {
      failed = true;
    }
    queueMicrotask(() => {
      if (active) setAutosaveError(failed);
    });
    return () => {
      active = false;
    };
  }, [graph]);

  // Only executable content is sent for checking. Moving a node changes layout,
  // not meaning, so it deliberately does not trigger another compile.
  const validationBody = useMemo(() => {
    if (palette === null || graph.nodes.length === 0) return null;
    const semantic = semanticDocument({
      graphId: graph.graphId,
      inputs: graph.inputs,
      nodes: graph.nodes,
      edges: graph.edges,
      policies: graph.policies,
    });
    return JSON.stringify({ graph: finalizeGraph(semantic, palette) });
  }, [graph.graphId, graph.inputs, graph.nodes, graph.edges, graph.policies, palette]);

  useEffect(() => {
    if (validationBody === null) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setValidation("checking");
      fetch("/api/editor/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: validationBody,
        signal: controller.signal,
      })
        .then(async (response) => {
          const body = (await response.json()) as unknown;
          if (controller.signal.aborted) return;
          setCheckedBody(validationBody);
          if (!response.ok) {
            setDiagnostics([]);
            setValidation("unreachable");
            return;
          }
          const valid =
            typeof body === "object" &&
            body !== null &&
            (body as { readonly valid?: unknown }).valid === true;
          setDiagnostics(diagnosticsOf(body));
          setValidation(valid ? "valid" : "invalid");
          // A graph that has become runnable has nothing to mark, and the next thing
          // built after it starts quiet again.
          if (valid) setProblemsRequested(false);
        })
        .catch((error: unknown) => {
          if (
            controller.signal.aborted ||
            (error instanceof DOMException && error.name === "AbortError")
          )
            return;
          setCheckedBody(validationBody);
          setDiagnostics([]);
          setValidation("unreachable");
        });
    }, 450);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [validationBody]);

  const empty = graph.nodes.length === 0;
  const shownValidation = currentValidation(empty, validationBody, checkedBody, validation);

  /**
   * Problems appear when someone tries to run, not while they are still drawing.
   *
   * A node dropped on the canvas has nothing wired to it yet, and a graph halfway
   * through being built is not a graph with mistakes in it. So the compiler keeps
   * checking in the background and the status line says whether the graph is ready,
   * but nothing is marked wrong until **Run graph** is pressed — and once a graph
   * becomes runnable again the marks clear, so the next thing built is quiet too.
   */
  const problemsShown = problemsRequested && shownValidation === "invalid";
  const shownDiagnostics = useMemo(
    () => (problemsShown ? diagnostics : []),
    [problemsShown, diagnostics],
  );

  const nodeProblems = useMemo(() => {
    const problems = new Map<string, EditorDiagnostic[]>();
    for (const diagnostic of shownDiagnostics) {
      if (diagnostic.nodeId === undefined) continue;
      problems.set(diagnostic.nodeId, [...(problems.get(diagnostic.nodeId) ?? []), diagnostic]);
    }
    return problems;
  }, [shownDiagnostics]);

  const edgeProblems = useMemo(() => {
    const problems = new Map<string, string>();
    for (const diagnostic of shownDiagnostics) {
      if (diagnostic.edgeId !== undefined && !problems.has(diagnostic.edgeId)) {
        problems.set(diagnostic.edgeId, diagnostic.message);
      }
    }
    return problems;
  }, [shownDiagnostics]);

  const flowNodes = useMemo<HarnessFlowNode[]>(
    () =>
      graph.nodes.map((node, index) => {
        const entry = findManifest(palette, node.type, node.version);
        const size = measured[node.id];
        return {
          id: node.id,
          type: "harness",
          position: dragPositions[node.id] ??
            graph.editor?.nodes?.[node.id]?.position ?? {
              x: 60 + (index % 4) * 240,
              y: 60 + Math.floor(index / 4) * 170,
            },
          selected: node.id === selectedNodeId,
          ...(size === undefined ? {} : { measured: size }),
          data: {
            title: entry?.manifest.title ?? node.type,
            type: `${node.type}@${node.version}`,
            ...(entry === undefined ? {} : { subtitle: pluginLabel(entry.pluginId) }),
            inputs: Object.keys(entry?.manifest.inputs ?? {}),
            outputs: Object.keys(entry?.manifest.outputs ?? {}),
            controlInputs: controlPortsOf(entry?.manifest).inputs,
            controlOutputs: controlPortsOf(entry?.manifest).outputs,
            diagnostics: (nodeProblems.get(node.id) ?? []).map((problem) => problem.message),
            isolated: entry?.isolated ?? false,
            unresolved: palette !== null && entry === undefined,
            ...(node.type === TEXT_BOX_TYPE
              ? {
                  box: {
                    kind: "text" as const,
                    value: textBoxValue(node.config),
                    onChange: (text: string) => {
                      setGraph((current) =>
                        setConfigValue(
                          current,
                          node.id,
                          "text",
                          text.length === 0 ? undefined : text,
                        ),
                      );
                    },
                  },
                }
              : node.type === OUTPUT_BOX_TYPE
                ? { box: { kind: "output" as const, value: undefined } }
                : {}),
          },
        };
      }),
    [
      graph.nodes,
      graph.editor,
      palette,
      measured,
      dragPositions,
      selectedNodeId,
      nodeProblems,
      setGraph,
    ],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge): Edge => {
        const problem = edgeProblems.get(edge.id);
        const control = edge.kind === "control";
        const className = [
          control ? "hedge--control" : "",
          problem === undefined ? "" : "hedge--invalid",
        ]
          .filter((part) => part.length > 0)
          .join(" ");
        return {
          id: edge.id,
          source: edge.from.nodeId,
          sourceHandle: control ? controlHandleId(edge.from.port) : edge.from.port,
          target: edge.to.nodeId,
          targetHandle: control ? controlHandleId(edge.to.port) : edge.to.port,
          selected: edge.id === selectedEdgeId,
          interactionWidth: 28,
          ariaLabel: `${control ? "Control" : "Data"} connection from ${edge.from.nodeId} to ${edge.to.nodeId}. Select to disconnect.`,
          ...(className.length === 0 ? {} : { className }),
          ...(problem === undefined ? {} : { label: problem }),
        };
      }),
    [graph.edges, edgeProblems, selectedEdgeId],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<HarnessFlowNode>[]) => {
      let nextSelected: string | null | undefined;
      for (const change of changes) {
        switch (change.type) {
          case "dimensions": {
            const id = change.id;
            const dimensions = change.dimensions;
            if (dimensions === undefined) break;
            setMeasured((current) =>
              current[id]?.width === dimensions.width && current[id]?.height === dimensions.height
                ? current
                : { ...current, [id]: { width: dimensions.width, height: dimensions.height } },
            );
            break;
          }
          case "position": {
            const id = change.id;
            const position = change.position;
            if (change.dragging === true) {
              if (position !== undefined) {
                setDragPositions((current) => ({ ...current, [id]: position }));
              }
              break;
            }
            // Drag finished (or a keyboard move): write the position into the
            // document, where it is saved with the graph as editor metadata.
            const final = position ?? dragPositions[id];
            if (final !== undefined) setGraph((current) => setPosition(current, id, final));
            setDragPositions((current) => withoutKey(current, id));
            break;
          }
          case "remove": {
            const id = change.id;
            setGraph((current) => removeNode(current, id));
            if (id === selectedNodeId) nextSelected = null;
            break;
          }
          case "select":
            if (change.selected) nextSelected = change.id;
            else if (nextSelected === undefined && change.id === selectedNodeId)
              nextSelected = null;
            break;
          default:
            break;
        }
      }
      if (nextSelected !== undefined) {
        setSelectedNodeId(nextSelected);
        if (nextSelected !== null) setSelectedEdgeId(null);
      }
    },
    [selectedNodeId, dragPositions, setGraph],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type === "remove") {
          const id = change.id;
          setGraph((current) => removeEdge(current, id));
        } else if (change.type === "select") {
          const id = change.id;
          if (change.selected) {
            setSelectedEdgeId(id);
            setSelectedNodeId(null);
          } else {
            setSelectedEdgeId((current) => (current === id ? null : current));
          }
        }
      }
    },
    [setGraph],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const issue = connectionIssue(graph, palette, connection);
      if (issue !== null) {
        setFeedback(issue);
        return;
      }
      const { source, target, sourceHandle, targetHandle } = connection;
      if (sourceHandle === null || targetHandle === null) return;
      const fromControl = controlPortOf(sourceHandle);
      const toControl = controlPortOf(targetHandle);
      if (fromControl === null && toControl === null) {
        setGraph((current) =>
          addDataEdge(
            current,
            { nodeId: source, port: sourceHandle },
            { nodeId: target, port: targetHandle },
          ),
        );
      } else if (fromControl !== null && toControl !== null) {
        setGraph((current) =>
          addControlEdge(
            current,
            { nodeId: source, ...(fromControl === undefined ? {} : { port: fromControl }) },
            { nodeId: target, ...(toControl === undefined ? {} : { port: toControl }) },
          ),
        );
      }
      setFeedback(
        "Connected. Select the line or use the connection list to disconnect. Undo restores the previous graph.",
      );
    },
    [graph, palette, setGraph],
  );

  // A quick guard against obviously wrong wiring while dragging. The compiler
  // still decides: cycles and schema mismatches show up as diagnostics.
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => connectionIssue(graph, palette, connection) === null,
    [graph, palette],
  );

  const disconnect = (edgeId: string): void => {
    setGraph((current) => removeEdge(current, edgeId));
    setSelectedEdgeId(null);
    setFeedback("Connection removed. Use Undo to restore it.");
  };

  const restoreHistory = (direction: "undo" | "redo"): void => {
    if (direction === "undo") undo();
    else redo();
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setDragPositions({});
    setFeedback(direction === "undo" ? "Last edit undone." : "Edit restored.");
  };

  const placeNode = (entry: PaletteEntry, position: EditorPoint): void => {
    const id = nextNodeId(graph, entry.manifest.type);
    setGraph((current) =>
      addNode(
        current,
        id,
        entry.manifest.type,
        entry.manifest.version,
        freePosition(current, position),
      ),
    );
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    setFeedback(`${entry.manifest.title} added. Select it to configure inputs and connections.`);
  };

  /** Where a clicked palette item lands: near the middle of the visible canvas. */
  const canvasCenter = (): EditorPoint => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    const center =
      bounds === undefined
        ? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
        : { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 3 };
    const point = screenToFlowPosition(center);
    return { x: point.x - NODE_FOOTPRINT.width / 2, y: point.y - NODE_FOOTPRINT.height / 2 };
  };

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    const raw = event.dataTransfer.getData(DRAG_TYPE);
    if (raw.length === 0) return;
    let spec: unknown;
    try {
      spec = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (typeof spec !== "object" || spec === null) return;
    const { type, version } = spec as { readonly type?: unknown; readonly version?: unknown };
    if (typeof type !== "string" || typeof version !== "string") return;
    const entry = findManifest(palette, type, version);
    if (entry === undefined) return;
    placeNode(entry, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };

  const runGraph = async (): Promise<void> => {
    if (
      !canRequestRun(
        shownValidation,
        palette !== null && palette.length > 0 && paletteError === null,
        running,
      ) ||
      palette === null
    )
      return;
    setRunError(null);
    if (shownValidation === "invalid") {
      // This is the answer to "why won't it run?", so it arrives with the reasons.
      setProblemsRequested(true);
      setRunError(
        diagnostics.length === 1
          ? "This graph cannot run yet: one problem is marked below."
          : `This graph cannot run yet: ${String(diagnostics.length)} problems are marked below.`,
      );
      return;
    }
    setRunning(true);
    try {
      // Every run stores a new revision, so an edited graph never collides with
      // the revision an earlier run recorded.
      const document = {
        ...finalizeGraph(graph, palette),
        revisionId: `rev-${crypto.randomUUID()}`,
      };
      const response = await fetch("/api/editor/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ graph: document }),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      const runId =
        typeof body === "object" && body !== null
          ? (body as { readonly runId?: unknown }).runId
          : undefined;
      if (response.status === 201 && typeof runId === "string") {
        router.push(`/runs/${encodeURIComponent(runId)}`);
        return;
      }
      if (response.status === 422) {
        setCheckedBody(validationBody);
        setDiagnostics(diagnosticsOf(body));
        setValidation("invalid");
        setProblemsRequested(true);
      }
      setRunError(errorReason(body, "The run could not be started."));
    } catch {
      setRunError("The runtime daemon is not reachable.");
    } finally {
      setRunning(false);
    }
  };

  const applyImport = (): void => {
    if (transfer === null) return;
    let parsed: GraphDocument | undefined;
    try {
      parsed = parseGraphDocument(JSON.parse(transfer) as unknown);
    } catch {
      setTransferError("That is not valid JSON.");
      return;
    }
    if (parsed === undefined) {
      setTransferError("That is not a Graph JSON v1 document.");
      return;
    }
    setGraph(parsed);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setDragPositions({});
    setMeasured({});
    setRunError(null);
    setProblemsRequested(false);
    setTransfer(null);
    setTransferError(null);
  };

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = graph.edges.find((edge) => edge.id === selectedEdgeId);
  const controlEdges = graph.edges.filter((edge) => edge.kind === "control").length;
  const filteredPalette = (palette ?? []).filter((entry) =>
    `${entry.manifest.title} ${entry.manifest.description ?? ""} ${pluginLabel(entry.pluginId)}`
      .toLowerCase()
      .includes(paletteSearch.trim().toLowerCase()),
  );

  return (
    <div
      className="editorWorkbench"
      onKeyDown={(event) => {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.isContentEditable || target.closest("input, textarea, select"))
        )
          return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          if (event.shiftKey ? canRedo : canUndo) restoreHistory(event.shiftKey ? "redo" : "undo");
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
          event.preventDefault();
          if (canRedo) restoreHistory("redo");
        }
      }}
    >
      <header className="editorToolbar">
        <div className="editorToolbar__summary">
          <h1>Graph editor</h1>
          <p className="muted small" role="status">
            {validationText(shownValidation, shownDiagnostics.length, problemsShown)}
          </p>
        </div>
        <div className="editorToolbar__actions">
          <button
            className="btn editorIconButton"
            type="button"
            title="Undo (Ctrl / ⌘ Z)"
            aria-label="Undo graph edit"
            disabled={!canUndo}
            onClick={() => {
              restoreHistory("undo");
            }}
          >
            <Icon name="undo" />
          </button>
          <button
            className="btn editorIconButton"
            type="button"
            title="Redo (Ctrl / ⌘ Shift Z)"
            aria-label="Redo graph edit"
            disabled={!canRedo}
            onClick={() => {
              restoreHistory("redo");
            }}
          >
            <Icon name="redo" />
          </button>
          <button
            className="btn"
            type="button"
            aria-expanded={connectionsOpen}
            aria-controls="graph-connect-panel"
            onClick={() => {
              setConnectionsOpen((current) => !current);
            }}
          >
            <Icon name="link" />
            <span>Connect nodes</span>
          </button>
          <Link className="btn" href="/editor/guide">
            <Icon name="help" />
            <span>Guide</span>
          </Link>
          <button
            type="button"
            className="btn btn--primary"
            disabled={
              !canRequestRun(
                shownValidation,
                palette !== null && palette.length > 0 && paletteError === null,
                running,
              )
            }
            onClick={() => {
              void runGraph();
            }}
          >
            <Icon name="arrow-up" />
            {running ? "Starting…" : "Run graph"}
          </button>
        </div>
      </header>
      {runError === null ? null : (
        <p className="warn editorNotice" role="alert">
          {runError}
        </p>
      )}
      {autosaveError ? (
        <p className="warn editorNotice" role="alert">
          Browser storage is unavailable. Export the graph JSON before leaving to keep your work.
        </p>
      ) : null}
      <div
        className="editor"
        style={
          {
            "--editor-palette-width": `${String(paletteWidth)}px`,
            "--editor-inspector-width": `${String(inspectorWidth)}px`,
          } as CSSProperties
        }
      >
        <aside
          id="graph-node-palette"
          className="editorPanel editorPalette"
          aria-label="Node palette"
        >
          <h2 className="panelTitle">Node library</h2>
          <label className="editorSearch">
            <Icon name="search" />
            <input
              type="search"
              aria-label="Search nodes"
              placeholder="Search nodes…"
              value={paletteSearch}
              onChange={(event) => {
                setPaletteSearch(event.target.value);
              }}
            />
          </label>
          {palette === null ? <p className="muted small">Loading nodes…</p> : null}
          {paletteError === null ? null : <p className="warn">{paletteError}</p>}
          {palette !== null && palette.length === 0 && paletteError === null ? (
            <p className="muted small">
              No nodes are available yet. Enable a plugin on the{" "}
              <Link href="/plugins">Plugins</Link> page.
            </p>
          ) : null}
          <ul className="paletteList">
            {filteredPalette.map((entry) => (
              <li key={`${entry.manifest.type}@${entry.manifest.version}`}>
                <button
                  type="button"
                  className="paletteItem"
                  draggable
                  title={entry.manifest.description ?? entry.manifest.title}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      DRAG_TYPE,
                      JSON.stringify({
                        type: entry.manifest.type,
                        version: entry.manifest.version,
                      }),
                    );
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => {
                    placeNode(entry, canvasCenter());
                  }}
                >
                  <span className="paletteItem__title">{entry.manifest.title}</span>
                  <span className="paletteItem__meta">
                    {pluginLabel(entry.pluginId)}
                    {entry.isolated ? " · runs isolated" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {palette !== null && palette.length > 0 && filteredPalette.length === 0 ? (
            <p className="muted small">No nodes match “{paletteSearch}”. Try another name.</p>
          ) : null}
          <p className="muted small">Click to add. Drag to choose a position.</p>
          <p className="muted small">
            Side ports pass data. Top and bottom ports order steps.{" "}
            <Link href="/editor/guide">Learn the basics</Link>
          </p>
        </aside>

        <ResizeHandle
          label="Resize node library"
          controls="graph-node-palette"
          value={paletteWidth}
          min={168}
          max={360}
          defaultValue={208}
          onChange={setPaletteWidth}
          side="left"
          className="editorResize"
        />

        <section
          ref={canvasRef}
          className="canvas"
          aria-label="Graph canvas"
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={harnessNodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onBeforeDelete={({ nodes, edges }) => {
              // Commit one document so Undo restores nodes together with their edges.
              setGraph((current) => {
                let next = current;
                for (const edge of edges) next = removeEdge(next, edge.id);
                for (const node of nodes) next = removeNode(next, node.id);
                return next;
              });
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
              setFeedback("Selection removed. Use Undo to restore it.");
              return Promise.resolve(false);
            }}
            onConnect={onConnect}
            connectOnClick
            connectionRadius={28}
            onConnectStart={() => {
              setFeedback(
                "Choose a matching input port. Side ports carry data; top and bottom ports control order.",
              );
            }}
            isValidConnection={isValidConnection}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            deleteKeyCode={["Backspace", "Delete"]}
            colorMode="dark"
            fitView
            fitViewOptions={{ maxZoom: 1 }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls position="top-left" />
            <MiniMap pannable zoomable position="bottom-right" />
          </ReactFlow>
          {empty ? (
            <div className="editorEmptyCanvas">
              <Icon name="graph" size={30} />
              <h2>Build your first workflow</h2>
              <p>
                Add a Text box and an Output box from the library, then connect their side ports.
              </p>
              <Link href="/editor/guide">
                Follow the quick start <Icon name="chevron-right" />
              </Link>
            </div>
          ) : null}
          <div className="editorCanvasHint" role="status" aria-live="polite">
            {feedback}
          </div>
        </section>

        <ResizeHandle
          label="Resize graph inspector"
          controls="graph-inspector"
          value={inspectorWidth}
          min={240}
          max={480}
          defaultValue={300}
          onChange={setInspectorWidth}
          side="right"
          className="editorResize"
        />

        <aside id="graph-inspector" className="editorPanel editorInspector" aria-label="Inspector">
          {connectionsOpen ? (
            <section
              ref={connectionPanelRef}
              id="graph-connect-panel"
              className="connectionComposer"
            >
              <div className="connectionComposer__heading">
                <h2 className="panelTitle">Connect nodes</h2>
                <button
                  className="btn editorIconButton"
                  type="button"
                  aria-label="Close connection builder"
                  onClick={() => {
                    setConnectionsOpen(false);
                  }}
                >
                  <Icon name="x" />
                </button>
              </div>
              <ConnectionBuilder
                key={selectedNodeId}
                graph={graph}
                palette={palette}
                sourceNodeId={selectedNodeId}
                onConnect={onConnect}
              />
            </section>
          ) : null}
          {selectedNode !== undefined || selectedEdge !== undefined ? (
            <div className="btnRow inspectorNavigation">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setSelectedNodeId(null);
                  setSelectedEdgeId(null);
                }}
              >
                <Icon name="graph" /> Graph overview
              </button>
            </div>
          ) : null}
          {selectedNode !== undefined ? (
            <NodeInspector
              key={selectedNode.id}
              node={selectedNode}
              entry={findManifest(palette, selectedNode.type, selectedNode.version)}
              paletteLoaded={palette !== null}
              fed={fedPorts(graph, selectedNode.id)}
              problems={nodeProblems.get(selectedNode.id) ?? []}
              onConfig={(key, value) => {
                setGraph((current) => setConfigValue(current, selectedNode.id, key, value));
              }}
              onLiteral={(port, value) => {
                setGraph((current) => setLiteral(current, selectedNode.id, port, value));
              }}
              onDelete={() => {
                setGraph((current) => removeNode(current, selectedNode.id));
                setSelectedNodeId(null);
                setFeedback("Node and its connections removed. Use Undo to restore them.");
              }}
            />
          ) : selectedEdge !== undefined ? (
            <EdgeInspector
              edge={selectedEdge}
              problem={edgeProblems.get(selectedEdge.id)}
              onDelete={() => {
                disconnect(selectedEdge.id);
              }}
            />
          ) : (
            <>
              <h2 className="panelTitle">Graph</h2>
              <p className="statusLine" role="status">
                <span
                  className={`statusDot statusDot--${
                    shownValidation === "valid"
                      ? "on"
                      : shownValidation === "invalid" || shownValidation === "unreachable"
                        ? "off"
                        : "warn"
                  }`}
                  aria-hidden="true"
                />
                {validationText(shownValidation, shownDiagnostics.length, problemsShown)}
              </p>
              <p className="muted small">
                {countLabel(graph.nodes.length, "node")} ·{" "}
                {countLabel(graph.edges.length - controlEdges, "connection")}
                {controlEdges > 0 ? ` · ${countLabel(controlEdges, "control edge")}` : ""}
              </p>
              {shownDiagnostics.length > 0 ? (
                <>
                  <h3 className="sectionTitle">Problems</h3>
                  <ul className="diagList">
                    {shownDiagnostics.map((diagnostic, index) => (
                      <li key={`${diagnostic.code}-${String(index)}`}>
                        <button
                          type="button"
                          className="diagItem"
                          disabled={
                            diagnostic.nodeId === undefined && diagnostic.edgeId === undefined
                          }
                          onClick={() => {
                            if (diagnostic.nodeId !== undefined) {
                              setSelectedNodeId(diagnostic.nodeId);
                              setSelectedEdgeId(null);
                            } else if (diagnostic.edgeId !== undefined) {
                              setSelectedEdgeId(diagnostic.edgeId);
                              setSelectedNodeId(null);
                            }
                          }}
                        >
                          {diagnostic.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              <h3 className="sectionTitle">Document</h3>
              {transfer === null ? (
                <div className="btnRow">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setTransferError(null);
                      setTransfer(JSON.stringify(finalizeGraph(graph, palette), null, 2));
                    }}
                  >
                    Export JSON
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setTransferError(null);
                      setTransfer("");
                    }}
                  >
                    Import JSON
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={empty}
                    onClick={() => {
                      if (!window.confirm("Remove every node and connection from this graph?"))
                        return;
                      setGraph(emptyGraph(graph.graphId));
                      setSelectedNodeId(null);
                      setSelectedEdgeId(null);
                      setDragPositions({});
                    }}
                  >
                    Clear
                  </button>
                </div>
              ) : (
                <>
                  <textarea
                    className="field__input transferBox"
                    aria-label="Graph JSON"
                    spellCheck={false}
                    value={transfer}
                    onChange={(event) => {
                      setTransfer(event.target.value);
                      setTransferError(null);
                    }}
                  />
                  {transferError === null ? null : (
                    <p className="field__error" role="alert">
                      {transferError}
                    </p>
                  )}
                  <div className="btnRow">
                    <button type="button" className="btn btn--primary" onClick={applyImport}>
                      Load this JSON
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setTransfer(null);
                        setTransferError(null);
                      }}
                    >
                      Close
                    </button>
                  </div>
                </>
              )}
              <p className="muted small">
                {autosaveError ? "Export JSON to keep your work." : "Draft saved in this browser."}{" "}
                Each run records a new revision. Undo history lasts until you leave this page.
              </p>
            </>
          )}
          <ConnectionList
            graph={graph}
            palette={palette}
            {...(selectedNode === undefined ? {} : { nodeId: selectedNode.id })}
            onSelect={(edgeId) => {
              setSelectedEdgeId(edgeId);
              setSelectedNodeId(null);
            }}
            onDisconnect={disconnect}
          />
        </aside>
      </div>
    </div>
  );
}

function NodeInspector({
  node,
  entry,
  paletteLoaded,
  fed,
  problems,
  onConfig,
  onLiteral,
  onDelete,
}: {
  readonly node: GraphNode;
  readonly entry: PaletteEntry | undefined;
  readonly paletteLoaded: boolean;
  readonly fed: ReadonlySet<string>;
  readonly problems: readonly EditorDiagnostic[];
  readonly onConfig: (key: string, value: JsonValue | undefined) => void;
  readonly onLiteral: (port: string, value: JsonValue | undefined) => void;
  readonly onDelete: () => void;
}) {
  const manifest = entry?.manifest;
  const configSchema = manifest?.configSchema;
  const properties =
    typeof configSchema === "object" ? Object.entries(configSchema.properties ?? {}) : [];
  const requiredConfig = new Set(
    typeof configSchema === "object" ? (configSchema.required ?? []) : [],
  );

  return (
    <>
      <h2 className="panelTitle">{manifest?.title ?? node.type}</h2>
      <p className="cardMeta">
        <code>{node.id}</code>
      </p>

      {manifest === undefined ? (
        paletteLoaded ? (
          <p className="warn">
            No enabled plugin provides this node type, so it cannot run. Enable the plugin that
            provides it, or delete the node.
          </p>
        ) : null
      ) : (
        <>
          <p className="muted small">
            From <strong>{entry === undefined ? "" : pluginLabel(entry.pluginId)}</strong>
            {entry?.isolated === true ? " · runs isolated" : ""}
          </p>
          {manifest.description === undefined ? null : (
            <p className="small">{manifest.description}</p>
          )}
          <p className="muted small">
            {behaviourLabel(manifest.behavior.effect, manifest.behavior.recovery)}
          </p>
          {manifest.behavior.requiredCapabilities.length > 0 ? (
            <>
              <h3 className="sectionTitle">Needs</h3>
              <div className="chips">
                {manifest.behavior.requiredCapabilities.map((capability) => (
                  <span key={capability} className="chip">
                    {capabilityLabel(capability)}
                  </span>
                ))}
              </div>
            </>
          ) : null}

          <h3 className="sectionTitle">Configuration</h3>
          {properties.length === 0 ? (
            <p className="muted small">This node has no configuration.</p>
          ) : (
            properties.map(([key, schema]) => (
              <SchemaField
                key={`config:${key}`}
                label={fieldLabel(key)}
                schema={schema}
                value={node.config[key]}
                required={requiredConfig.has(key)}
                onChange={(value) => {
                  onConfig(key, value);
                }}
              />
            ))
          )}

          <h3 className="sectionTitle">Inputs</h3>
          {Object.keys(manifest.inputs).length === 0 ? (
            <p className="muted small">This node takes no inputs.</p>
          ) : (
            Object.entries(manifest.inputs).map(([port, spec]) =>
              fed.has(port) ? (
                <p key={port} className="small">
                  <strong>{fieldLabel(port)}</strong> is connected.
                </p>
              ) : spec.secret === true ? (
                <p key={port} className="small">
                  <strong>{fieldLabel(port)}</strong> is a secret input and needs a secret
                  reference, not a typed value.
                </p>
              ) : (
                <SchemaField
                  key={`input:${port}`}
                  label={fieldLabel(port)}
                  schema={spec.schema}
                  value={literalFor(node, port)}
                  required={spec.required === true}
                  hint="Used when nothing is connected to this input."
                  onChange={(value) => {
                    onLiteral(port, value);
                  }}
                />
              ),
            )
          )}
        </>
      )}

      {problems.length > 0 ? (
        <>
          <h3 className="sectionTitle">Problems</h3>
          <ul className="diagList">
            {problems.map((problem, index) => (
              <li key={`${problem.code}-${String(index)}`} className="diagItem">
                {problem.message}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="btnRow">
        <button type="button" className="btn btn--danger" onClick={onDelete}>
          Delete node
        </button>
      </div>
    </>
  );
}

function EdgeInspector({
  edge,
  problem,
  onDelete,
}: {
  readonly edge: GraphEdge;
  readonly problem: string | undefined;
  readonly onDelete: () => void;
}) {
  return (
    <>
      <h2 className="panelTitle">{edge.kind === "control" ? "Control edge" : "Connection"}</h2>
      {edge.kind === "control" ? (
        <p className="muted small">
          The target runs only once the source finishes on this path. If the source is skipped, the
          target is skipped too.
        </p>
      ) : null}
      <p className="small">
        <code>
          {edge.from.nodeId}.{edge.from.port ?? "control"}
        </code>{" "}
        →{" "}
        <code>
          {edge.to.nodeId}.{edge.to.port ?? "control"}
        </code>
      </p>
      {problem === undefined ? null : <p className="warn">{problem}</p>}
      <div className="btnRow">
        <button type="button" className="btn btn--danger" onClick={onDelete}>
          <Icon name="unlink" /> Disconnect
        </button>
      </div>
    </>
  );
}
