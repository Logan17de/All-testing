"use client";

import dynamic from "next/dynamic";

const RunInspector = dynamic(() => import("./run-inspector"), {
  ssr: false,
  loading: () => <p className="muted">Loading the run…</p>,
});

export function RunInspectorLoader({ runId }: { readonly runId: string }) {
  return <RunInspector runId={runId} />;
}
