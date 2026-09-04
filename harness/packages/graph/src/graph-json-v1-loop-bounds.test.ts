import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue, NodeManifest } from "@zet-harness/plugin-api";

import { checkGraphJsonV1Acyclicity } from "./graph-json-v1-acyclicity.js";
import {
  checkGraphJsonV1LoopBounds,
  GRAPH_LOOP_MAX_ITERATIONS_CONFIG_KEY,
  validateGraphJsonV1LoopBounds,
} from "./graph-json-v1-loop-bounds.js";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

function manifest(type: string, loop = false): NodeManifest {
  return {
    type,
    version: "1.0.0",
    title: type,
    inputs: {},
    outputs: {},
    configSchema: { type: "object" },
    behavior: {
      primitiveFamily: loop ? "control" : "pure",
      determinism: "deterministic",
      effect: "none",
      idempotency: "not-applicable",
      recovery: "not-applicable",
      executionMode: "none",
      requiredCapabilities: [],
    },
    ...(loop
      ? {
          control: {
            kind: "loop" as const,
            entry: "enter",
            continue: "continue",
            body: "body",
            exit: "exit",
          },
        }
      : {}),
  };
}

const manifests: readonly NodeManifest[] = [manifest("ordinary"), manifest("loop", true)];

const resolver: NodeManifestResolver = {
  getManifest(type, version) {
    return version === "1.0.0" ? manifests.find((item) => item.type === type) : undefined;
  },
};

function node(id: string, type: string, config: JsonObject = {}) {
  return { id, type, version: "1.0.0", config } as const;
}

function graph(
  nodes: GraphJsonV1["nodes"],
  edges: GraphJsonV1["edges"] = [],
  entrypoints: GraphJsonV1["entrypoints"] = [],
  policies?: GraphJsonV1["policies"],
): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "loop-bounds.test",
    revisionId: "rev-001",
    inputs: [],
    outputs: [],
    nodes,
    edges,
    entrypoints,
    ...(policies === undefined ? {} : { policies }),
  };
}

describe("Graph JSON v1 compiler-visible loop bounds", () => {
  it("accepts a positive safe maxIterations bound per loop invocation", () => {
    const value = graph([
      node("once", "loop", { maxIterations: 1 }),
      node("many", "loop", { maxIterations: 7 }),
    ]);

    expect(validateGraphJsonV1LoopBounds(value, resolver)).toBe(true);
    expect(GRAPH_LOOP_MAX_ITERATIONS_CONFIG_KEY).toBe("maxIterations");
  });

  it("requires maxIterations on every structured loop node", () => {
    const value = graph([node("loop", "loop")]);

    expect(checkGraphJsonV1LoopBounds(value, resolver)).toMatchObject({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_LOOP_BOUND_REQUIRED",
          nodeId: "loop",
          configKey: "maxIterations",
        },
      ],
    });
  });

  it.each<JsonValue>([0, -1, 1.5, "5", Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid maxIterations value %s",
    (maxIterations) => {
      const value = graph([node("loop", "loop", { maxIterations })]);

      expect(checkGraphJsonV1LoopBounds(value, resolver)).toMatchObject({
        valid: false,
        diagnostics: [
          {
            code: "GRAPH_LOOP_BOUND_INVALID",
            nodeId: "loop",
            configKey: "maxIterations",
            value: maxIterations,
          },
        ],
      });
    },
  );

  it("does not give loop meaning to the same config key on ordinary nodes", () => {
    const value = graph([node("ordinary", "ordinary", { maxIterations: 0 })]);

    expect(validateGraphJsonV1LoopBounds(value, resolver)).toBe(true);
  });

  it("fails explicitly when node resolution has not succeeded", () => {
    const value = graph([node("missing", "not-registered", { maxIterations: 3 })]);

    expect(checkGraphJsonV1LoopBounds(value, resolver)).toMatchObject({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_LOOP_BOUND_PREREQUISITE_FAILED",
          nodeId: "missing",
        },
      ],
    });
  });

  it("reserves a hard bound without overriding 2.10 cycle rejection", () => {
    const value = graph(
      [node("loop", "loop", { maxIterations: 5 }), node("body", "ordinary")],
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

    expect(validateGraphJsonV1LoopBounds(value, resolver)).toBe(true);
    expect(checkGraphJsonV1Acyclicity(value)).toMatchObject({
      valid: false,
      diagnostics: [{ code: "GRAPH_CYCLE_DETECTED", nodeIds: ["loop", "body"] }],
    });
  });

  it("does not absorb 2.13 graph resource-policy validation", () => {
    const value = graph([node("loop", "loop", { maxIterations: 5 })], [], [], {
      maxNodeExecutions: 1,
    });

    expect(validateGraphJsonV1LoopBounds(value, resolver)).toBe(true);
  });
});
