import { describe, expect, it } from "vitest";

import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "./graph-json-v1.js";

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
  ],
  edges: [
    {
      id: "data.prepare-finish",
      kind: "data",
      from: { nodeId: "prepare", port: "text" },
      to: { nodeId: "finish", port: "text" },
    },
    {
      id: "control.prepare-finish",
      kind: "control",
      from: { nodeId: "prepare", port: "success" },
      to: { nodeId: "finish" },
    },
  ],
  entrypoints: [{ id: "default", nodeId: "prepare" }],
  policies: {
    maxNodeExecutions: 10,
    maxParallelism: 2,
    maxWallTimeMs: 30_000,
    capabilities: {
      allow: ["secrets:read"],
      deny: ["network:http"],
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

describe("Graph JSON v1", () => {
  it("pins node type versions and keeps data/control edges distinct", () => {
    expect(exampleGraph.nodes.map((node) => node.version)).toEqual(["1.0.0", "2.1.0"]);
    expect(exampleGraph.edges.map((edge) => edge.kind)).toEqual(["data", "control"]);
  });

  it("represents literals, public inputs, and secrets as distinct binding kinds", () => {
    expect(exampleGraph.nodes[0]?.bindings?.map((binding) => binding.kind)).toEqual([
      "graph-input",
      "literal",
      "secret",
    ]);
  });

  it("remains plain JSON with editor metadata isolated in its own bucket", () => {
    const roundTrip = JSON.parse(JSON.stringify(exampleGraph)) as GraphJsonV1;

    expect(roundTrip.schemaVersion).toBe(1);
    expect(roundTrip.editor?.nodes?.prepare?.position).toEqual({ x: 100, y: 200 });
    expect(roundTrip.nodes[0]).not.toHaveProperty("position");
  });
});
