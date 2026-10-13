import {
  controlHandleId,
  controlPortOf,
  controlPortsOf,
  findManifest,
  type GraphDocument,
  type PaletteEntry,
} from "../../lib/graph-document";

export interface EditorConnection {
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
}

/** Shared by canvas gestures and the keyboard-accessible connection form. */
export function connectionIssue(
  graph: GraphDocument,
  palette: readonly PaletteEntry[] | null,
  connection: EditorConnection,
): string | null {
  const { source, target, sourceHandle, targetHandle } = connection;
  if (!source || !target) return "Choose a source and destination node.";
  if (source === target) return "Choose two different nodes.";
  if (!sourceHandle || !targetHandle) return "Choose an output and input port.";
  const sourceNode = graph.nodes.find((node) => node.id === source);
  const targetNode = graph.nodes.find((node) => node.id === target);
  const sourceEntry = sourceNode && findManifest(palette, sourceNode.type, sourceNode.version);
  const targetEntry = targetNode && findManifest(palette, targetNode.type, targetNode.version);
  if (!sourceEntry || !targetEntry) return "Both nodes need an enabled plugin before connecting.";
  const fromControl = controlPortOf(sourceHandle);
  const toControl = controlPortOf(targetHandle);
  if ((fromControl === null) !== (toControl === null))
    return "Connect data ports to data ports, or control ports to control ports.";
  const control = fromControl !== null;
  const outputs = control
    ? controlPortsOf(sourceEntry.manifest).outputs.map(controlHandleId)
    : Object.keys(sourceEntry.manifest.outputs);
  const inputs = control
    ? controlPortsOf(targetEntry.manifest).inputs.map(controlHandleId)
    : Object.keys(targetEntry.manifest.inputs);
  if (!outputs.includes(sourceHandle) || !inputs.includes(targetHandle))
    return "That port is no longer available. Choose another port.";
  const duplicate = graph.edges.some(
    (edge) =>
      edge.kind === (control ? "control" : "data") &&
      edge.from.nodeId === source &&
      edge.to.nodeId === target &&
      edge.from.port === (control ? fromControl : sourceHandle) &&
      edge.to.port === (control ? toControl : targetHandle),
  );
  if (duplicate) return "These ports are already connected.";
  if (
    !control &&
    targetEntry.manifest.inputs[targetHandle]?.multiple !== true &&
    graph.edges.some(
      (edge) => edge.kind === "data" && edge.to.nodeId === target && edge.to.port === targetHandle,
    )
  )
    return "This input already has a connection. Disconnect it first to replace it.";
  // Schema compatibility and structured loops remain the runtime compiler's authority.
  return null;
}
