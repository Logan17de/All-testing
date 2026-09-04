import { describe, expect, it } from "vitest";

import type { JsonObject } from "@zet-harness/plugin-api";

import {
  canonicalizeGraphJsonV1Semantics,
  stringifyCanonicalJsonV1,
} from "./graph-json-v1-canonical.js";
import type { GraphCompilerSourceV1 } from "./graph-json-v1-ui-metadata.js";

function source(): GraphCompilerSourceV1 {
  return {
    document: {
      schemaVersion: 1,
      graphId: "source-graph",
      revisionId: "rev-a",
      metadata: { title: "Human title", labels: ["z", "a"] },
      inputs: [
        { id: "z-input", schema: { type: "string", description: "Z" }, required: false },
        { id: "a-input", schema: { description: "A", type: "string" }, required: true },
      ],
      outputs: [
        {
          id: "z-output",
          schema: true,
          source: { nodeId: "z-node", port: "value" },
        },
        {
          id: "a-output",
          schema: { type: "string" },
          source: { nodeId: "a-node", port: "value" },
        },
      ],
      nodes: [
        {
          id: "z-node",
          type: "test.z",
          version: "2",
          config: {
            z: 1,
            a: { nestedZ: true, nestedA: false, sequence: ["z", "a"] },
          },
          bindings: [
            { kind: "literal", port: "items", value: { z: 1, a: 2 } },
            { kind: "graph-input", port: "prompt", input: "a-input" },
          ],
        },
        {
          id: "a-node",
          type: "test.a",
          version: "1",
          config: { beta: 2, alpha: 1 },
          bindings: [],
        },
      ],
      edges: [
        {
          id: "z-edge",
          kind: "control",
          from: { nodeId: "a-node" },
          to: { nodeId: "z-node", port: "entry" },
        },
        {
          id: "a-edge",
          kind: "data",
          from: { nodeId: "a-node", port: "value" },
          to: { nodeId: "z-node", port: "input" },
        },
      ],
      entrypoints: [
        { id: "z-start", nodeId: "z-node", port: "entry" },
        { id: "a-start", nodeId: "a-node" },
      ],
      policies: {
        maxNodeExecutions: 50,
        capabilities: {
          required: ["z:required", "a:required"],
          optional: ["z:optional", "a:optional"],
          deny: ["z:deny", "a:deny"],
        },
      },
      options: { defaultEntrypoint: "a-start" },
    },
    nodePins: [
      {
        nodeId: "z-node",
        type: "test.z",
        version: "2",
        pluginId: "plugin.z",
        pluginVersion: "9",
      },
      {
        nodeId: "a-node",
        type: "test.a",
        version: "1",
        pluginId: "plugin.a",
        pluginVersion: "1",
      },
    ],
    pluginPins: [
      { id: "plugin.z", version: "9" },
      { id: "plugin.a", version: "1" },
    ],
  };
}

function equivalentSourceWithDifferentPresentation(): GraphCompilerSourceV1 {
  const original = source();
  const zNode = original.document.nodes[0];
  const aNode = original.document.nodes[1];
  if (zNode === undefined || aNode === undefined) throw new Error("test fixture missing nodes");

  return {
    document: {
      schemaVersion: 1,
      graphId: "different-graph-id",
      revisionId: "different-revision",
      metadata: { title: "Different human title", description: "Also ignored by semantics" },
      inputs: [...original.document.inputs].reverse(),
      outputs: [...original.document.outputs].reverse(),
      nodes: [
        {
          ...aNode,
          config: { alpha: 1, beta: 2 },
        },
        {
          ...zNode,
          config: {
            a: { sequence: ["z", "a"], nestedA: false, nestedZ: true },
            z: 1,
          },
        },
      ],
      edges: [...original.document.edges].reverse(),
      entrypoints: [...original.document.entrypoints].reverse(),
      policies: {
        maxNodeExecutions: 50,
        capabilities: {
          required: ["a:required", "z:required"],
          optional: ["a:optional", "z:optional"],
          deny: ["a:deny", "z:deny"],
        },
      },
      options: { defaultEntrypoint: "a-start" },
    },
    nodePins: [...original.nodePins].reverse(),
    pluginPins: [...original.pluginPins].reverse(),
  };
}

