import { describe, expect, it } from "vitest";

import type { NodeInputPort, NodeManifest, NodeOutputPort } from "@zet-harness/plugin-api";

import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "./graph-json-v1.js";
import {
  checkGraphJsonV1SecretBindings,
  validateGraphJsonV1SecretBindings,
} from "./graph-json-v1-secret-bindings.js";
import {
  type NodeManifestResolver,
  validateGraphJsonV1Semantics,
} from "./graph-json-v1-semantic-validator.js";

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
      recovery: "rerun",
      executionMode: "in-process",
      retry: { maxAttempts: 1 },
      requiredCapabilities: [],
    },
  };
}

const stringPort = { schema: { type: "string" } } as const;

const manifests: readonly NodeManifest[] = [
  manifest("source", {}, { value: stringPort }),
  manifest(
    "secret-sink",
    {
      apiKey: { ...stringPort, required: true, secret: true },
      note: stringPort,
    },
    { result: stringPort },
  ),
  manifest("ordinary-sink", { value: { ...stringPort, required: true } }, { result: stringPort }),
];

const resolver: NodeManifestResolver = {
  getManifest(type, version) {
    return version === "1.0.0" ? manifests.find((item) => item.type === type) : undefined;
  },
};

function secretSinkGraph(binding?: GraphJsonV1["nodes"][number]["bindings"]): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "secret-bindings.test",
    revisionId: "rev-001",
    inputs: [{ id: "public-input", schema: { type: "string" } }],
    outputs: [
      {
        id: "result",
        schema: { type: "string" },
        source: { nodeId: "sink", port: "result" },
      },
    ],
    nodes: [
      {
        id: "sink",
        type: "secret-sink",
        version: "1.0.0",
        config: {},
        ...(binding === undefined ? {} : { bindings: binding }),
      },
    ],
    edges: [],
    entrypoints: [{ id: "default", nodeId: "sink" }],
  };
}

describe("Graph JSON v1 secret-only binding validation", () => {
  it("accepts an opaque secret reference for a secret-only input", () => {
    const graph = secretSinkGraph([
      { kind: "secret", port: "apiKey", secretRef: "vault://project/publisher-key" },
    ]);

    expect(validateGraphJsonV1Semantics(graph, resolver)).toBe(true);
    expect(checkGraphJsonV1SecretBindings(graph, resolver)).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("rejects a literal for a secret-only input without echoing the literal value", () => {
    const secretValue = "SUPER_SECRET_LITERAL_DO_NOT_ECHO";
    const graph = secretSinkGraph([{ kind: "literal", port: "apiKey", value: secretValue }]);

    expect(validateGraphJsonV1Semantics(graph, resolver)).toBe(true);

    const result = checkGraphJsonV1SecretBindings(graph, resolver);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_SECRET_REFERENCE_REQUIRED",
        nodeId: "sink",
        port: "apiKey",
        sourceKind: "literal",
      }),
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain(secretValue);
  });

  it("rejects forwarding a public graph input into a secret-only input", () => {
    const graph = secretSinkGraph([
      { kind: "graph-input", port: "apiKey", input: "public-input" },
    ]);

    expect(validateGraphJsonV1Semantics(graph, resolver)).toBe(true);
    expect(checkGraphJsonV1SecretBindings(graph, resolver).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_SECRET_REFERENCE_REQUIRED",
        nodeId: "sink",
        port: "apiKey",
        sourceKind: "graph-input",
      }),
    ]);
  });

  it("rejects node data edges into secret-only inputs", () => {
    const graph: GraphJsonV1 = {
      ...secretSinkGraph(),
      nodes: [
        { id: "source", type: "source", version: "1.0.0", config: {} },
        { id: "sink", type: "secret-sink", version: "1.0.0", config: {} },
      ],
      edges: [
        {
          id: "source-secret",
          kind: "data",
          from: { nodeId: "source", port: "value" },
          to: { nodeId: "sink", port: "apiKey" },
        },
      ],
      entrypoints: [{ id: "default", nodeId: "source" }],
    };

    expect(validateGraphJsonV1Semantics(graph, resolver)).toBe(true);
    expect(checkGraphJsonV1SecretBindings(graph, resolver).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_SECRET_REFERENCE_REQUIRED",
        nodeId: "sink",
        port: "apiKey",
        sourceKind: "data-edge",
        edgeId: "source-secret",
      }),
    ]);
  });

  it("does not guess secrets on ordinary ports or ban opaque secret refs there", () => {
    const literalGraph: GraphJsonV1 = {
      ...secretSinkGraph(),
      nodes: [
        {
          id: "sink",
          type: "ordinary-sink",
          version: "1.0.0",
          config: {},
          bindings: [{ kind: "literal", port: "value", value: "password-looking-text" }],
        },
      ],
      outputs: [
        {
          id: "result",
          schema: { type: "string" },
          source: { nodeId: "sink", port: "result" },
        },
      ],
    };
    const secretRefGraph: GraphJsonV1 = {
      ...literalGraph,
      nodes: [
        {
          ...literalGraph.nodes[0]!,
          bindings: [{ kind: "secret", port: "value", secretRef: "vault://ordinary/value" }],
        },
      ],
    };

    expect(validateGraphJsonV1SecretBindings(literalGraph, resolver)).toBe(true);
    expect(validateGraphJsonV1SecretBindings(secretRefGraph, resolver)).toBe(true);
  });

  it("leaves required-input/cardinality and unknown-port ownership in 2.7", () => {
    const missingRequired = secretSinkGraph();
    const unknownPort = secretSinkGraph([
      { kind: "literal", port: "missing-port", value: "not-a-secret-rule" },
    ]);

    expect(validateGraphJsonV1Semantics(missingRequired, resolver)).toBe(false);
    expect(validateGraphJsonV1SecretBindings(missingRequired, resolver)).toBe(true);

    expect(validateGraphJsonV1Semantics(unknownPort, resolver)).toBe(false);
    expect(validateGraphJsonV1SecretBindings(unknownPort, resolver)).toBe(true);
  });

  it("reports unresolved manifests only as a stage prerequisite failure", () => {
    const graph: GraphJsonV1 = {
      ...secretSinkGraph(),
      nodes: [{ id: "missing", type: "missing", version: "1.0.0", config: {} }],
      outputs: [],
      entrypoints: [{ id: "default", nodeId: "missing" }],
    };

    expect(checkGraphJsonV1SecretBindings(graph, resolver)).toEqual({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_SECRET_BINDING_PREREQUISITE_FAILED",
          message: "Node 'missing' must resolve before 2.15 secret-only binding validation.",
          nodeId: "missing",
        },
      ],
    });
  });
});
