import { describe, expect, it } from "vitest";

import type { NodeManifest, NodeStructuredControlContract } from "@zet-harness/plugin-api";

import { checkGraphJsonV1Acyclicity } from "./graph-json-v1-acyclicity.js";
import {
  checkGraphJsonV1CapabilityPolicy,
  validateGraphJsonV1CapabilityPolicy,
} from "./graph-json-v1-capability-policy.js";
import { validateGraphJsonV1LoopBounds } from "./graph-json-v1-loop-bounds.js";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

function manifest(
  type: string,
  requiredCapabilities: readonly string[] = [],
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
      primitiveFamily: control === undefined ? "effect" : "control",
      determinism: "deterministic",
      effect: control === undefined ? "external-read" : "none",
      idempotency: control === undefined ? "idempotent" : "not-applicable",
      recovery: control === undefined ? "rerun" : "not-applicable",
      executionMode: control === undefined ? "in-process" : "none",
      requiredCapabilities,
    },
    ...(control === undefined ? {} : { control }),
  };
}

const manifests: readonly NodeManifest[] = [
  manifest("network", ["network:https"]),
  manifest("filesystem", ["fs:read"]),
  manifest("ordinary"),
  manifest("loop", [], {
    kind: "loop",
    entry: "enter",
    continue: "continue",
    body: "body",
    exit: "exit",
  }),
];

const resolver: NodeManifestResolver = {
  getManifest(type, version) {
    return version === "1.0.0" ? manifests.find((item) => item.type === type) : undefined;
  },
};

function node(id: string, type: string, config: GraphJsonV1["nodes"][number]["config"] = {}) {
  return { id, type, version: "1.0.0", config } as const;
}

function graph(
  nodes: GraphJsonV1["nodes"],
  policies?: GraphJsonV1["policies"],
  edges: GraphJsonV1["edges"] = [],
): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "capability-policy.test",
    revisionId: "rev-001",
    inputs: [],
    outputs: [],
    nodes,
    edges,
    entrypoints: nodes.length === 0 ? [] : [{ id: "default", nodeId: nodes[0]!.id }],
    ...(policies === undefined ? {} : { policies }),
  };
}

