"use client";
import { ChatPluginScope } from "./chat-plugin-scope";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { chatGraph, type ChatGraph } from "./chat-graph-view";
const Canvas = dynamic(() => import("./chat-graph-canvas"), {
  ssr: false,
  loading: () => <p>Loading graph preview…</p>,
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
  const [open, setOpen] = useState(false);
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
      <h2 className="panelTitle">Connected graph</h2>
      <p role="status">
        {error ||
          (!current
            ? "Loading chat graph…"
            : current.graphId
              ? `Connected: ${current.graph?.metadata?.title || current.graphId}`
              : "This chat has no connected graph.")}
      </p>
      <button aria-expanded={open} disabled={!current?.graph} onClick={() => setOpen((v) => !v)}>
        {open ? "Collapse graph" : "Open graph"}
      </button>
      <ChatPluginScope key={sessionId} sessionId={sessionId} action={action} />
      {open && current?.graph ? (
        <>
          <button onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Restore side panel" : "Expand graph"}
          </button>
          <p className="muted">
            Read-only preview · revision {current.graph.revisionId}. Chat stays open.
          </p>
          {current.graph.nodes.length ? (
            <Canvas graph={current.graph} />
          ) : (
            <p>The connected graph is empty.</p>
          )}
        </>
      ) : null}
    </aside>
  );
}
