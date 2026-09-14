"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

export type HarnessNodeData = {
  readonly title: string;
  readonly type: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly diagnostics: readonly string[];
  readonly status?: string;
  readonly isolated?: boolean;
  /** No enabled plugin provides this node type. */
  readonly unresolved?: boolean;
  readonly readOnly?: boolean;
};

export type HarnessFlowNode = Node<HarnessNodeData, "harness">;

const STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: "Pending",
  ready: "Ready",
  running: "Running",
  completed: "Done",
  failed: "Failed",
  waiting: "Waiting",
  "retry-wait": "Retrying",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

/**
 * One Graph JSON node on the canvas.
 *
 * Handles are keyed by port name, so an edge drawn here maps one-to-one onto a
 * Graph JSON data edge's `port` fields with no translation layer between them.
 */
export function HarnessNode({ data, selected }: NodeProps<HarnessFlowNode>) {
  const invalid = data.diagnostics.length > 0 || data.unresolved === true;
  const className = [
    "hnode",
    selected ? "hnode--selected" : "",
    invalid ? "hnode--invalid" : "",
    data.status === undefined ? "" : `hnode--${data.status}`,
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  const connectable = data.readOnly !== true;

  return (
    <div className={className}>
      <header className="hnode__head">
        <span className="hnode__title">{data.title}</span>
        {data.isolated === true ? (
          <span className="hnode__tag" title="Runs in a sandboxed process">
            isolated
          </span>
        ) : null}
      </header>
      <p className="hnode__type">{data.type}</p>
      {data.status === undefined ? null : (
        <p className={`hnode__status hnode__status--${data.status}`}>
          {STATUS_LABEL[data.status] ?? data.status}
        </p>
      )}
      {data.unresolved === true ? (
        <p className="hnode__diag">No enabled plugin provides this node.</p>
      ) : null}
      <div className="hnode__ports">
        <ul className="hnode__col">
          {data.inputs.map((port) => (
            <li key={port} className="hnode__port hnode__port--in">
              <Handle
                type="target"
                position={Position.Left}
                id={port}
                isConnectable={connectable}
                className="hnode__handle"
              />
              {port}
            </li>
          ))}
        </ul>
        <ul className="hnode__col hnode__col--out">
          {data.outputs.map((port) => (
            <li key={port} className="hnode__port hnode__port--out">
              {port}
              <Handle
                type="source"
                position={Position.Right}
                id={port}
                isConnectable={connectable}
                className="hnode__handle"
              />
            </li>
          ))}
        </ul>
      </div>
      {data.diagnostics.length > 0 ? (
        <p className="hnode__diag" title={data.diagnostics.join("\n")}>
          {data.diagnostics.length === 1
            ? "1 problem"
            : `${String(data.diagnostics.length)} problems`}
        </p>
      ) : null}
    </div>
  );
}

/** Stable module-level object, so React Flow never sees new node types per render. */
export const harnessNodeTypes = { harness: HarnessNode };
