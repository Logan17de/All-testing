"use client";
import "@xyflow/react/dist/style.css";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import { harnessNodeTypes, type HarnessFlowNode } from "../harness-node";
import { controlHandleId, type GraphDocument } from "../../lib/graph-document";
export default function ChatGraphCanvas({ graph }: { graph: GraphDocument }) {
  const nodes: HarnessFlowNode[] = graph.nodes.map((node, index) => ({
    id: node.id,
    type: "harness",
    position: graph.editor?.nodes?.[node.id]?.position ?? {
      x: (index % 2) * 300,
      y: Math.floor(index / 2) * 150,
    },
    data: {
      title: node.id,
      type: node.type,
      inputs: graph.edges
        .filter((e) => e.kind === "data" && e.to.nodeId === node.id)
        .map((e) => e.to.port!)
        .filter(Boolean),
      outputs: graph.edges
        .filter((e) => e.kind === "data" && e.from.nodeId === node.id)
        .map((e) => e.from.port!)
        .filter(Boolean),
      controlInputs: graph.edges
        .filter((e) => e.kind === "control" && e.to.nodeId === node.id)
        .map((e) => e.to.port),
      controlOutputs: graph.edges
        .filter((e) => e.kind === "control" && e.from.nodeId === node.id)
        .map((e) => e.from.port),
      diagnostics: [],
      readOnly: true,
    },
  }));
  const edges = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.from.nodeId,
    target: edge.to.nodeId,
    sourceHandle: edge.kind === "control" ? controlHandleId(edge.from.port) : edge.from.port,
    targetHandle: edge.kind === "control" ? controlHandleId(edge.to.port) : edge.to.port,
  }));
  return (
    <div style={{ height: 420, minWidth: 0 }} aria-label="Connected graph preview">
      <ReactFlow
        key={`${graph.graphId}:${graph.revisionId}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={harnessNodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
