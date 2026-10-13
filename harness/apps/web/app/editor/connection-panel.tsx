import { useId, useState } from "react";
import type { Connection } from "@xyflow/react";

import {
  controlHandleId,
  controlPortsOf,
  findManifest,
  type GraphDocument,
  type GraphEdge,
  type PaletteEntry,
} from "../../lib/graph-document";
import { fieldLabel } from "../../lib/plain-words";
import { Icon } from "../ui/workspace-icon";
import { connectionIssue } from "./connections";

export function connectionLabel(
  edge: GraphEdge,
  graph: GraphDocument,
  palette: readonly PaletteEntry[] | null,
): string {
  const name = (id: string) => {
    const node = graph.nodes.find((item) => item.id === id);
    return node
      ? `${findManifest(palette, node.type, node.version)?.manifest.title ?? node.type} (${id})`
      : id;
  };
  return `${name(edge.from.nodeId)} · ${fieldLabel(edge.from.port ?? "after")} → ${name(edge.to.nodeId)} · ${fieldLabel(edge.to.port ?? "before")}`;
}

/** Native selects make every connection possible without precise pointer gestures. */
export function ConnectionBuilder({
  graph,
  palette,
  sourceNodeId,
  onConnect,
}: {
  readonly graph: GraphDocument;
  readonly palette: readonly PaletteEntry[] | null;
  readonly sourceNodeId: string | null;
  readonly onConnect: (connection: Connection) => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<"data" | "control">("data");
  const endpoints = (direction: "inputs" | "outputs") =>
    graph.nodes.flatMap((node) => {
      const entry = findManifest(palette, node.type, node.version);
      if (!entry) return [];
      const ports =
        kind === "control"
          ? controlPortsOf(entry.manifest)[direction].map(controlHandleId)
          : Object.keys(entry.manifest[direction]);
      return ports.map((handle) => ({
        value: JSON.stringify([node.id, handle]),
        nodeId: node.id,
        handle,
        label: `${entry.manifest.title} (${node.id}) · ${fieldLabel(handle.startsWith("ctl:") ? handle.slice(4) || (direction === "outputs" ? "after" : "before") : handle)}`,
      }));
    });
  const sources = endpoints("outputs");
  const destinations = endpoints("inputs");
  const [sourceValue, setSourceValue] = useState(
    () => sources.find((item) => item.nodeId === sourceNodeId)?.value ?? "",
  );
  const [targetValue, setTargetValue] = useState("");
  const source = sources.find((item) => item.value === sourceValue);
  const target = destinations.find((item) => item.value === targetValue);
  const connection = {
    source: source?.nodeId ?? "",
    target: target?.nodeId ?? "",
    sourceHandle: source?.handle ?? null,
    targetHandle: target?.handle ?? null,
  };
  const issue = connectionIssue(graph, palette, connection);
  return (
    <form
      className="connectionBuilder"
      aria-label="Connect nodes"
      onSubmit={(event) => {
        event.preventDefault();
        if (issue === null) onConnect(connection);
      }}
    >
      <p className="muted small">
        Choose two ports below, or click an output on the canvas, then an input.
      </p>
      <label className="field" htmlFor={`${id}-kind`}>
        <span className="field__label">Connection type</span>
        <select
          id={`${id}-kind`}
          className="field__input"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value === "control" ? "control" : "data");
            setSourceValue("");
            setTargetValue("");
          }}
        >
          <option value="data">Data — pass a value</option>
          <option value="control">Control — order steps</option>
        </select>
      </label>
      <label className="field" htmlFor={`${id}-source`}>
        <span className="field__label">From output</span>
        <select
          id={`${id}-source`}
          className="field__input"
          value={source?.value ?? ""}
          onChange={(event) => {
            setSourceValue(event.target.value);
            if (
              sources.find((item) => item.value === event.target.value)?.nodeId === target?.nodeId
            ) {
              setTargetValue("");
            }
          }}
        >
          <option value="">Choose an output…</option>
          {sources.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field" htmlFor={`${id}-target`}>
        <span className="field__label">To input</span>
        <select
          id={`${id}-target`}
          className="field__input"
          value={target?.value ?? ""}
          onChange={(event) => {
            setTargetValue(event.target.value);
          }}
        >
          <option value="">Choose an input…</option>
          {destinations
            .filter((item) => item.nodeId !== source?.nodeId)
            .map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
        </select>
      </label>
      <p id={`${id}-hint`} className="muted small" aria-live="polite">
        {issue ?? "Ready to connect. The compiler checks data compatibility."}
      </p>
      <button
        className="btn"
        type="submit"
        disabled={issue !== null}
        aria-describedby={`${id}-hint`}
      >
        <Icon name="link" /> Connect ports
      </button>
    </form>
  );
}

export function ConnectionList({
  graph,
  palette,
  nodeId,
  onSelect,
  onDisconnect,
}: {
  readonly graph: GraphDocument;
  readonly palette: readonly PaletteEntry[] | null;
  readonly nodeId?: string;
  readonly onSelect: (edgeId: string) => void;
  readonly onDisconnect: (edgeId: string) => void;
}) {
  const edges = graph.edges.filter(
    (edge) => nodeId === undefined || edge.from.nodeId === nodeId || edge.to.nodeId === nodeId,
  );
  return (
    <section className="connectionList" aria-label="Connections">
      <h3 className="sectionTitle">
        Connections <span className="muted">{edges.length}</span>
      </h3>
      {edges.length === 0 ? (
        <p className="muted small">
          No connections yet. Connect an output to another node&apos;s input to pass a value.
        </p>
      ) : (
        <ul>
          {edges.map((edge) => (
            <li key={edge.id}>
              <button
                type="button"
                className="connectionList__name"
                onClick={() => {
                  onSelect(edge.id);
                }}
              >
                <span className="connectionList__kind">
                  {edge.kind === "control" ? "Control · order steps" : "Data · pass a value"}
                </span>
                {connectionLabel(edge, graph, palette)}
              </button>
              <button
                type="button"
                className="btn connectionList__remove"
                aria-label={`Disconnect ${connectionLabel(edge, graph, palette)}`}
                title="Disconnect"
                onClick={() => {
                  onDisconnect(edge.id);
                }}
              >
                <Icon name="unlink" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
