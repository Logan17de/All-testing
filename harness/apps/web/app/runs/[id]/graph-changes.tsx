"use client";

import { useEffect, useState } from "react";

interface RevisionSummary {
  readonly revisionId: string;
  readonly createdAtMs: number;
  readonly runs: number;
}

interface NodeChange {
  readonly nodeId: string;
  readonly changes: readonly string[];
  readonly before: { readonly type: string; readonly version: string };
  readonly after: { readonly type: string; readonly version: string };
}

interface GraphDiff {
  readonly from: string;
  readonly to: string;
  readonly sameSemantics: boolean;
  readonly identical: boolean;
  readonly summary: string;
  readonly nodesAdded: readonly { readonly id: string }[];
  readonly nodesRemoved: readonly { readonly id: string }[];
  readonly nodesChanged: readonly NodeChange[];
  readonly edgesAdded: readonly { readonly label: string }[];
  readonly edgesRemoved: readonly { readonly label: string }[];
}

function isDiff(value: unknown): value is GraphDiff {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["summary"] === "string" && Array.isArray(record["nodesChanged"]);
}

/**
 * What changed in this graph since this run.
 *
 * A run is bound to the exact revision it started from, so the graph in the editor
 * can have moved on. This says so, and says whether the change would make the graph
 * run differently at all — the compiler's semantic hash answers that, so a node
 * dragged across the canvas does not masquerade as a change to the work.
 */
export function GraphChanges({
  graphId,
  revisionId,
}: {
  readonly graphId: string;
  readonly revisionId: string;
}) {
  const [diff, setDiff] = useState<GraphDiff | null>(null);
  const [latest, setLatest] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const listed = await fetch(`/api/editor/graphs/${encodeURIComponent(graphId)}/revisions`, {
        cache: "no-store",
      });
      if (!listed.ok) return;
      const body = (await listed.json()) as { readonly revisions?: readonly RevisionSummary[] };
      const revisions = body.revisions ?? [];
      // Newest first, as the runtime lists them.
      const newest = revisions[0];
      if (cancelled || newest === undefined || newest.revisionId === revisionId) return;
      setLatest(newest.revisionId);

      const compared = await fetch(
        `/api/editor/graphs/${encodeURIComponent(graphId)}/diff?from=${encodeURIComponent(revisionId)}&to=${encodeURIComponent(newest.revisionId)}`,
        { cache: "no-store" },
      );
      if (!compared.ok || cancelled) return;
      const result = (await compared.json()) as { readonly diff?: unknown };
      if (!cancelled && isDiff(result.diff)) setDiff(result.diff);
    };
    void load().catch(() => {
      // The panel is extra context; a harness that cannot answer simply shows nothing.
    });
    return () => {
      cancelled = true;
    };
  }, [graphId, revisionId]);

  if (diff === null || latest === null || diff.identical) return null;

  return (
    <section className="changePanel" aria-label="Graph changes since this run">
      <h2 className="panelTitle">Since this run</h2>
      <p className="small">
        This run used <code>{revisionId}</code>; the graph is now <code>{latest}</code>.
      </p>
      <p className="small">{diff.summary}</p>
      {diff.sameSemantics ? (
        <p className="muted small">
          Those changes do not change what the graph does, so a new run would do the same work.
        </p>
      ) : null}
      <ul className="forkList">
        {diff.nodesAdded.map((node) => (
          <li key={`added-${node.id}`}>
            <span className="changeMark changeMark--added">added</span> <code>{node.id}</code>
          </li>
        ))}
        {diff.nodesRemoved.map((node) => (
          <li key={`removed-${node.id}`}>
            <span className="changeMark changeMark--removed">removed</span> <code>{node.id}</code>
          </li>
        ))}
        {diff.nodesChanged.map((node) => (
          <li key={`changed-${node.nodeId}`}>
            <span className="changeMark">changed</span> <code>{node.nodeId}</code>{" "}
            <span className="muted small">
              {node.changes.join(", ")}
              {node.before.version === node.after.version
                ? ""
                : ` (${node.before.version} → ${node.after.version})`}
            </span>
          </li>
        ))}
        {diff.edgesAdded.map((edge) => (
          <li key={`edge-added-${edge.label}`}>
            <span className="changeMark changeMark--added">edge</span>{" "}
            <span className="small">{edge.label}</span>
          </li>
        ))}
        {diff.edgesRemoved.map((edge) => (
          <li key={`edge-removed-${edge.label}`}>
            <span className="changeMark changeMark--removed">edge</span>{" "}
            <span className="small">{edge.label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
