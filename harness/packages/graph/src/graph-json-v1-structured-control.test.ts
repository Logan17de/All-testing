import { describe, expect, it } from "vitest";

import type {
  NodeManifest,
  NodePrimitiveFamily,
  NodeStructuredControlContract,
} from "@zet-harness/plugin-api";

import { checkGraphJsonV1Acyclicity } from "./graph-json-v1-acyclicity.js";
import {
  checkGraphJsonV1StructuredControl,
  validateGraphJsonV1StructuredControl,
} from "./graph-json-v1-structured-control.js";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

function manifest(
  type: string,
  primitiveFamily: NodePrimitiveFamily,
  control?: NodeStructuredControlContract,
): NodeManifest {
  return {
    type,
    version: "1.0.0",
    title: type,
    inputs: {},
    outputs: {},
    configSchema: { type: "object" },
    behavior: {
      primitiveFamily,
      determinism: "deterministic",
      effect: "none",
      idempotency: "not-applicable",
      recovery: "not-applicable",
      executionMode: "none",
      requiredCapabilities: [],
    },
    ...(control === undefined ? {} : { control }),
  };
}

const manifests: readonly NodeManifest[] = [
  manifest("ordinary", "pure"),
  manifest("router", "control", {
    kind: "router",
    entry: "in",
    branches: ["yes", "no"],
  }),
  manifest("join", "control", {
    kind: "join",
    inputs: ["left", "right"],
    output: "out",
    mode: "all-active",
  }),
  manifest("loop", "control", {
    kind: "loop",
    entry: "enter",
    continue: "continue",
    body: "body",
    exit: "exit",
  }),
  manifest("human", "interrupt", {
    kind: "human-interrupt",
    entry: "wait",
    outcomes: ["approved", "rejected"],
  }),
  manifest("subgraph", "control", {
    kind: "subgraph",
    entry: "call",
    exits: ["complete", "failed"],
  }),
];

const resolver: NodeManifestResolver = {
  getManifest(type, version) {
    return version === "1.0.0" ? manifests.find((item) => item.type === type) : undefined;
  },
};

function node(id: string, type: string) {
  return { id, type, version: "1.0.0", config: {} } as const;
}

function graph(
  nodes: GraphJsonV1["nodes"],
  edges: GraphJsonV1["edges"],
  entrypoints: GraphJsonV1["entrypoints"] = [],
): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "structured-control.test",
    revisionId: "rev-001",
    inputs: [],
    outputs: [],
    nodes,
    edges,
    entrypoints,
  };
}

