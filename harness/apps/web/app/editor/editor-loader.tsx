"use client";

import dynamic from "next/dynamic";

// React Flow is only needed on the editor and run pages, so it is loaded there
// on demand and never rendered on the server.
const GraphEditor = dynamic(() => import("./graph-editor"), {
  ssr: false,
  loading: () => <p className="muted">Loading the editor…</p>,
});

export function EditorLoader() {
  return <GraphEditor />;
}
