import { describe, expect, it } from "vitest";

import { JSON_SCHEMA_DIALECT_URI } from "@zet-harness/plugin-api";

import { GRAPH_JSON_VERSION } from "./graph-json-v1.js";
import { GRAPH_JSON_V1_SCHEMA } from "./graph-json-v1.schema.js";
import { validateGraphJsonV1Shape } from "./graph-json-v1-validator.js";

function validGraph(): unknown {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "shape.example",
    revisionId: "rev-001",
    inputs: [
      {
        id: "prompt",
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
        id: "start",
        type: "builtin.start",
        version: "1.0.0",
        config: {},
        bindings: [
          {
            kind: "graph-input",
            port: "prompt",
            input: "prompt",
          },
        ],
      },
      {
        id: "finish",
        type: "builtin.finish",
        version: "1.0.0",
        config: {},
      },
    ],
    edges: [
      {
        id: "start-finish",
        kind: "data",
        from: { nodeId: "start", port: "text" },
        to: { nodeId: "finish", port: "input" },
      },
    ],
    entrypoints: [{ id: "default", nodeId: "start" }],
    policies: {
      maxNodeExecutions: 10,
      maxParallelism: 2,
      maxWallTimeMs: 30_000,
    },
    options: {
      defaultEntrypoint: "default",
    },
  };
}

describe("Graph JSON v1 shape validation", () => {
  it("uses the frozen Draft 2020-12 dialect and accepts a valid document shape", () => {
    expect(GRAPH_JSON_V1_SCHEMA.$schema).toBe(JSON_SCHEMA_DIALECT_URI);
    expect(validateGraphJsonV1Shape(validGraph())).toBe(true);
  });

  it("rejects the wrong source-format version and missing required top-level fields", () => {
    const wrongVersion = { ...(validGraph() as Record<string, unknown>), schemaVersion: 2 };
    const missingNodes = { ...(validGraph() as Record<string, unknown>) };
    Reflect.deleteProperty(missingNodes, "nodes");

    expect(validateGraphJsonV1Shape(wrongVersion)).toBe(false);
    expect(validateGraphJsonV1Shape(missingNodes)).toBe(false);
  });

  it("rejects unknown fields and invalid local execution limits", () => {
    const extraField = { ...(validGraph() as Record<string, unknown>), surprise: true };
    const invalidLimits = {
      ...(validGraph() as Record<string, unknown>),
      policies: { maxParallelism: 0 },
    };

    expect(validateGraphJsonV1Shape(extraField)).toBe(false);
    expect(validateGraphJsonV1Shape(invalidLimits)).toBe(false);
  });

  it("rejects malformed tagged bindings and non-JSON config values", () => {
    const malformedBinding = validGraph() as {
      nodes: Array<Record<string, unknown>>;
    };
    malformedBinding.nodes[0] = {
      ...malformedBinding.nodes[0],
      bindings: [{ kind: "secret", port: "credential" }],
    };

    const nonJsonConfig = validGraph() as {
      nodes: Array<Record<string, unknown>>;
    };
    nonJsonConfig.nodes[0] = {
      ...nonJsonConfig.nodes[0],
      config: { callback: () => "not JSON" },
    };

    expect(validateGraphJsonV1Shape(malformedBinding)).toBe(false);
    expect(validateGraphJsonV1Shape(nonJsonConfig)).toBe(false);
  });

  it("does not absorb semantic validation responsibilities", () => {
    const graph = validGraph() as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
      options: Record<string, unknown>;
    };

    graph.nodes.push({
      id: "start",
      type: "missing.node.type",
      version: "99.0.0",
      config: {},
    });
    graph.edges.push({
      id: "unknown-reference",
      kind: "control",
      from: { nodeId: "does-not-exist" },
      to: { nodeId: "also-missing" },
    });
    graph.options.defaultEntrypoint = "missing-entrypoint";

    expect(validateGraphJsonV1Shape(graph)).toBe(true);
  });
});
