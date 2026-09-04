import { describe, expect, it } from "vitest";

import { GRAPH_JSON_VERSION, type GraphJsonV1, type GraphSemanticsV1 } from "./graph-json-v1.js";

const exampleGraph = {
  schemaVersion: GRAPH_JSON_VERSION,
  graphId: "example.echo",
  revisionId: "rev-001",
  metadata: {
    title: "Echo workflow",
    labels: ["example", "deterministic"],
  },
  inputs: [
    {
      id: "message",
      schema: { type: "string" },
      required: true,
    },
  ],
  outputs: [
    {
      id: "result",
      schema: { type: "string" },
      source: { nodeId: "finish", port: "text" },
    },
  ],
  nodes: [
    {
      id: "prepare",
      type: "builtin.transform.prepare",
      version: "1.0.0",
      config: {},
      bindings: [
        {
          kind: "graph-input",
          port: "message",
          input: "message",
        },
        {
          kind: "literal",
          port: "prefix",
          value: "echo:",
        },
        {
          kind: "secret",
          port: "credential",
          secretRef: "secrets/example",
        },
      ],
    },
    {
      id: "finish",
      type: "builtin.transform.finish",
      version: "2.1.0",
      config: {},
    },
    {
      id: "audit",
      type: "builtin.effect.audit",
      version: "1.3.0",
      config: {},
    },
  ],
  edges: [
    {
      id: "data.prepare-finish",
      kind: "data",
      from: { nodeId: "prepare", port: "text" },
      to: { nodeId: "finish", port: "text" },
    },
    {
      id: "control.finish-audit",
      kind: "control",
      from: { nodeId: "finish", port: "success" },
      to: { nodeId: "audit" },
    },
  ],
  entrypoints: [{ id: "default", nodeId: "prepare" }],
  policies: {
    maxNodeExecutions: 10,
    maxParallelism: 2,
    maxWallTimeMs: 30_000,
    capabilities: {
      required: ["secrets:read"],
      optional: ["network:http"],
      deny: ["shell:run"],
    },
  },
  options: {
    defaultEntrypoint: "default",
  },
  editor: {
    viewport: { x: 10, y: 20, zoom: 1.25 },
    nodes: {
      prepare: { position: { x: 100, y: 200 } },
      finish: { position: { x: 420, y: 200 }, collapsed: true },
      audit: { position: { x: 720, y: 200 } },
    },
    annotations: [
      {
        id: "note-1",
        text: "Editor-only note",
        position: { x: 250, y: 100 },
      },
    ],
    data: {
      selectedPanel: "inspector",
    },
  },
} satisfies GraphJsonV1;

function semanticProjection(graph: GraphJsonV1): GraphSemanticsV1 {
  return {
    schemaVersion: graph.schemaVersion,
    inputs: graph.inputs,
    outputs: graph.outputs,
    nodes: graph.nodes,
    edges: graph.edges,
    entrypoints: graph.entrypoints,
    ...(graph.policies === undefined ? {} : { policies: graph.policies }),
    ...(graph.options === undefined ? {} : { options: graph.options }),
  };
}

describe("Graph JSON v1", () => {
  it("pins node type versions and keeps data/control edges distinct", () => {
    expect(exampleGraph.nodes.map((node) => node.version)).toEqual(["1.0.0", "2.1.0", "1.3.0"]);
    expect(exampleGraph.edges.map((edge) => edge.kind)).toEqual(["data", "control"]);
  });

  it("uses data edges for value flow without requiring duplicate control edges", () => {
    const dataEdge = exampleGraph.edges[0];
    const duplicateControlEdge = exampleGraph.edges.find(
      (edge) => edge.kind === "control" && edge.from.nodeId === "prepare" && edge.to.nodeId === "finish",
    );

    expect(dataEdge?.kind).toBe("data");
    expect(duplicateControlEdge).toBeUndefined();
  });

  it("represents literals, public inputs, and secrets as distinct binding kinds", () => {
    expect(exampleGraph.nodes[0]?.bindings?.map((binding) => binding.kind)).toEqual([
      "graph-input",
      "literal",
      "secret",
    ]);
  });

  it("treats graph capabilities as requests/self-restrictions rather than grants", () => {
    expect(exampleGraph.policies.capabilities).toEqual({
      required: ["secrets:read"],
      optional: ["network:http"],
      deny: ["shell:run"],
    });
    expect(exampleGraph.policies.capabilities).not.toHaveProperty("allow");
  });

  it("keeps document metadata/editor state outside the semantic hash domain", () => {
    const changedDocument: GraphJsonV1 = {
      ...exampleGraph,
      graphId: "copied.graph",
      revisionId: "rev-999",
      metadata: { title: "Renamed workflow" },
      editor: {
        ...exampleGraph.editor,
        viewport: { x: 999, y: 999, zoom: 0.5 },
      },
    };

    expect(semanticProjection(changedDocument)).toEqual(semanticProjection(exampleGraph));
  });

  it("remains plain JSON with editor metadata isolated in its own bucket", () => {
    const roundTrip = JSON.parse(JSON.stringify(exampleGraph)) as GraphJsonV1;

    expect(roundTrip.schemaVersion).toBe(1);
    expect(roundTrip.editor?.nodes?.prepare?.position).toEqual({ x: 100, y: 200 });
    expect(roundTrip.nodes[0]).not.toHaveProperty("position");
  });
});
