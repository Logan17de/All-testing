"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { controlHandleId } from "../lib/graph-document";
import { fieldLabel } from "../lib/plain-words";

export type HarnessNodeData = {
  readonly title: string;
  /** The node type, shown only on hover. */
  readonly type: string;
  /** Where the node comes from, in plain words. */
  readonly subtitle?: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** Control ports above the node; `undefined` is an unnamed ordering port. */
  readonly controlInputs?: readonly (string | undefined)[];
  /** Control ports below the node. */
  readonly controlOutputs?: readonly (string | undefined)[];
  readonly diagnostics: readonly string[];
  readonly status?: string;
  readonly isolated?: boolean;
  /** No enabled plugin provides this node type. */
  readonly unresolved?: boolean;
  readonly readOnly?: boolean;
  /**
   * What a box shows inside itself: the text typed into a Text box, editable
   * when `onChange` is given, or the text that reached an Output box in a run.
   */
  readonly box?:
    | { readonly kind: "text"; readonly value: string; readonly onChange?: (text: string) => void }
    | { readonly kind: "output"; readonly value: string | undefined };
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
    <div className={className} title={data.type}>
      <ControlPorts ports={data.controlInputs ?? []} direction="in" connectable={connectable} />
      <header className="hnode__head">
        <span className="hnode__title">{data.title}</span>
        {data.isolated === true ? (
          <span className="hnode__tag" title="Runs in a sandboxed process">
            isolated
          </span>
        ) : null}
      </header>
      {data.subtitle === undefined ? null : <p className="hnode__type">{data.subtitle}</p>}
      {data.status === undefined ? null : (
        <p className={`hnode__status hnode__status--${data.status}`}>
          {STATUS_LABEL[data.status] ?? data.status}
        </p>
      )}
      {data.unresolved === true ? (
        <p className="hnode__diag">No enabled plugin provides this node.</p>
      ) : null}
      {data.box === undefined ? null : <BoxContent box={data.box} />}
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
              {fieldLabel(port)}
            </li>
          ))}
        </ul>
        <ul className="hnode__col hnode__col--out">
          {data.outputs.map((port) => (
            <li key={port} className="hnode__port hnode__port--out">
              {fieldLabel(port)}
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
      <ControlPorts ports={data.controlOutputs ?? []} direction="out" connectable={connectable} />
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

/**
 * Inside a box. The text area is marked `nodrag` and `nowheel` so typing, selecting
 * and scrolling stay in the box instead of moving or zooming the canvas.
 */
function BoxContent({ box }: { readonly box: NonNullable<HarnessNodeData["box"]> }) {
  if (box.kind === "text") {
    const { onChange } = box;
    return (
      <textarea
        className="hnode__box nodrag nowheel"
        aria-label="Text"
        value={box.value}
        rows={4}
        maxLength={100_000}
        readOnly={onChange === undefined}
        placeholder={onChange === undefined ? "" : "Type the text to send…"}
        onChange={(event) => {
          onChange?.(event.target.value);
        }}
      />
    );
  }
  return (
    <pre
      className={`hnode__box hnode__box--output nowheel${box.value === undefined ? " hnode__box--empty" : ""}`}
      aria-label="Output"
    >
      {box.value ?? "Run the graph to see what arrives here."}
    </pre>
  );
}

/**
 * Control handles sit above (into the node) and below (out of it), apart from the
 * data ports on the sides, so a control edge can never be drawn into a data port.
 */
function ControlPorts({
  ports,
  direction,
  connectable,
}: {
  readonly ports: readonly (string | undefined)[];
  readonly direction: "in" | "out";
  readonly connectable: boolean;
}) {
  if (ports.length === 0) return null;
  return (
    <ul
      className={`hnode__ctl hnode__ctl--${direction}`}
      aria-label={direction === "in" ? "Control inputs" : "Control outputs"}
    >
      {ports.map((port) => (
        <li
          key={controlHandleId(port)}
          className="hnode__ctlport"
          title={
            port === undefined
              ? direction === "in"
                ? "Runs after the connected node"
                : "Connected nodes run after this one"
              : `Control ${direction === "in" ? "input" : "output"} '${port}'`
          }
        >
          <Handle
            type={direction === "in" ? "target" : "source"}
            position={direction === "in" ? Position.Top : Position.Bottom}
            id={controlHandleId(port)}
            isConnectable={connectable}
            className="hnode__handle hnode__handle--control"
          />
          {port ?? ""}
        </li>
      ))}
    </ul>
  );
}

/** Stable module-level object, so React Flow never sees new node types per render. */
export const harnessNodeTypes = { harness: HarnessNode };
