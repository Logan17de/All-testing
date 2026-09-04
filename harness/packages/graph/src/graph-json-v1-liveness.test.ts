import { describe, expect, it } from "vitest";

import type { NodeInputPort, NodeManifest, NodeOutputPort } from "@zet-harness/plugin-api";

import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "./graph-json-v1.js";
import {
  checkGraphJsonV1Liveness,
  validateGraphJsonV1Liveness,
} from "./graph-json-v1-liveness.js";
import { validateGraphJsonV1PortCompatibility } from "./graph-json-v1-port-compatibility.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

function manifest(
  type: string,
  inputs: Readonly<Record<string, NodeInputPort>> = {},
  outputs: Readonly<Record<string, NodeOutputPort>> = {},
): NodeManifest {
  return {
    type,
    version: "1.0.0",
    title: type,
    inputs,
    outputs,
    configSchema: { type: "object" },
    behavior: {
      primitiveFamily: "pure",
      determinism: "deterministic",
      effect: "none",
      idempotency: "not-applicable",
      recovery: "not-applicable",
      executionMode: "in-process",
      requiredCapabilities: [],
    },
  };
}

const stringOutput = { value: { schema: { type: "string" } } } as const;
const stringInput = { value: { schema: { type: "string" }, required: true } } as const;

const manifests = [
  manifest("source.string", {}, stringOutput),
  manifest("source.impossible", {}, { value: { schema: false } }),
  manifest("pass.string", stringInput, stringOutput),
  manifest("sink.string", stringInput, {}),
  manifest("sink.any", { value: { schema: true, required: true } }, {}),
];

const resolver: NodeManifestResolver = {
  getManifest(type, version) {
    return version === "1.0.0" ? manifests.find((item) => item.type === type) : undefined;
  },
};

function node(id: string, type: string) {
  return { id, type, version: "1.0.0", config: {} } as const;
}

function dataEdge(id: string, from: string, to: string) {
  return {
    id,
    kind: "data",
    from: { nodeId: from, port: "value" },
    to: { nodeId: to, port: "value" },
  } as const;
}

function baseGraph(): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "liveness.example",
    revisionId: "rev-001",
    inputs: [],
    outputs: [],
    nodes: [node("start", "source.string"), node("middle", "pass.string"), node("end", "sink.string")],
    edges: [dataEdge("start-middle", "start", "middle"), dataEdge("middle-end", "middle", "end")],
    entrypoints: [{ id: "default", nodeId: "start" }],
  };
}

