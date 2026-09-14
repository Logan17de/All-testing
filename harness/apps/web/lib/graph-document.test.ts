import { describe, expect, it } from "vitest";

import {
  addDataEdge,
  addNode,
  emptyGraph,
  finalizeGraph,
  freePosition,
  NODE_FOOTPRINT,
  nextNodeId,
  parseGraphDocument,
  removeNode,
  setLiteral,
  type GraphDocument,
  type PaletteEntry,
} from "./graph-document";

const text = { schema: { type: "string" } } as const;

function entry(type: string): PaletteEntry {
  return {
    pluginId: "com.example.text",
    isolated: false,
    manifest: {
      type,
      version: "1",
      title: type,
      inputs: { input: text },
      outputs: { output: text },
      configSchema: { type: "object" },
      behavior: {
        primitiveFamily: "pure",
        effect: "none",
        idempotency: "not-applicable",
        recovery: "rerun",
        requiredCapabilities: [],
      },
    },
  };
}

const PALETTE = [entry("text.upper"), entry("text.exclaim")];

/** upper-1 → exclaim-1, with a literal typed into upper-1's input. */
function pipeline(): GraphDocument {
  let graph = emptyGraph("g");
  graph = addNode(graph, "upper-1", "text.upper", "1", { x: 0, y: 0 });
  graph = addNode(graph, "exclaim-1", "text.exclaim", "1", { x: 300, y: 0 });
  graph = setLiteral(graph, "upper-1", "input", "hello");
  return addDataEdge(
    graph,
    { nodeId: "upper-1", port: "output" },
    { nodeId: "exclaim-1", port: "input" },
  );
}

describe("placing nodes", () => {
  it("uses the requested point on an empty canvas", () => {
    expect(freePosition(emptyGraph("g"), { x: 10.4, y: 20.6 })).toEqual({ x: 10, y: 21 });
  });

  it("never stacks nodes added one after another at the same point", () => {
    let graph = emptyGraph("g");
    for (let index = 0; index < 6; index += 1) {
      const id = nextNodeId(graph, "text.upper");
      graph = addNode(graph, id, "text.upper", "1", freePosition(graph, { x: 0, y: 0 }));
    }
    const positions = Object.values(graph.editor?.nodes ?? {}).map((layout) => layout.position);
    expect(positions).toHaveLength(6);
    for (const [index, a] of positions.entries()) {
      for (const b of positions.slice(index + 1)) {
        const overlaps =
          Math.abs((a?.x ?? 0) - (b?.x ?? 0)) < NODE_FOOTPRINT.width &&
          Math.abs((a?.y ?? 0) - (b?.y ?? 0)) < NODE_FOOTPRINT.height;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("numbers node ids per type without reusing a taken id", () => {
    const graph = addNode(emptyGraph("g"), "upper-1", "text.upper", "1", { x: 0, y: 0 });
    expect(nextNodeId(graph, "text.upper")).toBe("upper-2");
    expect(nextNodeId(graph, "text.exclaim")).toBe("exclaim-1");
  });
});

describe("editing connections", () => {
  it("drops a typed literal once an edge feeds the same port", () => {
    let graph = addNode(emptyGraph("g"), "a", "text.upper", "1", { x: 0, y: 0 });
    graph = addNode(graph, "b", "text.exclaim", "1", { x: 0, y: 0 });
    graph = setLiteral(graph, "b", "input", "typed");
    graph = addDataEdge(graph, { nodeId: "a", port: "output" }, { nodeId: "b", port: "input" });
    expect(graph.nodes.find((node) => node.id === "b")?.bindings).toBeUndefined();
  });

  it("ignores a duplicate edge", () => {
    const graph = pipeline();
    const again = addDataEdge(
      graph,
      { nodeId: "upper-1", port: "output" },
      { nodeId: "exclaim-1", port: "input" },
    );
    expect(again).toBe(graph);
  });

  it("removes a node together with its edges and layout", () => {
    const graph = removeNode(pipeline(), "exclaim-1");
    expect(graph.nodes.map((node) => node.id)).toEqual(["upper-1"]);
    expect(graph.edges).toEqual([]);
    expect(Object.keys(graph.editor?.nodes ?? {})).toEqual(["upper-1"]);
  });
});

describe("finalizing a graph for the compiler", () => {
  it("derives entrypoints from roots and outputs from sinks", () => {
    const graph = finalizeGraph(pipeline(), PALETTE);
    expect(graph.entrypoints).toEqual([{ id: "entry_upper-1", nodeId: "upper-1" }]);
    expect(graph.outputs).toEqual([
      {
        id: "exclaim-1_output",
        schema: { type: "string" },
        source: { nodeId: "exclaim-1", port: "output" },
      },
    ]);
    expect(graph.options).toEqual({ defaultEntrypoint: "entry_upper-1" });
  });

  it("keeps a literal on an unfed port", () => {
    const upper = finalizeGraph(pipeline(), PALETTE).nodes.find((node) => node.id === "upper-1");
    expect(upper?.bindings).toEqual([{ kind: "literal", port: "input", value: "hello" }]);
  });

  it("raises the execution bound to cover every node", () => {
    const graph = finalizeGraph(
      { ...pipeline(), policies: { maxNodeExecutions: 1, maxParallelism: 2 } },
      PALETTE,
    );
    expect(graph.policies?.maxNodeExecutions).toBe(2);
    expect(graph.policies?.maxParallelism).toBe(2);
  });
});

describe("reading an untrusted document", () => {
  it("rejects anything that is not Graph JSON v1", () => {
    expect(parseGraphDocument(null)).toBeUndefined();
    expect(parseGraphDocument([])).toBeUndefined();
    expect(parseGraphDocument({ schemaVersion: 2, graphId: "g", nodes: [], edges: [] })).toBe(
      undefined,
    );
    expect(parseGraphDocument({ schemaVersion: 1, graphId: "g", nodes: {}, edges: [] })).toBe(
      undefined,
    );
  });

  it("drops malformed nodes and edges instead of crashing the canvas", () => {
    const parsed = parseGraphDocument({
      schemaVersion: 1,
      graphId: "g",
      nodes: [
        { id: "ok", type: "text.upper", version: "1", config: "not-an-object" },
        { id: 7, type: "text.upper", version: "1" },
        "junk",
      ],
      edges: [
        { id: "e1", kind: "data", from: { nodeId: "ok", port: "output" }, to: { nodeId: "x" } },
        { id: "e2", kind: "control", from: { nodeId: "ok" }, to: { nodeId: "x" } },
        { id: "e3", kind: "teleport", from: { nodeId: "ok" }, to: { nodeId: "x" } },
      ],
      editor: { nodes: { ok: { position: { x: 1, y: 2 } } } },
    });
    expect(parsed?.nodes).toEqual([{ id: "ok", type: "text.upper", version: "1", config: {} }]);
    expect(parsed?.edges.map((edge) => edge.id)).toEqual(["e2"]);
    expect(parsed?.revisionId).toBe("draft");
    expect(parsed?.editor?.nodes?.["ok"]?.position).toEqual({ x: 1, y: 2 });
  });

  it("round-trips a document the editor produced", () => {
    const graph = finalizeGraph(pipeline(), PALETTE);
    expect(parseGraphDocument(JSON.parse(JSON.stringify(graph)) as unknown)).toEqual(graph);
  });
});