describe("Graph JSON v1 capability/policy validation", () => {
  it("accepts externally granted graph and node requirements and computes effective authority", () => {
    const value = graph([node("call", "network")], {
      capabilities: {
        required: ["project:read"],
        optional: ["telemetry:emit"],
      },
    });

    expect(
      checkGraphJsonV1CapabilityPolicy(value, resolver, {
        granted: ["project:read", "telemetry:emit", "network:https", "unrequested:grant"],
      }),
    ).toEqual({
      valid: true,
      requiredCapabilities: ["project:read", "network:https"],
      optionalCapabilities: ["telemetry:emit"],
      effectiveCapabilities: ["project:read", "network:https", "telemetry:emit"],
      diagnostics: [],
    });
  });

  it("does not let Graph JSON elevate itself by declaring an ungranted required capability", () => {
    const value = graph([node("plain", "ordinary")], {
      capabilities: { required: ["admin:dangerous"] },
    });

    expect(checkGraphJsonV1CapabilityPolicy(value, resolver, { granted: [] }).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_CAPABILITY_REQUIRED_UNAVAILABLE",
        capability: "admin:dangerous",
        policyField: "required",
      }),
    ]);
  });

  it("requires manifest-declared node capabilities even when graph policy omits them", () => {
    const value = graph([node("read", "filesystem")]);

    expect(checkGraphJsonV1CapabilityPolicy(value, resolver, { granted: [] }).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_CAPABILITY_REQUIRED_UNAVAILABLE",
        capability: "fs:read",
        nodeId: "read",
      }),
    ]);
  });

  it("treats optional capabilities as opportunistic rather than compile requirements", () => {
    const value = graph([node("plain", "ordinary")], {
      capabilities: { optional: ["telemetry:emit"] },
    });

    expect(checkGraphJsonV1CapabilityPolicy(value, resolver, { granted: [] })).toEqual({
      valid: true,
      requiredCapabilities: [],
      optionalCapabilities: ["telemetry:emit"],
      effectiveCapabilities: [],
      diagnostics: [],
    });
  });

  it("lets graph deny only reduce authority and rejects denial of a node hard requirement", () => {
    const value = graph([node("call", "network")], {
      capabilities: { deny: ["network:https"] },
    });

    expect(
      checkGraphJsonV1CapabilityPolicy(value, resolver, { granted: ["network:https"] }).diagnostics,
    ).toEqual([
      expect.objectContaining({
        code: "GRAPH_CAPABILITY_REQUIRED_DENIED",
        capability: "network:https",
        nodeId: "call",
        policyField: "deny",
      }),
    ]);
  });

  it("rejects duplicate and cross-bucket capability intent deterministically", () => {
    const value = graph([node("plain", "ordinary")], {
      capabilities: {
        required: ["same", "same"],
        optional: ["same"],
        deny: ["other", "same"],
      },
    });

    expect(
      checkGraphJsonV1CapabilityPolicy(value, resolver, { granted: ["same", "other"] }).diagnostics,
    ).toEqual([
      expect.objectContaining({
        code: "GRAPH_CAPABILITY_INTENT_DUPLICATE",
        capability: "same",
        policyField: "required",
      }),
      expect.objectContaining({
        code: "GRAPH_CAPABILITY_INTENT_CONFLICT",
        capability: "same",
        policyField: "optional",
      }),
      expect.objectContaining({
        code: "GRAPH_CAPABILITY_INTENT_CONFLICT",
        capability: "same",
        policyField: "deny",
      }),
      expect.objectContaining({
        code: "GRAPH_CAPABILITY_REQUIRED_DENIED",
        capability: "same",
        policyField: "required",
      }),
      expect.objectContaining({
        code: "GRAPH_CAPABILITY_REQUIRED_DENIED",
        capability: "same",
        policyField: "required",
      }),
    ]);
  });

  it("rejects unresolved manifests as a stage prerequisite failure", () => {
    const value = graph([node("missing", "not-registered")]);

    expect(checkGraphJsonV1CapabilityPolicy(value, resolver, { granted: [] })).toMatchObject({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_CAPABILITY_POLICY_PREREQUISITE_FAILED",
          nodeId: "missing",
        },
      ],
    });
  });

  it("cross-checks a valid 2.12 loop bound against graph maxNodeExecutions", () => {
    const value = graph([node("loop", "loop", { maxIterations: 8 })], {
      maxNodeExecutions: 5,
    });

    expect(validateGraphJsonV1LoopBounds(value, resolver)).toBe(true);
    expect(checkGraphJsonV1CapabilityPolicy(value, resolver, { granted: [] }).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_POLICY_LOOP_BOUND_EXCEEDS_MAX_NODE_EXECUTIONS",
        nodeId: "loop",
        policyField: "maxNodeExecutions",
      }),
    ]);
  });

  it("accepts loop bounds within maxNodeExecutions and ignores ordinary maxIterations config", () => {
    const value = graph(
      [
        node("loop", "loop", { maxIterations: 5 }),
        node("plain", "ordinary", { maxIterations: 999 }),
      ],
      { maxNodeExecutions: 5 },
    );

    expect(validateGraphJsonV1CapabilityPolicy(value, resolver, { granted: [] })).toBe(true);
  });

  it("does not let a valid bound weaken 2.10 cycle rejection", () => {
    const value = graph(
      [node("loop", "loop", { maxIterations: 3 }), node("body", "ordinary")],
      { maxNodeExecutions: 10 },
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
    );

    expect(validateGraphJsonV1CapabilityPolicy(value, resolver, { granted: [] })).toBe(true);
    expect(checkGraphJsonV1Acyclicity(value)).toMatchObject({
      valid: false,
      diagnostics: [{ code: "GRAPH_CYCLE_DETECTED", nodeIds: ["loop", "body"] }],
    });
  });
});
