import { describe, expect, it } from "vitest";

import type { NodeManifest } from "@zet-harness/plugin-api";

import {
  GRAPH_JSON_VERSION,
  type GraphJsonV1,
} from "./graph-json-v1.js";
import {
  type NodeManifestResolver,
  validateGraphJsonV1Semantics,
} from "./graph-json-v1-semantic-validator.js";

function manifest(type: string, version: string): NodeManifest {
  return {
    type,
    version,
    title: `${type}@${version}`,
    inputs: {},
    outputs: {},
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

const manifests = [manifest("builtin.start", "1.0.0"), manifest("builtin.finish", "2.0.0")];

const resolver: NodeManifestResolver = {
  getManifest(type, version) {
    return manifests.find((item) => item.type === type && item.version === version);
  },
};

function validGraph(): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "semantic.example",
    revisionId: "rev-001",
    inputs: [{ id: "prompt", schema: { type: "string" } }],
    outputs: [
      {
        id: "result",
        schema: { type: "string" },
        source: { nodeId: "finish", port: "text" },
      },
    ],
    nodes: [
      { id: "start", type: "builtin.start", version: "1.0.0", config: {} },
      { id: "finish", type: "builtin.finish", version: "2.0.0", config: {} },
    ],
    edges: [
      {
        id: "start-finish",
        kind: "control",
        from: { nodeId: "start" },
        to: { nodeId: "finish" },
      },
    ],
    entrypoints: [{ id: "default", nodeId: "start" }],
  };
}

function duplicateAt<T extends { readonly id: string }>(values: readonly T[]): readonly T[] {
  return [...values, values[0]!];
}

describe("Graph JSON v1 semantic ID and node resolution validation", () => {
  it("accepts unique semantic IDs and exactly resolved node versions", () => {
    expect(validateGraphJsonV1Semantics(validGraph(), resolver)).toBe(true);
  });

  it("rejects duplicate IDs within every semantic namespace", () => {
    const base = validGraph();

    expect(validateGraphJsonV1Semantics({ ...base, inputs: duplicateAt(base.inputs) }, resolver)).toBe(false);
    expect(validateGraphJsonV1Semantics({ ...base, outputs: duplicateAt(base.outputs) }, resolver)).toBe(false);
    expect(validateGraphJsonV1Semantics({ ...base, nodes: duplicateAt(base.nodes) }, resolver)).toBe(false);
    expect(validateGraphJsonV1Semantics({ ...base, edges: duplicateAt(base.edges) }, resolver)).toBe(false);
    expect(
      validateGraphJsonV1Semantics(
        { ...base, entrypoints: duplicateAt(base.entrypoints) },
        resolver,
      ),
    ).toBe(false);
  });

  it("allows the same text ID in different semantic namespaces", () => {
    const graph = validGraph();
    const crossNamespace: GraphJsonV1 = {
      ...graph,
      inputs: [{ id: "start", schema: { type: "string" } }],
    };

    expect(validateGraphJsonV1Semantics(crossNamespace, resolver)).toBe(true);
  });

  it("requires an exact node type and version match", () => {
    const graph = validGraph();
    const wrongVersion: GraphJsonV1 = {
      ...graph,
      nodes: [
        graph.nodes[0]!,
        { ...graph.nodes[1]!, version: "2.0.1" },
      ],
    };
    const missingType: GraphJsonV1 = {
      ...graph,
      nodes: [
        graph.nodes[0]!,
        { ...graph.nodes[1]!, type: "missing.finish" },
      ],
    };

    expect(validateGraphJsonV1Semantics(wrongVersion, resolver)).toBe(false);
    expect(validateGraphJsonV1Semantics(missingType, resolver)).toBe(false);
  });

  it("does not absorb port or graph-reference validation", () => {
    const graph = validGraph();
    const unresolvedReferences: GraphJsonV1 = {
      ...graph,
      outputs: [
        {
          ...graph.outputs[0]!,
          source: { nodeId: "does-not-exist", port: "missing" },
        },
      ],
      edges: [
        {
          id: "unknown-edge",
          kind: "data",
          from: { nodeId: "also-missing", port: "x" },
          to: { nodeId: "finish", port: "not-a-real-port" },
        },
      ],
      entrypoints: [{ id: "default", nodeId: "missing-entry" }],
    };

    expect(validateGraphJsonV1Semantics(unresolvedReferences, resolver)).toBe(true);
  });
});