describe("Graph JSON v1 reachability/liveness", () => {
  it("accepts a forward-reachable data-flow graph", () => {
    const result = checkGraphJsonV1Liveness(baseGraph(), resolver);

    expect(result.valid).toBe(true);
    expect(result.reachableNodeIds).toEqual(["start", "middle", "end"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("treats control edges as potential reachability without interpreting control ports", () => {
    const graph: GraphJsonV1 = {
      ...baseGraph(),
      edges: [
        dataEdge("start-middle", "start", "middle"),
        {
          id: "middle-end-control",
          kind: "control",
          from: { nodeId: "middle", port: "future-route" },
          to: { nodeId: "end", port: "future-lane" },
        },
      ],
    };

    expect(validateGraphJsonV1Liveness(graph, resolver)).toBe(true);
  });

  it("rejects nodes that are not potentially reachable from any entrypoint", () => {
    const graph = baseGraph();
    const withIsland: GraphJsonV1 = {
      ...graph,
      nodes: [...graph.nodes, node("island", "source.string")],
    };

    expect(checkGraphJsonV1Liveness(withIsland, resolver)).toMatchObject({
      valid: false,
      reachableNodeIds: ["start", "middle", "end"],
      diagnostics: [{ code: "GRAPH_NODE_UNREACHABLE", nodeId: "island" }],
    });
  });

  it("allows disconnected components when each has its own entrypoint", () => {
    const graph: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "liveness.multiple-entrypoints",
      revisionId: "rev-001",
      inputs: [],
      outputs: [],
      nodes: [node("a", "source.string"), node("b", "source.string")],
      edges: [],
      entrypoints: [
        { id: "a-entry", nodeId: "a" },
        { id: "b-entry", nodeId: "b" },
      ],
    };

    expect(validateGraphJsonV1Liveness(graph, resolver)).toBe(true);
  });

  it("rejects an upstream dependency that an entrypoint cannot reach", () => {
    const graph: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "liveness.entrypoint-upstream",
      revisionId: "rev-001",
      inputs: [],
      outputs: [],
      nodes: [node("source", "source.string"), node("target", "sink.string")],
      edges: [dataEdge("source-target", "source", "target")],
      entrypoints: [{ id: "default", nodeId: "target" }],
    };

    expect(checkGraphJsonV1Liveness(graph, resolver)).toMatchObject({
      valid: false,
      reachableNodeIds: ["target"],
      diagnostics: [{ code: "GRAPH_NODE_UNREACHABLE", nodeId: "source" }],
    });
  });

  it("reports graph outputs produced by unreachable nodes", () => {
    const graph = baseGraph();
    const withOutputIsland: GraphJsonV1 = {
      ...graph,
      nodes: [...graph.nodes, node("island", "source.string")],
      outputs: [
        {
          id: "orphan-result",
          schema: { type: "string" },
          source: { nodeId: "island", port: "value" },
        },
      ],
    };

    const result = checkGraphJsonV1Liveness(withOutputIsland, resolver);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "GRAPH_NODE_UNREACHABLE", nodeId: "island" }),
        expect.objectContaining({
          code: "GRAPH_OUTPUT_UNREACHABLE",
          nodeId: "island",
          graphPortId: "orphan-result",
        }),
      ]),
    );
  });

  it("does not reject reachable cycles because cycle rejection belongs to 2.10", () => {
    const graph: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "liveness.cycle-boundary",
      revisionId: "rev-001",
      inputs: [],
      outputs: [],
      nodes: [node("a", "pass.string"), node("b", "pass.string")],
      edges: [dataEdge("a-b", "a", "b"), dataEdge("b-a", "b", "a")],
      entrypoints: [{ id: "default", nodeId: "a" }],
    };

    const result = checkGraphJsonV1Liveness(graph, resolver);

    expect(result.valid).toBe(true);
    expect(result.reachableNodeIds).toEqual(["a", "b"]);
  });

  it("keeps impossible-source compatibility in 2.8 but rejects live impossible data flow in 2.9", () => {
    const graph: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "liveness.false-source",
      revisionId: "rev-001",
      inputs: [],
      outputs: [],
      nodes: [node("source", "source.impossible"), node("target", "sink.any")],
      edges: [dataEdge("source-target", "source", "target")],
      entrypoints: [{ id: "default", nodeId: "source" }],
    };

    expect(validateGraphJsonV1PortCompatibility(graph, resolver)).toBe(true);
    expect(checkGraphJsonV1Liveness(graph, resolver)).toMatchObject({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_DATA_SOURCE_IMPOSSIBLE",
          edgeId: "source-target",
          nodeId: "source",
          port: "value",
        },
      ],
    });
  });

  it("rejects a reachable public graph output backed by an impossible source", () => {
    const graph: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "liveness.false-output",
      revisionId: "rev-001",
      inputs: [],
      outputs: [
        {
          id: "result",
          schema: true,
          source: { nodeId: "source", port: "value" },
        },
      ],
      nodes: [node("source", "source.impossible")],
      edges: [],
      entrypoints: [{ id: "default", nodeId: "source" }],
    };

    expect(checkGraphJsonV1Liveness(graph, resolver)).toMatchObject({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_OUTPUT_SOURCE_IMPOSSIBLE",
          nodeId: "source",
          port: "value",
          graphPortId: "result",
        },
      ],
    });
  });

  it("rejects a reachable graph-input binding whose source schema is impossible", () => {
    const graph: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "liveness.false-input",
      revisionId: "rev-001",
      inputs: [{ id: "never", schema: false }],
      outputs: [],
      nodes: [
        {
          ...node("target", "sink.any"),
          bindings: [{ kind: "graph-input", port: "value", input: "never" }],
        },
      ],
      edges: [],
      entrypoints: [{ id: "default", nodeId: "target" }],
    };

    expect(checkGraphJsonV1Liveness(graph, resolver)).toMatchObject({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_INPUT_SOURCE_IMPOSSIBLE",
          nodeId: "target",
          port: "value",
          graphPortId: "never",
        },
      ],
    });
  });

  it("is deterministic in graph source order", () => {
    const graph: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "liveness.deterministic",
      revisionId: "rev-001",
      inputs: [],
      outputs: [],
      nodes: [node("z", "source.string"), node("a", "source.string")],
      edges: [],
      entrypoints: [],
    };

    expect(checkGraphJsonV1Liveness(graph, resolver).diagnostics).toEqual([
      expect.objectContaining({ code: "GRAPH_NODE_UNREACHABLE", nodeId: "z" }),
      expect.objectContaining({ code: "GRAPH_NODE_UNREACHABLE", nodeId: "a" }),
    ]);
  });
});
