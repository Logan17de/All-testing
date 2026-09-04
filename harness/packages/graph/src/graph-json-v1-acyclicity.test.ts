import { describe, expect, it } from "vitest";

import type { NodeInputPort, NodeManifest, NodeOutputPort } from "@zet-harness/plugin-api";

import {
  checkGraphJsonV1Acyclicity,
  validateGraphJsonV1Acyclicity,
} from "./graph-json-v1-acyclicity.js";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "./graph-json-v1.js";
import { validateGraphJsonV1Liveness } from "./graph-json-v1-liveness.js";
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

const stringPort = { value: { schema: { type: "string" } } } as const;
const requiredStringPort = {
  value: { schema: { type: "string" }, required: true },
} as const;

const manifests = [
  manifest("source", {}, stringPort),
  manifest("pass", requiredStringPort, stringPort),
  manifest("sink", requiredStringPort, {}),
];

const resolver: NodeManifestResolver = {
  getManifest(type, version) {
    return version === "1.0.0" ? manifests.find((item) => item.type === type) : undefined;
  },
};

function node(id: string, type = "pass") {
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

function controlEdge(id: string, from: string, to: string, port = "next") {
  return {
    id,
    kind: "control",
    from: { nodeId: from, port },
    to: { nodeId: to },
  } as const;
}

function graph(
  nodes: GraphJsonV1["nodes"],
  edges: GraphJsonV1["edges"],
  entrypointNodeId = nodes[0]?.id,
): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "acyclicity.example",
    revisionId: "rev-001",
    inputs: [],
    outputs: [],
    nodes,
    edges,
    entrypoints:
      entrypointNodeId === undefined ? [] : [{ id: "default", nodeId: entrypointNodeId }],
  };
}

describe("Graph JSON v1 acyclicity", () => {
  it("accepts an ordinary DAG", () => {
    const value = graph(
      [node("a", "source"), node("b"), node("c", "sink")],
      [dataEdge("a-b", "a", "b"), dataEdge("b-c", "b", "c")],
    );

    expect(checkGraphJsonV1Acyclicity(value)).toEqual({ valid: true, diagnostics: [] });
    expect(validateGraphJsonV1Acyclicity(value)).toBe(true);
  });

  it("rejects a two-node data SCC", () => {
    const value = graph(
      [node("a"), node("b")],
      [dataEdge("a-b", "a", "b"), dataEdge("b-a", "b", "a")],
    );

    expect(checkGraphJsonV1Acyclicity(value)).toEqual({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_CYCLE_DETECTED",
          message:
            "Executable graph cycle detected across node(s): a, b. Arbitrary cycles are not executable in Harness v1.",
          nodeIds: ["a", "b"],
          edgeIds: ["a-b", "b-a"],
        },
      ],
    });
  });

  it("rejects cycles spanning data and control dependencies", () => {
    const value = graph(
      [node("a"), node("b")],
      [dataEdge("a-b", "a", "b"), controlEdge("b-a", "b", "a")],
    );

    expect(checkGraphJsonV1Acyclicity(value)).toMatchObject({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_CYCLE_DETECTED",
          nodeIds: ["a", "b"],
          edgeIds: ["a-b", "b-a"],
        },
      ],
    });
  });

  it("rejects a self-loop", () => {
    const value = graph([node("a")], [controlEdge("a-a", "a", "a")]);

    expect(checkGraphJsonV1Acyclicity(value)).toMatchObject({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_CYCLE_DETECTED",
          nodeIds: ["a"],
          edgeIds: ["a-a"],
        },
      ],
    });
  });

  it("does not grant an exception to loop-looking control ports", () => {
    const value = graph(
      [node("loop-head"), node("loop-body")],
      [
        controlEdge("enter-body", "loop-head", "loop-body", "loop"),
        controlEdge("repeat", "loop-body", "loop-head", "continue"),
      ],
    );

    expect(validateGraphJsonV1Acyclicity(value)).toBe(false);
  });

  it("keeps the 2.9/2.10 boundary explicit: reachable cycles pass liveness and fail acyclicity", () => {
    const value = graph(
      [node("a"), node("b")],
      [dataEdge("a-b", "a", "b"), dataEdge("b-a", "b", "a")],
    );

    expect(validateGraphJsonV1Liveness(value, resolver)).toBe(true);
    expect(validateGraphJsonV1Acyclicity(value)).toBe(false);
  });

  it("reports multiple SCCs deterministically in graph source order", () => {
    const value = graph(
      [node("z"), node("y"), node("a"), node("b")],
      [
        dataEdge("z-y", "z", "y"),
        dataEdge("y-z", "y", "z"),
        controlEdge("a-b", "a", "b"),
        controlEdge("b-a", "b", "a"),
      ],
      "z",
    );

    expect(checkGraphJsonV1Acyclicity(value).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_CYCLE_DETECTED",
        nodeIds: ["z", "y"],
        edgeIds: ["z-y", "y-z"],
      }),
      expect.objectContaining({
        code: "GRAPH_CYCLE_DETECTED",
        nodeIds: ["a", "b"],
        edgeIds: ["a-b", "b-a"],
      }),
    ]);
  });

  it("treats missing edge endpoints only as a prerequisite failure", () => {
    const value = graph([node("a")], [dataEdge("a-missing", "a", "missing")]);

    expect(checkGraphJsonV1Acyclicity(value)).toEqual({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_ACYCLICITY_PREREQUISITE_FAILED",
          message: "Edge 'a-missing' references a missing node; 2.6-2.9 must succeed before 2.10.",
          edgeIds: ["a-missing"],
        },
      ],
    });
  });
});
