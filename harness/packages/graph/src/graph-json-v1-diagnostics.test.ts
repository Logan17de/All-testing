import { describe, expect, it } from "vitest";

import type { NodeInputPort, NodeManifest } from "@zet-harness/plugin-api";

import {
  checkGraphJsonV1Diagnostics,
  type GraphJsonV1DiagnosticContext,
} from "./graph-json-v1-diagnostics.js";
import { GRAPH_JSON_VERSION, type GraphEdgeV1, type GraphJsonV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

const stringPort = { schema: { type: "string" } } as const;

function manifest(
  type: string,
  inputs: Readonly<Record<string, NodeInputPort>> = {},
): NodeManifest {
  return {
    type,
    version: "1.0.0",
    title: type,
    inputs,
    outputs: {},
    configSchema: { type: "object" },
    behavior: {
      primitiveFamily: "pure",
      determinism: "deterministic",
      effect: "none",
      idempotency: "not-applicable",
      recovery: "not-applicable",
      executionMode: "none",
      requiredCapabilities: [],
    },
  };
}

const manifests = [
  manifest("builtin.noop"),
  manifest("builtin.secret", {
    apiKey: { ...stringPort, required: true, secret: true },
  }),
];

const resolver: NodeManifestResolver = {
  getManifest(type, version) {
    return manifests.find((item) => item.type === type && item.version === version);
  },
};

function context(granted: readonly string[] = []): GraphJsonV1DiagnosticContext {
  return {
    resolver,
    capabilityAuthority: { granted },
  };
}

function baseGraph(): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "diagnostics.example",
    revisionId: "rev-001",
    inputs: [],
    outputs: [],
    nodes: [{ id: "start", type: "builtin.noop", version: "1.0.0", config: {} }],
    edges: [],
    entrypoints: [{ id: "default", nodeId: "start" }],
  };
}

describe("Graph JSON v1 unified diagnostics", () => {
  it("normalizes shape failures into stable Harness codes and JSON Pointer paths", () => {
    const result = checkGraphJsonV1Diagnostics(
      {
        schemaVersion: GRAPH_JSON_VERSION,
        graphId: "missing-fields",
      },
      context(),
    );

    expect(result.valid).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((diagnostic) => diagnostic.stage === "shape")).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "GRAPH_SHAPE_REQUIRED_PROPERTY",
        path: "/revisionId",
      }),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain("instancePath");
    expect(JSON.stringify(result.diagnostics)).not.toContain("keyword");
    expect(JSON.stringify(result.diagnostics)).not.toContain("params");
  });

  it("returns semantic source errors with stable paths and stops derivative stages", () => {
    const graph = baseGraph();
    const result = checkGraphJsonV1Diagnostics(
      {
        ...graph,
        nodes: [graph.nodes[0]!, { ...graph.nodes[0]! }],
      },
      context(),
    );

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "GRAPH_SEMANTIC_DUPLICATE_ID",
        stage: "semantic",
        nodeId: "start",
        path: "/nodes/1/id",
      }),
    );
    expect(result.diagnostics.every((diagnostic) => diagnostic.stage === "semantic")).toBe(true);
  });

  it("anchors secret-only failures to the exact binding without leaking source material", () => {
    const literalSecret = "literal-secret-must-never-appear-in-diagnostics";
    const graph: GraphJsonV1 = {
      ...baseGraph(),
      nodes: [
        {
          id: "secret",
          type: "builtin.secret",
          version: "1.0.0",
          config: {},
          bindings: [{ kind: "literal", port: "apiKey", value: literalSecret }],
        },
      ],
      entrypoints: [{ id: "default", nodeId: "secret" }],
    };

    const result = checkGraphJsonV1Diagnostics(graph, context());
    const secretDiagnostic = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "GRAPH_SECRET_REFERENCE_REQUIRED",
    );

    expect(result.valid).toBe(false);
    expect(secretDiagnostic).toEqual(
      expect.objectContaining({
        stage: "secret-bindings",
        nodeId: "secret",
        port: "apiKey",
        path: "/nodes/0/bindings/0",
      }),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain(literalSecret);
  });

  it("preserves multi-node and multi-edge references for cycle diagnostics", () => {
    const edges: readonly GraphEdgeV1[] = [
      {
        id: "a-b",
        kind: "control",
        from: { nodeId: "a" },
        to: { nodeId: "b" },
      },
      {
        id: "b-a",
        kind: "control",
        from: { nodeId: "b" },
        to: { nodeId: "a" },
      },
    ];
    const graph: GraphJsonV1 = {
      ...baseGraph(),
      nodes: [
        { id: "a", type: "builtin.noop", version: "1.0.0", config: {} },
        { id: "b", type: "builtin.noop", version: "1.0.0", config: {} },
      ],
      edges,
      entrypoints: [{ id: "default", nodeId: "a" }],
    };

    const result = checkGraphJsonV1Diagnostics(graph, context());
    const cycle = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "GRAPH_CYCLE_DETECTED",
    );

    expect(cycle?.stage).toBe("acyclicity");
    expect(cycle?.path).toBeUndefined();
    expect(cycle?.relatedNodeIds).toEqual(expect.arrayContaining(["a", "b"]));
    expect(cycle?.relatedEdgeIds).toEqual(expect.arrayContaining(["a-b", "b-a"]));
  });

  it("anchors graph policy diagnostics to policy source paths", () => {
    const graph: GraphJsonV1 = {
      ...baseGraph(),
      policies: {
        capabilities: {
          required: ["fs.write"],
        },
      },
    };

    const result = checkGraphJsonV1Diagnostics(graph, context());
    const denied = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "GRAPH_CAPABILITY_REQUIRED_UNAVAILABLE",
    );

    expect(denied).toEqual(
      expect.objectContaining({
        stage: "capability-policy",
        path: "/policies/capabilities/required",
      }),
    );
  });

  it("keeps unified diagnostic ordering deterministic", () => {
    const graph: GraphJsonV1 = {
      ...baseGraph(),
      policies: {
        capabilities: {
          required: ["fs.write"],
        },
      },
    };

    expect(checkGraphJsonV1Diagnostics(graph, context())).toEqual(
      checkGraphJsonV1Diagnostics(graph, context()),
    );
  });
});
