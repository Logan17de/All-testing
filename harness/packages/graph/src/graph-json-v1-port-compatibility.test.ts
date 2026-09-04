import { describe, expect, it } from "vitest";

import type {
  JsonSchema,
  NodeInputPort,
  NodeManifest,
  NodeOutputPort,
} from "@zet-harness/plugin-api";

import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "./graph-json-v1.js";
import {
  isJsonSchemaPortCompatible,
  validateGraphJsonV1PortCompatibility,
} from "./graph-json-v1-port-compatibility.js";
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
      recovery: "not-applicable",
      executionMode: "in-process",
      requiredCapabilities: [],
    },
  };
}

const manifests = [
  manifest("source.string", {}, { value: { schema: { type: "string", minLength: 2 } } }),
  manifest("source.integer", {}, { value: { schema: { type: "integer" } } }),
  manifest("source.number", {}, { value: { schema: { type: "number" } } }),
  manifest("source.enum", {}, { value: { schema: { enum: ["a", "b"] } } }),
  manifest(
    "sink.string",
    { value: { schema: { type: "string", description: "wide string target" }, required: true } },
    {},
  ),
  manifest("sink.number", { value: { schema: { type: "number" }, required: true } }, {}),
  manifest("sink.integer", { value: { schema: { type: "integer" }, required: true } }, {}),
  manifest(
    "sink.constrained-string",
    { value: { schema: { type: "string", minLength: 1 }, required: true } },
    {},
  ),
];

const resolver: NodeManifestResolver = {
  getManifest(type, version) {
    return version === "1.0.0" ? manifests.find((item) => item.type === type) : undefined;
  },
};

function dataGraph(sourceType: string, targetType: string): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: `${sourceType}-to-${targetType}`,
    revisionId: "rev-001",
    inputs: [],
    outputs: [],
    nodes: [
      { id: "source", type: sourceType, version: "1.0.0", config: {} },
      { id: "target", type: targetType, version: "1.0.0", config: {} },
    ],
    edges: [
      {
        id: "value-flow",
        kind: "data",
        from: { nodeId: "source", port: "value" },
        to: { nodeId: "target", port: "value" },
      },
    ],
    entrypoints: [{ id: "default", nodeId: "source" }],
  };
}

