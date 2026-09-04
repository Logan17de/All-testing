import { describe, expect, it } from "vitest";

import type { NodeBehavior, NodeManifest } from "@zet-harness/plugin-api";

import {
  checkGraphJsonV1EffectRecovery,
  validateGraphJsonV1EffectRecovery,
} from "./graph-json-v1-effect-recovery.js";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

const baseBehavior: NodeBehavior = {
  primitiveFamily: "pure",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "rerun",
  executionMode: "in-process",
  retry: { maxAttempts: 1 },
  requiredCapabilities: [],
};

function manifest(type: string, behavior: NodeBehavior): NodeManifest {
  return {
    type,
    version: "1.0.0",
    title: type,
    inputs: {},
    outputs: {},
    configSchema: true,
    behavior,
  };
}

const manifests: readonly NodeManifest[] = [
  manifest("pure", baseBehavior),
  manifest("read-nondeterministic", {
    ...baseBehavior,
    primitiveFamily: "effect",
    determinism: "nondeterministic",
    effect: "external-read",
    idempotency: "idempotent",
    retry: { maxAttempts: 3, backoffMs: 10 },
  }),
  manifest("write-keyed", {
    ...baseBehavior,
    primitiveFamily: "effect",
    determinism: "nondeterministic",
    effect: "external-write",
    idempotency: "idempotency-key",
    recovery: "reconcile",
    retry: { maxAttempts: 3, backoffMs: 50 },
  }),
  manifest("write-unknown-safe", {
    ...baseBehavior,
    primitiveFamily: "effect",
    determinism: "nondeterministic",
    effect: "external-write",
    idempotency: "unknown",
    recovery: "manual",
    retry: { maxAttempts: 1 },
  }),
  manifest("write-unknown-retry", {
    ...baseBehavior,
    primitiveFamily: "effect",
    determinism: "deterministic",
    effect: "external-write",
    idempotency: "unknown",
    recovery: "manual",
    retry: { maxAttempts: 2 },
  }),
  manifest("write-unknown-rerun", {
    ...baseBehavior,
    primitiveFamily: "effect",
    effect: "external-write",
    idempotency: "unknown",
    recovery: "rerun",
    retry: { maxAttempts: 1 },
  }),
  manifest("read-bad-idempotency", {
    ...baseBehavior,
    primitiveFamily: "effect",
    effect: "external-read",
    idempotency: "unknown",
  }),
  manifest("pure-bad-idempotency", {
    ...baseBehavior,
    idempotency: "idempotent",
  }),
  manifest("effect-family-none", {
    ...baseBehavior,
    primitiveFamily: "effect",
  }),
  manifest("pure-external-read", {
    ...baseBehavior,
    effect: "external-read",
    idempotency: "idempotent",
  }),
  manifest("compile-only-bad", {
    ...baseBehavior,
    primitiveFamily: "control",
    recovery: "rerun",
    executionMode: "none",
    retry: { maxAttempts: 2 },
  }),
  manifest("bad-retry", {
    ...baseBehavior,
    retry: { maxAttempts: 0, backoffMs: -1 },
  }),
  manifest("read-reconcile", {
    ...baseBehavior,
    primitiveFamily: "effect",
    effect: "external-read",
    idempotency: "idempotent",
    recovery: "reconcile",
  }),
];

const resolver: NodeManifestResolver = {
  getManifest(type, version) {
    return version === "1.0.0" ? manifests.find((item) => item.type === type) : undefined;
  },
};

function graph(...types: readonly string[]): GraphJsonV1 {
  const nodes = types.map((type, index) => ({
    id: `node-${index + 1}`,
    type,
    version: "1.0.0",
    config: {},
  }));

  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "effect-recovery.test",
    revisionId: "rev-001",
    inputs: [],
    outputs: [],
    nodes,
    edges: [],
    entrypoints: nodes.length === 0 ? [] : [{ id: "default", nodeId: nodes[0]!.id }],
  };
}

