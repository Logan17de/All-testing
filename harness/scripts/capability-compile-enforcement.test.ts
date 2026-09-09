// Phase 5.6 integration proves the real host policy gates compilation without adding Graph-to-Core coupling.
import { describe, expect, it } from "vitest";

import { CapabilityPermissionPolicy } from "@zet-harness/core";
import {
  GRAPH_JSON_VERSION,
  canonicalizeGraphJsonV1Semantics,
  checkGraphJsonV1CapabilityPolicy,
  checkGraphJsonV1Diagnostics,
  lowerCanonicalGraphJsonV1ToExecutionIr,
  normalizeGraphJsonV1,
  stripGraphJsonV1UiMetadata,
  type GraphJsonV1,
  type NodeResolutionResolver,
} from "@zet-harness/graph";
import type { NodeManifest } from "@zet-harness/plugin-api";

const manifest: NodeManifest = {
  type: "integration.network-read",
  version: "1",
  title: "Integration network read",
  inputs: {},
  outputs: { result: { schema: { type: "string" } } },
  configSchema: { type: "object" },
  behavior: {
    primitiveFamily: "effect",
    determinism: "nondeterministic",
    effect: "external-read",
    idempotency: "idempotent",
    recovery: "rerun",
    executionMode: "in-process",
    requiredCapabilities: ["network:https"],
  },
};

const resolver: NodeResolutionResolver = {
  getManifest(type, version) {
    return type === manifest.type && version === manifest.version ? manifest : undefined;
  },
  getResolution(type, version) {
    return type === manifest.type && version === manifest.version
      ? { manifest, plugin: { id: "integration.plugin", version: "1" } }
      : undefined;
  },
};

function graph(): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "phase-5.6.integration",
    revisionId: "rev-1",
    inputs: [],
    outputs: [
      {
        id: "result",
        schema: { type: "string" },
        source: { nodeId: "call", port: "result" },
      },
    ],
    nodes: [{ id: "call", type: manifest.type, version: manifest.version, config: {} }],
    edges: [],
    entrypoints: [{ id: "main", nodeId: "call" }],
    policies: {
      capabilities: {
        required: ["project:read"],
        optional: ["telemetry:emit"],
      },
    },
  };
}

describe("Phase 5.6 compile-time capability enforcement", () => {
  it("uses the real host policy for graph and node demand before lowering", () => {
    const value = graph();
    const policy = new CapabilityPermissionPolicy({
      granted: ["project:read", "network:https", "telemetry:emit", "unrequested"],
    });

    expect(checkGraphJsonV1CapabilityPolicy(value, resolver, policy)).toEqual({
      valid: true,
      requiredCapabilities: ["project:read", "network:https"],
      optionalCapabilities: ["telemetry:emit"],
      effectiveCapabilities: ["project:read", "network:https", "telemetry:emit"],
      diagnostics: [],
    });
    expect(checkGraphJsonV1Diagnostics(value, { resolver, capabilityAuthority: policy })).toEqual({
      valid: true,
      diagnostics: [],
    });

    const normalized = normalizeGraphJsonV1(value, resolver);
    if (!normalized.valid || normalized.normalized === undefined) {
      throw new Error("expected normalized graph");
    }
    const canonical = canonicalizeGraphJsonV1Semantics(
      stripGraphJsonV1UiMetadata(normalized.normalized),
    );
    const ir = lowerCanonicalGraphJsonV1ToExecutionIr(canonical, resolver);
    expect(ir.ops).toHaveLength(1);
    expect(ir.ops[0]?.sourceNodeId).toBe("call");
  });

  it("blocks a host-explicitly-denied manifest requirement", () => {
    const policy = new CapabilityPermissionPolicy({
      granted: ["project:read", "network:https"],
      denied: ["network:https"],
    });
    const result = checkGraphJsonV1Diagnostics(graph(), {
      resolver,
      capabilityAuthority: policy,
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "GRAPH_CAPABILITY_REQUIRED_DENIED",
        stage: "capability-policy",
        nodeId: "call",
        path: "/nodes/0",
      }),
    );
  });

  it("blocks a host-explicitly-denied graph requirement at the frozen policy path", () => {
    const policy = new CapabilityPermissionPolicy({
      granted: ["project:read", "network:https"],
      denied: ["project:read"],
    });
    const result = checkGraphJsonV1Diagnostics(graph(), {
      resolver,
      capabilityAuthority: policy,
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "GRAPH_CAPABILITY_REQUIRED_DENIED",
        stage: "capability-policy",
        path: "/policies/capabilities/required",
      }),
    );
  });
});
