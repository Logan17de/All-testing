import { describe, expect, it, vi } from "vitest";

import {
  CapabilityPermissionPolicy,
  HUMAN_APPROVAL_NODE_TYPE,
  PluginHost,
  createHumanApprovalPlugin,
  createNodeSecretAccessor,
} from "@zet-harness/core";
import {
  GRAPH_JSON_VERSION,
  canonicalizeGraphJsonV1Semantics,
  checkGraphJsonV1Diagnostics,
  lowerCanonicalGraphJsonV1ToExecutionIr,
  normalizeGraphJsonV1,
  stripGraphJsonV1UiMetadata,
  type GraphJsonV1,
} from "@zet-harness/graph";
import { SecretValue } from "@zet-harness/plugin-api/secret-contract";
import { RuntimeRedactionRegistry } from "../apps/runtime/src/runtime-redaction.js";

describe("human gate and secret redaction integration", () => {
  it("registers and compiles a human gate through the normal public plugin path", async () => {
    const host = new PluginHost();
    try {
      await host.activate(createHumanApprovalPlugin());
      const graph: GraphJsonV1 = {
        schemaVersion: GRAPH_JSON_VERSION,
        graphId: "human-gate-test",
        revisionId: "1",
        inputs: [],
        outputs: [{ id: "response", schema: true, source: { nodeId: "gate", port: "response" } }],
        nodes: [{ id: "gate", type: HUMAN_APPROVAL_NODE_TYPE, version: "1", config: { prompt: "Proceed?" } }],
        edges: [],
        entrypoints: [{ id: "main", nodeId: "gate" }],
      };
      expect(
        checkGraphJsonV1Diagnostics(graph, {
          resolver: host.nodes,
          capabilityAuthority: new CapabilityPermissionPolicy(),
        }),
      ).toEqual({ valid: true, diagnostics: [] });
      const normalized = normalizeGraphJsonV1(graph, host.nodes);
      if (!normalized.valid || normalized.normalized === undefined) {
        throw new Error("Expected normal compiler normalization.");
      }
      const ir = lowerCanonicalGraphJsonV1ToExecutionIr(
        canonicalizeGraphJsonV1Semantics(stripGraphJsonV1UiMetadata(normalized.normalized)),
        host.nodes,
      );
      expect(ir.ops[0]?.behavior.primitiveFamily).toBe("interrupt");
      expect(ir.ops[0]?.behavior.effect).toBe("none");
      expect(ir.ops[0]?.control).toBeUndefined();
      const execute = host.nodes.getDefinition(HUMAN_APPROVAL_NODE_TYPE, "1")?.execute;
      if (execute === undefined) throw new Error("Expected a fail-closed execution guard.");
      expect(() => {
        Reflect.apply(execute, undefined, []);
      }).toThrow("durable host interrupt boundary");
    } finally {
      await host.dispose();
    }
  });

  it("registers resolved secret material before exposing it and only once per reference", async () => {
    const registry = new RuntimeRedactionRegistry();
    const observe = vi.fn((secret: SecretValue) => {
      registry.registerSecret(secret.revealText());
    });
    const accessor = createNodeSecretAccessor(
      [{ port: "key", secretRef: "local:test-key" }],
      { resolve: () => new SecretValue("private-provider-value") },
      observe,
    );
    expect(observe).not.toHaveBeenCalled();
    const secret = await accessor.get("key");
    expect(registry.redact({ detail: secret.revealText() })).toEqual({ detail: "[REDACTED]" });
    await accessor.get("key");
    expect(observe).toHaveBeenCalledOnce();
    expect(Reflect.has(accessor, "onResolve")).toBe(false);
    expect(() => registry.assertSafe({ result: secret.revealText() })).toThrow("protected material");
  });

  it("fails closed with a safe error if the host redaction observer fails", async () => {
    const accessor = createNodeSecretAccessor(
      [{ port: "key", secretRef: "local:test-key" }],
      { resolve: () => new SecretValue("unexposed-material") },
      () => { throw new Error("private-observer-detail"); },
    );
    const error: unknown = await accessor.get("key").catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "SECRET_PROVIDER_FAILED" });
    expect(String(error)).not.toContain("private-observer-detail");
    expect(String(error)).not.toContain("unexposed-material");
  });
});
