import { describe, expect, it } from "vitest";

import type { NodeInputPort, NodeManifest } from "@zet-harness/plugin-api";

import {
  checkGraphJsonV1Diagnostics,
  type GraphJsonV1DiagnosticContext,
} from "./graph-json-v1-diagnostics.js";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "./graph-json-v1.js";
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
    graphId: "golden.diagnostics",
    revisionId: "rev-001",
    inputs: [],
    outputs: [],
    nodes: [{ id: "start", type: "builtin.noop", version: "1.0.0", config: {} }],
    edges: [],
    entrypoints: [{ id: "default", nodeId: "start" }],
  };
}

describe("Graph JSON v1 golden diagnostics", () => {
  it("locks the exact shape diagnostic boundary", () => {
    const result = checkGraphJsonV1Diagnostics(
      {
        ...baseGraph(),
        unsupported: true,
      },
      context(),
    );

    expect(result).toEqual({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_SHAPE_ADDITIONAL_PROPERTY",
          message: "Graph JSON contains unsupported property 'unsupported'.",
          stage: "shape",
          path: "/unsupported",
        },
      ],
    });
  });

  it("locks the exact semantic diagnostic boundary and short-circuit", () => {
    const graph = baseGraph();
    const result = checkGraphJsonV1Diagnostics(
      {
        ...graph,
        nodes: [graph.nodes[0]!, { ...graph.nodes[0]! }],
      },
      context(),
    );

    expect(result).toEqual({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_SEMANTIC_DUPLICATE_ID",
          message: "Duplicate nodes id 'start' was already declared at index 0.",
          stage: "semantic",
          path: "/nodes/1/id",
          nodeId: "start",
        },
      ],
    });
  });

  it("locks compiler-facing diagnostic order, messages, paths, and related references", () => {
    const literalSecret = "golden-secret-value-must-never-leak";
    const graph: GraphJsonV1 = {
      ...baseGraph(),
      nodes: [
        { id: "a", type: "builtin.noop", version: "1.0.0", config: {} },
        { id: "b", type: "builtin.noop", version: "1.0.0", config: {} },
        {
          id: "secret",
          type: "builtin.secret",
          version: "1.0.0",
          config: {},
          bindings: [{ kind: "literal", port: "apiKey", value: literalSecret }],
        },
      ],
      edges: [
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
        {
          id: "b-secret",
          kind: "control",
          from: { nodeId: "b" },
          to: { nodeId: "secret" },
        },
      ],
      entrypoints: [{ id: "default", nodeId: "a" }],
      policies: {
        capabilities: {
          required: ["fs.write"],
        },
      },
    };

    const result = checkGraphJsonV1Diagnostics(graph, context());

    expect(result).toEqual({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_CYCLE_DETECTED",
          message:
            "Executable graph cycle detected across node(s): a, b. Arbitrary cycles are not executable in Harness v1.",
          stage: "acyclicity",
          relatedNodeIds: ["a", "b"],
          relatedEdgeIds: ["a-b", "b-a"],
        },
        {
          code: "GRAPH_CAPABILITY_REQUIRED_UNAVAILABLE",
          message:
            "Graph-required capability 'fs.write' is not present in external compile authority.",
          stage: "capability-policy",
          path: "/policies/capabilities/required",
        },
        {
          code: "GRAPH_SECRET_REFERENCE_REQUIRED",
          message:
            "Node 'secret' input 'apiKey' is secret-only and must use an opaque secret reference rather than a literal source.",
          stage: "secret-bindings",
          path: "/nodes/2/bindings/0",
          nodeId: "secret",
          port: "apiKey",
        },
      ],
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain(literalSecret);
  });

  it("is byte-for-byte deterministic across repeated golden evaluations", () => {
    const graph = baseGraph();
    const first = JSON.stringify(checkGraphJsonV1Diagnostics(graph, context()));
    const second = JSON.stringify(checkGraphJsonV1Diagnostics(structuredClone(graph), context()));

    expect(second).toBe(first);
  });
});