describe("Graph JSON v1 constrained port compatibility", () => {
  it("accepts structurally identical schemas regardless of object key order", () => {
    const source: JsonSchema = {
      type: "object",
      required: ["name"],
      properties: {
        name: { minLength: 1, type: "string" },
      },
    };
    const target: JsonSchema = {
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
      type: "object",
    };

    expect(isJsonSchemaPortCompatible(source, target)).toBe(true);
  });

  it("supports universal targets, impossible sources, same primitives, and integer-to-number", () => {
    expect(isJsonSchemaPortCompatible({ type: "string" }, true)).toBe(true);
    expect(isJsonSchemaPortCompatible({ type: "string" }, {})).toBe(true);
    expect(isJsonSchemaPortCompatible({ type: "string" }, { description: "annotation only" })).toBe(
      true,
    );
    expect(isJsonSchemaPortCompatible(false, { type: "string", minLength: 10 })).toBe(true);
    expect(
      isJsonSchemaPortCompatible(
        { type: "string", minLength: 2 },
        { type: "string", description: "unconstrained string" },
      ),
    ).toBe(true);
    expect(isJsonSchemaPortCompatible({ type: "integer", minimum: 0 }, { type: "number" })).toBe(
      true,
    );
  });

  it("rejects unsafe primitive direction and cross-primitive flow", () => {
    expect(isJsonSchemaPortCompatible({ type: "number" }, { type: "integer" })).toBe(false);
    expect(isJsonSchemaPortCompatible({ type: "string" }, { type: "number" })).toBe(false);
    expect(isJsonSchemaPortCompatible(true, { type: "string" })).toBe(false);
  });

  it("refuses implication reasoning for target constraints and schema combinators", () => {
    expect(
      isJsonSchemaPortCompatible(
        { type: "string", minLength: 2 },
        { type: "string", minLength: 1 },
      ),
    ).toBe(false);
    expect(isJsonSchemaPortCompatible({ enum: ["a"] }, { type: "string" })).toBe(false);
    expect(
      isJsonSchemaPortCompatible(
        { allOf: [{ type: "integer" }, { minimum: 0 }] },
        { type: "number" },
      ),
    ).toBe(false);
    expect(
      isJsonSchemaPortCompatible(
        { $ref: "#/$defs/value", $defs: { value: { type: "string" } } },
        { type: "string" },
      ),
    ).toBe(false);
  });

  it("checks data edges without absorbing compatibility into the 2.6-2.7 semantic pass", () => {
    const compatible = dataGraph("source.string", "sink.string");
    const widening = dataGraph("source.integer", "sink.number");
    const incompatible = dataGraph("source.string", "sink.number");

    expect(validateGraphJsonV1Semantics(incompatible, resolver)).toBe(true);
    expect(validateGraphJsonV1PortCompatibility(compatible, resolver)).toBe(true);
    expect(validateGraphJsonV1PortCompatibility(widening, resolver)).toBe(true);
    expect(validateGraphJsonV1PortCompatibility(incompatible, resolver)).toBe(false);
    expect(
      validateGraphJsonV1PortCompatibility(dataGraph("source.number", "sink.integer"), resolver),
    ).toBe(false);
    expect(
      validateGraphJsonV1PortCompatibility(dataGraph("source.enum", "sink.string"), resolver),
    ).toBe(false);
    expect(
      validateGraphJsonV1PortCompatibility(
        dataGraph("source.string", "sink.constrained-string"),
        resolver,
      ),
    ).toBe(false);
  });

  it("checks graph-input bindings using the same compatibility rules", () => {
    const graph: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "graph-input-compatibility",
      revisionId: "rev-001",
      inputs: [{ id: "prompt", schema: { type: "string" } }],
      outputs: [],
      nodes: [
        {
          id: "target",
          type: "sink.string",
          version: "1.0.0",
          config: {},
          bindings: [{ kind: "graph-input", port: "value", input: "prompt" }],
        },
      ],
      edges: [],
      entrypoints: [{ id: "default", nodeId: "target" }],
    };

    expect(validateGraphJsonV1PortCompatibility(graph, resolver)).toBe(true);
    expect(
      validateGraphJsonV1PortCompatibility(
        { ...graph, inputs: [{ id: "prompt", schema: { type: "number" } }] },
        resolver,
      ),
    ).toBe(false);
  });

  it("checks graph-output declarations from the producing node schema", () => {
    const graph: GraphJsonV1 = {
      schemaVersion: GRAPH_JSON_VERSION,
      graphId: "graph-output-compatibility",
      revisionId: "rev-001",
      inputs: [],
      outputs: [
        {
          id: "result",
          schema: { type: "string" },
          source: { nodeId: "source", port: "value" },
        },
      ],
      nodes: [{ id: "source", type: "source.string", version: "1.0.0", config: {} }],
      edges: [],
      entrypoints: [{ id: "default", nodeId: "source" }],
    };

    expect(validateGraphJsonV1PortCompatibility(graph, resolver)).toBe(true);
    expect(
      validateGraphJsonV1PortCompatibility(
        { ...graph, outputs: [{ ...graph.outputs[0]!, schema: { type: "number" } }] },
        resolver,
      ),
    ).toBe(false);
  });

  it("ignores control edges because they carry no values", () => {
    const graph = dataGraph("source.string", "sink.string");
    const withControl: GraphJsonV1 = {
      ...graph,
      edges: [
        ...graph.edges,
        {
          id: "control-only",
          kind: "control",
          from: { nodeId: "source", port: "future-route" },
          to: { nodeId: "target", port: "future-lane" },
        },
      ],
    };

    expect(validateGraphJsonV1PortCompatibility(withControl, resolver)).toBe(true);
  });
});
