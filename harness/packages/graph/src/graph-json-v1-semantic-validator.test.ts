import { describe, expect, it } from "vitest";

import type {
  NodeInputPort,
  NodeManifest,
  NodeOutputPort,
} from "@zet-harness/plugin-api";

import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "./graph-json-v1.js";
import {
  type NodeManifestResolver,
  validateGraphJsonV1Semantics,
} from "./graph-json-v1-semantic-validator.js";

function manifest(
  type: string,
  version: string,
  inputs: Readonly<Record<string, NodeInputPort>> = {},
  outputs: Readonly<Record<string, NodeOutputPort>> = {},
): NodeManifest {
  return {
    type,
    version,
    title: `${type}@${version}`,
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

const stringPort = { schema: { type: "string" } } as const;

const manifests = [
  manifest("builtin.start", "1.0.0", {}, { text: stringPort }),
  manifest(
    "builtin.finish",
    "2.0.0",
    { text: { ...stringPort, required: true } },
    { text: stringPort },
  ),
  manifest("builtin.source2", "1.0.0", {}, { text: stringPort }),
  manifest(
    "builtin.collector",
    "1.0.0",
    { items: { ...stringPort, required: true, multiple: true } },
    { text: stringPort },
  ),
  manifest(
    "builtin.number-sink",
    "1.0.0",
    { value: { schema: { type: "number" }, required: true } },
    { text: stringPort },
  ),
  manifest(
    "builtin.secret-sink",
    "1.0.0",
    { apiKey: { ...stringPort, required: true, secret: true } },
    { text: stringPort },
  ),
];

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
        kind: "data",
        from: { nodeId: "start", port: "text" },
        to: { nodeId: "finish", port: "text" },
      },
    ],
    entrypoints: [{ id: "default", nodeId: "start" }],
  };
}

function duplicateAt<T extends { readonly id: string }>(values: readonly T[]): readonly T[] {
  return [...values, values[0]!];
}