describe("Graph JSON v1 canonical source semantics", () => {
  it("projects only executable semantics and orders identity-addressed collections deterministically", () => {
    const input = source();
    const before = structuredClone(input);

    const result = canonicalizeGraphJsonV1Semantics(input);

    expect(result.semantics).not.toHaveProperty("graphId");
    expect(result.semantics).not.toHaveProperty("revisionId");
    expect(result.semantics).not.toHaveProperty("metadata");
    expect(result.semantics).not.toHaveProperty("editor");
    expect(result.semantics.inputs.map(({ id }) => id)).toEqual(["a-input", "z-input"]);
    expect(result.semantics.outputs.map(({ id }) => id)).toEqual(["a-output", "z-output"]);
    expect(result.semantics.nodes.map(({ id }) => id)).toEqual(["a-node", "z-node"]);
    expect(result.semantics.edges.map(({ id }) => id)).toEqual(["a-edge", "z-edge"]);
    expect(result.semantics.entrypoints.map(({ id }) => id)).toEqual(["a-start", "z-start"]);
    expect(result.semantics.policies?.capabilities).toEqual({
      required: ["a:required", "z:required"],
      optional: ["a:optional", "z:optional"],
      deny: ["a:deny", "z:deny"],
    });
    expect(result.nodePins.map(({ nodeId }) => nodeId)).toEqual(["a-node", "z-node"]);
    expect(result.pluginPins.map(({ id }) => id)).toEqual(["plugin.a", "plugin.z"]);
    expect(input).toEqual(before);
  });

  it("produces the same canonical semantic JSON for equivalent source ordering and human identity changes", () => {
    const left = canonicalizeGraphJsonV1Semantics(source());
    const right = canonicalizeGraphJsonV1Semantics(equivalentSourceWithDifferentPresentation());

    expect(left.semantics).toEqual(right.semantics);
    expect(left.canonicalSemanticsJson).toBe(right.canonicalSemanticsJson);
  });

  it("keeps arbitrary JSON arrays and binding sequence semantically ordered", () => {
    const original = source();
    const zNode = original.document.nodes[0];
    if (zNode === undefined) throw new Error("test fixture missing z-node");

    const changedConfigArray: GraphCompilerSourceV1 = {
      ...original,
      document: {
        ...original.document,
        nodes: [
          {
            ...zNode,
            config: {
              z: 1,
              a: { nestedZ: true, nestedA: false, sequence: ["a", "z"] },
            },
          },
          ...original.document.nodes.slice(1),
        ],
      },
    };

    const changedBindingOrder: GraphCompilerSourceV1 = {
      ...original,
      document: {
        ...original.document,
        nodes: [
          {
            ...zNode,
            bindings: [...(zNode.bindings ?? [])].reverse(),
          },
          ...original.document.nodes.slice(1),
        ],
      },
    };

    const baseline = canonicalizeGraphJsonV1Semantics(original).canonicalSemanticsJson;
    expect(canonicalizeGraphJsonV1Semantics(changedConfigArray).canonicalSemanticsJson).not.toBe(
      baseline,
    );
    expect(canonicalizeGraphJsonV1Semantics(changedBindingOrder).canonicalSemanticsJson).not.toBe(
      baseline,
    );
  });

  it("keeps registry provenance outside the canonical semantic JSON domain", () => {
    const left = source();
    const right: GraphCompilerSourceV1 = {
      ...left,
      nodePins: left.nodePins.map((pin) =>
        pin.nodeId === "a-node" ? { ...pin, pluginVersion: "999" } : pin,
      ),
      pluginPins: left.pluginPins.map((pin) =>
        pin.id === "plugin.a" ? { ...pin, version: "999" } : pin,
      ),
    };

    const leftCanonical = canonicalizeGraphJsonV1Semantics(left);
    const rightCanonical = canonicalizeGraphJsonV1Semantics(right);

    expect(leftCanonical.canonicalSemanticsJson).toBe(rightCanonical.canonicalSemanticsJson);
    expect(leftCanonical.pluginPins).not.toEqual(rightCanonical.pluginPins);
  });

  it("serializes object keys lexically even for integer-like property names", () => {
    const value: JsonObject = { "2": "two", "10": "ten", z: true, a: false };

    expect(stringifyCanonicalJsonV1(value)).toBe(
      '{"10":"ten","2":"two","a":false,"z":true}',
    );
  });

  it("rejects non-JSON finite-number violations defensively", () => {
    expect(() => stringifyCanonicalJsonV1(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});