describe("Graph JSON v1 structured control contracts", () => {
  it("allows ordinary unported ordering control edges", () => {
    const value = graph(
      [node("a", "ordinary"), node("b", "ordinary")],
      [{ id: "a-b", kind: "control", from: { nodeId: "a" }, to: { nodeId: "b" } }],
      [{ id: "default", nodeId: "a" }],
    );

    expect(validateGraphJsonV1StructuredControl(value, resolver)).toBe(true);
  });

  it("rejects arbitrary named control ports on ordinary nodes", () => {
    const value = graph(
      [node("a", "ordinary"), node("b", "ordinary")],
      [
        {
          id: "a-b",
          kind: "control",
          from: { nodeId: "a", port: "made-up-output" },
          to: { nodeId: "b", port: "made-up-input" },
        },
      ],
      [{ id: "default", nodeId: "a", port: "made-up-entry" }],
    );

    expect(checkGraphJsonV1StructuredControl(value, resolver).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_CONTROL_PORT_UNEXPECTED",
        nodeId: "a",
        edgeId: "a-b",
        direction: "output",
      }),
      expect.objectContaining({
        code: "GRAPH_CONTROL_PORT_UNEXPECTED",
        nodeId: "b",
        edgeId: "a-b",
        direction: "input",
      }),
      expect.objectContaining({
        code: "GRAPH_CONTROL_PORT_UNEXPECTED",
        nodeId: "a",
        entrypointId: "default",
        direction: "input",
      }),
    ]);
  });

  it("validates router entry and branch ports explicitly", () => {
    const value = graph(
      [node("before", "ordinary"), node("route", "router"), node("after", "ordinary")],
      [
        {
          id: "before-route",
          kind: "control",
          from: { nodeId: "before" },
          to: { nodeId: "route", port: "in" },
        },
        {
          id: "route-after",
          kind: "control",
          from: { nodeId: "route", port: "yes" },
          to: { nodeId: "after" },
        },
      ],
      [{ id: "router-entry", nodeId: "route", port: "in" }],
    );

    expect(validateGraphJsonV1StructuredControl(value, resolver)).toBe(true);

    const wrongPort: GraphJsonV1 = {
      ...value,
      edges: [
        value.edges[0]!,
        {
          id: "route-after",
          kind: "control",
          from: { nodeId: "route", port: "maybe" },
          to: { nodeId: "after" },
        },
      ],
    };

    expect(checkGraphJsonV1StructuredControl(wrongPort, resolver)).toMatchObject({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_CONTROL_PORT_UNKNOWN",
          nodeId: "route",
          edgeId: "route-after",
          port: "maybe",
          direction: "output",
        },
      ],
    });
  });

  it("requires explicit ports whenever a structured node is a control endpoint", () => {
    const value = graph(
      [node("route", "router"), node("after", "ordinary")],
      [
        {
          id: "route-after",
          kind: "control",
          from: { nodeId: "route" },
          to: { nodeId: "after" },
        },
      ],
      [{ id: "default", nodeId: "route" }],
    );

    expect(checkGraphJsonV1StructuredControl(value, resolver).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_CONTROL_PORT_REQUIRED",
        nodeId: "route",
        edgeId: "route-after",
        direction: "output",
      }),
      expect.objectContaining({
        code: "GRAPH_CONTROL_PORT_REQUIRED",
        nodeId: "route",
        entrypointId: "default",
        direction: "input",
      }),
    ]);
  });

  it("reserves join lanes and the all-active output without adding any/quorum semantics", () => {
    const value = graph(
      [node("left", "ordinary"), node("right", "ordinary"), node("join", "join"), node("end", "ordinary")],
      [
        {
          id: "left-join",
          kind: "control",
          from: { nodeId: "left" },
          to: { nodeId: "join", port: "left" },
        },
        {
          id: "right-join",
          kind: "control",
          from: { nodeId: "right" },
          to: { nodeId: "join", port: "right" },
        },
        {
          id: "join-end",
          kind: "control",
          from: { nodeId: "join", port: "out" },
          to: { nodeId: "end" },
        },
      ],
    );

    expect(validateGraphJsonV1StructuredControl(value, resolver)).toBe(true);
    expect(manifests.find((item) => item.type === "join")?.control).toMatchObject({
      kind: "join",
      mode: "all-active",
    });
  });

  it("reserves loop ports but does not override 2.10 cycle rejection", () => {
    const value = graph(
      [node("loop", "loop"), node("body", "ordinary")],
      [
        {
          id: "loop-body",
          kind: "control",
          from: { nodeId: "loop", port: "body" },
          to: { nodeId: "body" },
        },
        {
          id: "body-loop",
          kind: "control",
          from: { nodeId: "body" },
          to: { nodeId: "loop", port: "continue" },
        },
      ],
      [{ id: "default", nodeId: "loop", port: "enter" }],
    );

    expect(validateGraphJsonV1StructuredControl(value, resolver)).toBe(true);
    expect(checkGraphJsonV1Acyclicity(value)).toMatchObject({
      valid: false,
      diagnostics: [{ code: "GRAPH_CYCLE_DETECTED", nodeIds: ["loop", "body"] }],
    });
  });

  it("reserves explicit human-interrupt outcomes and subgraph exits", () => {
    const value = graph(
      [
        node("before", "ordinary"),
        node("approval", "human"),
        node("call", "subgraph"),
        node("end", "ordinary"),
      ],
      [
        {
          id: "before-human",
          kind: "control",
          from: { nodeId: "before" },
          to: { nodeId: "approval", port: "wait" },
        },
        {
          id: "human-subgraph",
          kind: "control",
          from: { nodeId: "approval", port: "approved" },
          to: { nodeId: "call", port: "call" },
        },
        {
          id: "subgraph-end",
          kind: "control",
          from: { nodeId: "call", port: "complete" },
          to: { nodeId: "end" },
        },
      ],
    );

    expect(validateGraphJsonV1StructuredControl(value, resolver)).toBe(true);
  });

  it("rejects malformed contracts and primitive-family mismatches", () => {
    const malformed = manifest("malformed", "control", {
      kind: "router",
      entry: "same",
      branches: ["same"],
    });
    const wrongFamily = manifest("wrong-family", "pure", {
      kind: "subgraph",
      entry: "in",
      exits: ["out"],
    });
    const wrongHumanFamily = manifest("wrong-human-family", "control", {
      kind: "human-interrupt",
      entry: "wait",
      outcomes: ["resume"],
    });
    const localResolver: NodeManifestResolver = {
      getManifest(type) {
        return [malformed, wrongFamily, wrongHumanFamily].find((item) => item.type === type);
      },
    };
    const value = graph(
      [
        node("a", "malformed"),
        node("b", "wrong-family"),
        node("c", "wrong-human-family"),
      ],
      [],
    );

    expect(checkGraphJsonV1StructuredControl(value, localResolver).diagnostics).toEqual([
      expect.objectContaining({ code: "GRAPH_CONTROL_CONTRACT_INVALID", nodeId: "a" }),
      expect.objectContaining({ code: "GRAPH_CONTROL_CONTRACT_BEHAVIOR_INVALID", nodeId: "b" }),
      expect.objectContaining({ code: "GRAPH_CONTROL_CONTRACT_BEHAVIOR_INVALID", nodeId: "c" }),
    ]);
  });
});
