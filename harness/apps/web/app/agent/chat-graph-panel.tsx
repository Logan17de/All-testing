"use client";
import { ChatPluginScope } from "./chat-plugin-scope";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { chatGraph, type ChatGraph } from "./chat-graph-view";
const Canvas = dynamic(() => import("./chat-graph-canvas"), {
  ssr: false,
  loading: () => <p role="status">Loading graph preview…</p>,
});
export function ChatGraphPanel({
  sessionId,
  revision,
  action,
}: {
  sessionId: string;
  revision?: string;
  action: (name: string, params: Record<string, unknown>) => Promise<unknown>;
}) {
  const [linked, setLinked] = useState<ChatGraph | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let stale = false;
    void action("session/graph", { sessionId })
      .then((value) => {
        if (stale) return;
        const graph = chatGraph(value, sessionId);
        if (!graph) throw Error("The linked graph response is invalid.");
        setLinked(graph);
        setError("");
      })
      .catch(() => {
        if (!stale) {
          setLinked(null);
          setError("The connected graph could not be loaded.");
        }
      });
    return () => {
      stale = true;
    };
  }, [sessionId, revision, action]);
  const current = linked?.sessionId === sessionId ? linked : null;
  return (
    <aside
      className={`panel chatGraphPanel${expanded ? " chatGraphPanel--expanded" : ""}`}
      aria-label="Chat graph connection"
    >
      <h2 className="panelTitle">Graph</h2>
      <p className="codingGraphStatus" role="status">
        {error ||
          (!current
            ? "Loading linked graph…"
            : current.graphId
              ? current.graph?.metadata?.title || current.graphId
              : "No graph connected to this chat.")}
      </p>
      {current?.graph ? (
        <>
          <div className="codingGraphActions">
            <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              {open ? "Collapse preview" : "Show preview"}
            </button>
            <button type="button" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Restore side panel" : "Expand graph"}
            </button>
          </div>
          {open ? (
            current.graph.nodes.length ? (
              <Canvas graph={current.graph} />
            ) : (
              <p className="codingGraphEmpty">The connected graph is empty.</p>
            )
          ) : null}
          <p className="codingGraphStatus">Read-only · revision {current.graph.revisionId}</p>
        </>
      ) : !error && current ? (
        <p className="codingGraphEmpty">
          Linked workflows appear here. Your conversation stays open beside them.
        </p>
      ) : null}
      <div className="codingGraphTools">
        <ChatPluginScope key={sessionId} sessionId={sessionId} action={action} />
      </div>
    </aside>
  );
}