describe("Graph JSON v1 semantic validation", () => {
  it("accepts unique IDs, exact node versions, and valid port references", () => {
    expect(validateGraphJsonV1Semantics(validGraph(), resolver)).toBe(true);
  });

  it("rejects duplicate IDs within every semantic namespace", () => {
    const base = validGraph();

    expect(
      validateGraphJsonV1Semantics({ ...base, inputs: duplicateAt(base.inputs) }, resolver),
    ).toBe(false);
    expect(
      validateGraphJsonV1Semantics({ ...base, outputs: duplicateAt(base.outputs) }, resolver),
    ).toBe(false);
    expect(
      validateGraphJsonV1Semantics({ ...base, nodes: duplicateAt(base.nodes) }, resolver),
    ).toBe(false);
    expect(
      validateGraphJsonV1Semantics({ ...base, edges: duplicateAt(base.edges) }, resolver),
    ).toBe(false);
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
      nodes: [graph.nodes[0]!, { ...graph.nodes[1]!, version: "2.0.1" }],
    };
    const missingType: GraphJsonV1 = {
      ...graph,
      nodes: [graph.nodes[0]!, { ...graph.nodes[1]!, type: "missing.finish" }],
    };

    expect(validateGraphJsonV1Semantics(wrongVersion, resolver)).toBe(false);
    expect(validateGraphJsonV1Semantics(missingType, resolver)).toBe(false);
  });

  it("rejects unresolved graph references and nonexistent data ports", () => {
    const graph = validGraph();
    const dataEdge = graph.edges[0]!;

    expect(
      validateGraphJsonV1Semantics(
        {
          ...graph,
          outputs: [
            { ...graph.outputs[0]!, source: { nodeId: "missing-node", port: "text" } },
          ],
        },
        resolver,
      ),
    ).toBe(false);
    expect(
      validateGraphJsonV1Semantics(
        {
          ...graph,
          outputs: [
            { ...graph.outputs[0]!, source: { nodeId: "finish", port: "missing-output" } },
          ],
        },
        resolver,
      ),
    ).toBe(false);

    if (dataEdge.kind !== "data") {
      throw new Error("test fixture must use a data edge");
    }

    expect(
      validateGraphJsonV1Semantics(
        {
          ...graph,
          edges: [
            { ...dataEdge, from: { nodeId: "missing-node", port: "text" } },
          ],
        },
        resolver,
      ),
    ).toBe(false);
    expect(
      validateGraphJsonV1Semantics(
        {
          ...graph,
          edges: [
            { ...dataEdge, from: { nodeId: "start", port: "missing-output" } },
          ],
        },
        resolver,
      ),
    ).toBe(false);
    expect(
      validateGraphJsonV1Semantics(
        {
          ...graph,
          edges: [
            { ...dataEdge, to: { nodeId: "missing-node", port: "text" } },
          ],
        },
        resolver,
      ),
    ).toBe(false);
    expect(
      validateGraphJsonV1Semantics(
        {
          ...graph,
          edges: [
            { ...dataEdge, to: { nodeId: "finish", port: "missing-input" } },
          ],
        },
        resolver,
      ),
    ).toBe(false);

    expect(
      validateGraphJsonV1Semantics(
        {
          ...graph,
          edges: [
            ...graph.edges,
            {
              id: "missing-control-target",
              kind: "control",
              from: { nodeId: "start" },
              to: { nodeId: "missing-node" },
            },
          ],
        },
        resolver,
      ),
    ).toBe(false);
    expect(
      validateGraphJsonV1Semantics(
        { ...graph, entrypoints: [{ id: "default", nodeId: "missing-node" }] },
        resolver,
      ),
    ).toBe(false);
    expect(
      validateGraphJsonV1Semantics(
        { ...graph, options: { defaultEntrypoint: "missing-entrypoint" } },
        resolver,
      ),
    ).toBe(false);
  });

  it("validates binding target ports and graph-input references", () => {
    const graph = validGraph();
    const finish = graph.nodes[1]!;

    const graphInputBound: GraphJsonV1 = {
      ...graph,
      nodes: [
        graph.nodes[0]!,
        {
          ...finish,
          bindings: [{ kind: "graph-input", port: "text", input: "prompt" }],
        },
      ],
      edges: [],
    };
    const literalBound: GraphJsonV1 = {
      ...graphInputBound,
      nodes: [
        graph.nodes[0]!,
        {
          ...finish,
          bindings: [{ kind: "literal", port: "text", value: "hello" }],
        },
      ],
    };
    const secretBound: GraphJsonV1 = {
      ...graphInputBound,
      nodes: [
        graph.nodes[0]!,
        {
          ...finish,
          bindings: [{ kind: "secret", port: "text", secretRef: "shared-text" }],
        },
      ],
    };

    expect(validateGraphJsonV1Semantics(graphInputBound, resolver)).toBe(true);
    expect(validateGraphJsonV1Semantics(literalBound, resolver)).toBe(true);
    expect(validateGraphJsonV1Semantics(secretBound, resolver)).toBe(true);

    expect(
      validateGraphJsonV1Semantics(
        {
          ...graphInputBound,
          nodes: [
            graph.nodes[0]!,
            {
              ...finish,
              bindings: [{ kind: "literal", port: "missing-input", value: "hello" }],
            },
          ],
        },
        resolver,
      ),
    ).toBe(false);
    expect(
      validateGraphJsonV1Semantics(
        {
          ...graphInputBound,
          nodes: [
            graph.nodes[0]!,
            {
              ...finish,
              bindings: [{ kind: "graph-input", port: "text", input: "missing-input" }],
            },
          ],
        },
        resolver,
      ),
    ).toBe(false);
  });

  it("enforces required and single-source cardinality across bindings and data edges", () => {
    const graph = validGraph();
    const finish = graph.nodes[1]!;

    expect(validateGraphJsonV1Semantics({ ...graph, edges: [] }, resolver)).toBe(false);

    expect(
      validateGraphJsonV1Semantics(
        {
          ...graph,
          nodes: [
            graph.nodes[0]!,
            {
              ...finish,
              bindings: [{ kind: "literal", port: "text", value: "second source" }],
            },
          ],
        },
        resolver,
      ),
    ).toBe(false);

    expect(
      validateGraphJsonV1Semantics(
        {
          ...graph,
          nodes: [
            ...graph.nodes,
            { id: "source2", type: "builtin.source2", version: "1.0.0", config: {} },
          ],
          edges: [
            ...graph.edges,
            {
              id: "source2-finish",
              kind: "data",
              from: { nodeId: "source2", port: "text" },
              to: { nodeId: "finish", port: "text" },
            },
          ],
        },
        resolver,
      ),
    ).toBe(false);
  });

  it("allows multiple-source ports and still requires at least one source when required", () => {
    const graph: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "semantic.multiple",
      revisionId: "rev-001",
      inputs: [],
      outputs: [
        {
          id: "result",
          schema: { type: "string" },
          source: { nodeId: "collector", port: "text" },
        },
      ],
      nodes: [
        { id: "start", type: "builtin.start", version: "1.0.0", config: {} },
        { id: "source2", type: "builtin.source2", version: "1.0.0", config: {} },
        { id: "collector", type: "builtin.collector", version: "1.0.0", config: {} },
      ],
      edges: [
        {
          id: "start-collector",
          kind: "data",
          from: { nodeId: "start", port: "text" },
          to: { nodeId: "collector", port: "items" },
        },
        {
          id: "source2-collector",
          kind: "data",
          from: { nodeId: "source2", port: "text" },
          to: { nodeId: "collector", port: "items" },
        },
      ],
      entrypoints: [{ id: "default", nodeId: "start" }],
    };

    expect(validateGraphJsonV1Semantics(graph, resolver)).toBe(true);
    expect(validateGraphJsonV1Semantics({ ...graph, edges: [] }, resolver)).toBe(false);
  });

  it("does not absorb 2.8 compatibility, 2.11 control ports, or 2.15 secret-only rules", () => {
    const incompatible: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "semantic.compatibility-boundary",
      revisionId: "rev-001",
      inputs: [],
      outputs: [
        {
          id: "result",
          schema: { type: "string" },
          source: { nodeId: "sink", port: "text" },
        },
      ],
      nodes: [
        { id: "start", type: "builtin.start", version: "1.0.0", config: {} },
        { id: "sink", type: "builtin.number-sink", version: "1.0.0", config: {} },
      ],
      edges: [
        {
          id: "incompatible-data",
          kind: "data",
          from: { nodeId: "start", port: "text" },
          to: { nodeId: "sink", port: "value" },
        },
        {
          id: "reserved-control-ports",
          kind: "control",
          from: { nodeId: "start", port: "future-route" },
          to: { nodeId: "sink", port: "future-lane" },
        },
      ],
      entrypoints: [{ id: "default", nodeId: "start", port: "future-entry" }],
    };

    const secretLiteral: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "semantic.secret-boundary",
      revisionId: "rev-001",
      inputs: [],
      outputs: [
        {
          id: "result",
          schema: { type: "string" },
          source: { nodeId: "sink", port: "text" },
        },
      ],
      nodes: [
        {
          id: "sink",
          type: "builtin.secret-sink",
          version: "1.0.0",
          config: {},
          bindings: [{ kind: "literal", port: "apiKey", value: "not-enforced-until-2.15" }],
        },
      ],
      edges: [],
      entrypoints: [{ id: "default", nodeId: "sink" }],
    };

    expect(validateGraphJsonV1Semantics(incompatible, resolver)).toBe(true);
    expect(validateGraphJsonV1Semantics(secretLiteral, resolver)).toBe(true);
  });
});
