import { describe, expect, it } from "vitest";

import { addDataEdge, addNode, emptyGraph, removeNode, setLiteral } from "../../lib/graph-document";
import { graphHistoryReducer, type GraphHistory } from "./graph-history";

function connectedGraph() {
  let graph = emptyGraph("history-test");
  graph = addNode(graph, "source", "text", "1", { x: 20, y: 30 });
  graph = addNode(graph, "target", "output", "1", { x: 300, y: 30 });
  graph = setLiteral(graph, "source", "input", "Keep this value");
  return addDataEdge(
    graph,
    { nodeId: "source", port: "text" },
    { nodeId: "target", port: "value" },
  );
}

describe("graph edit recovery", () => {
  it("restores the deleted node, bindings, connections, and position in one undo", () => {
    const graph = connectedGraph();
    const initial: GraphHistory = { past: [], present: graph, future: [] };
    const deleted = graphHistoryReducer(initial, {
      type: "edit",
      update: (current) => removeNode(current, "source"),
    });
    expect(deleted.present.nodes).toHaveLength(1);
    expect(deleted.present.edges).toHaveLength(0);
    const restored = graphHistoryReducer(deleted, { type: "undo" });
    expect(restored.present).toEqual(graph);
    expect(graphHistoryReducer(restored, { type: "redo" }).present).toEqual(deleted.present);
  });

  it("preserves history for a no-op and clears redo after a new edit", () => {
    const initial: GraphHistory = { past: [], present: connectedGraph(), future: [] };
    expect(graphHistoryReducer(initial, { type: "edit", update: (current) => current })).toBe(
      initial,
    );
    const deleted = graphHistoryReducer(initial, {
      type: "edit",
      update: (current) => removeNode(current, "source"),
    });
    const restored = graphHistoryReducer(deleted, { type: "undo" });
    const edited = graphHistoryReducer(restored, {
      type: "edit",
      update: (current) => setLiteral(current, "source", "input", "New value"),
    });
    expect(edited.future).toEqual([]);
    expect(graphHistoryReducer(edited, { type: "redo" })).toBe(edited);
  });

  it("keeps the latest 80 edits and does not grow without a limit", () => {
    let state: GraphHistory = { past: [], present: connectedGraph(), future: [] };
    for (let i = 0; i < 100; i++)
      state = graphHistoryReducer(state, {
        type: "edit",
        update: (current) => setLiteral(current, "source", "input", i),
      });
    expect(state.past).toHaveLength(80);
    for (let i = 0; i < 80; i++) state = graphHistoryReducer(state, { type: "undo" });
    expect(state.past).toHaveLength(0);
    expect(state.future).toHaveLength(80);
    expect(graphHistoryReducer(state, { type: "undo" })).toBe(state);
  });
});