describe("Graph JSON v1 side-effect/retry/recovery validation", () => {
  it("accepts an executable pure node with rerun recovery", () => {
    expect(validateGraphJsonV1EffectRecovery(graph("pure"), resolver)).toBe(true);
  });

  it("keeps determinism separate from idempotency for nondeterministic external reads", () => {
    expect(validateGraphJsonV1EffectRecovery(graph("read-nondeterministic"), resolver)).toBe(true);
  });

  it("accepts idempotency-key writes with retries and reconcile recovery", () => {
    expect(validateGraphJsonV1EffectRecovery(graph("write-keyed"), resolver)).toBe(true);
  });

  it("accepts unknown writes only when automatic repetition is not requested", () => {
    expect(validateGraphJsonV1EffectRecovery(graph("write-unknown-safe"), resolver)).toBe(true);
  });

  it("does not let deterministic output make an unknown external write safe to retry", () => {
    expect(checkGraphJsonV1EffectRecovery(graph("write-unknown-retry"), resolver).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_EFFECT_RETRY_UNSAFE",
        nodeId: "node-1",
        field: "retry",
      }),
    ]);
  });

  it("rejects automatic rerun recovery for unknown external writes", () => {
    expect(checkGraphJsonV1EffectRecovery(graph("write-unknown-rerun"), resolver).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_EFFECT_RECOVERY_INVALID",
        nodeId: "node-1",
        field: "recovery",
      }),
    ]);
  });

  it("requires external reads to be side-effect-idempotent even when results may vary", () => {
    expect(
      checkGraphJsonV1EffectRecovery(graph("read-bad-idempotency"), resolver).diagnostics,
    ).toEqual([
      expect.objectContaining({
        code: "GRAPH_EFFECT_IDEMPOTENCY_INVALID",
        nodeId: "node-1",
        field: "idempotency",
      }),
    ]);
  });

  it("requires no-effect nodes to use not-applicable idempotency", () => {
    expect(checkGraphJsonV1EffectRecovery(graph("pure-bad-idempotency"), resolver).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_EFFECT_IDEMPOTENCY_INVALID",
        nodeId: "node-1",
      }),
    ]);
  });

  it("rejects primitive/effect family contradictions in both directions", () => {
    expect(
      checkGraphJsonV1EffectRecovery(graph("effect-family-none", "pure-external-read"), resolver)
        .diagnostics,
    ).toEqual([
      expect.objectContaining({
        code: "GRAPH_EFFECT_FAMILY_MISMATCH",
        nodeId: "node-1",
      }),
      expect.objectContaining({
        code: "GRAPH_EFFECT_FAMILY_MISMATCH",
        nodeId: "node-2",
      }),
    ]);
  });

  it("rejects recovery and retry metadata on compile-time nodes with no executor", () => {
    expect(checkGraphJsonV1EffectRecovery(graph("compile-only-bad"), resolver).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_EFFECT_RECOVERY_INVALID",
        nodeId: "node-1",
        field: "recovery",
      }),
      expect.objectContaining({
        code: "GRAPH_EFFECT_RETRY_INVALID",
        nodeId: "node-1",
        field: "retry",
      }),
    ]);
  });

  it("validates retry numeric bounds without normalizing them", () => {
    expect(checkGraphJsonV1EffectRecovery(graph("bad-retry"), resolver).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_EFFECT_RETRY_INVALID",
        nodeId: "node-1",
      }),
      expect.objectContaining({
        code: "GRAPH_EFFECT_RETRY_INVALID",
        nodeId: "node-1",
      }),
    ]);
  });

  it("reserves reconcile recovery for external writes", () => {
    expect(checkGraphJsonV1EffectRecovery(graph("read-reconcile"), resolver).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_EFFECT_RECOVERY_INVALID",
        nodeId: "node-1",
        field: "recovery",
      }),
    ]);
  });

  it("reports unresolved manifests only as a stage prerequisite failure", () => {
    expect(checkGraphJsonV1EffectRecovery(graph("missing"), resolver)).toMatchObject({
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_EFFECT_RECOVERY_PREREQUISITE_FAILED",
          nodeId: "node-1",
        },
      ],
    });
  });
});
