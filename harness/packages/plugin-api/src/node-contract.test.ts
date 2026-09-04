import { describe, expect, it } from "vitest";

import type { NodeDefinition } from "./index.js";

describe("universal node contract", () => {
  it("supports an executable JSON-safe node definition with static schemas and behavior", async () => {
    const definition: NodeDefinition = {
      manifest: {
        type: "test.echo",
        version: "1",
        title: "Echo",
        description: "Returns its input value.",
        inputSchema: {
          type: "object",
          properties: { value: true },
          required: ["value"],
        },
        configSchema: {
          type: "object",
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { value: true },
          required: ["value"],
        },
        behavior: {
          primitiveFamily: "pure",
          determinism: "deterministic",
          effect: "none",
          idempotency: "not-applicable",
          recovery: "rerun",
          executionMode: "in-process",
          timeoutMs: 1_000,
          retry: { maxAttempts: 1 },
          requiredCapabilities: [],
        },
      },
      execute(request, context) {
        expect(context.signal.aborted).toBe(false);
        return { outputs: { value: request.inputs.value ?? null } };
      },
    };

    const controller = new AbortController();
    const result = await definition.execute?.(
      { inputs: { value: "hello" }, config: {} },
      { signal: controller.signal },
    );

    expect(definition.manifest.type).toBe("test.echo");
    expect(definition.manifest.inputSchema).toEqual({
      type: "object",
      properties: { value: true },
      required: ["value"],
    });
    expect(definition.manifest.behavior).toMatchObject({
      primitiveFamily: "pure",
      determinism: "deterministic",
      effect: "none",
      executionMode: "in-process",
    });
    expect(result).toEqual({ outputs: { value: "hello" } });
  });

  it("represents compile-time/control definitions without a fake runtime executor", () => {
    const definition: NodeDefinition = {
      manifest: {
        type: "test.subgraph",
        version: "1",
        title: "Subgraph",
        inputSchema: true,
        configSchema: true,
        outputSchema: true,
        behavior: {
          primitiveFamily: "control",
          determinism: "deterministic",
          effect: "none",
          idempotency: "not-applicable",
          recovery: "not-applicable",
          executionMode: "none",
          requiredCapabilities: [],
        },
      },
    };

    expect(definition.manifest.configSchema).toBe(true);
    expect(definition.manifest.behavior.executionMode).toBe("none");
    expect(definition.execute).toBeUndefined();
  });

  it("describes recoverable capability-gated external writes statically", () => {
    const definition: NodeDefinition = {
      manifest: {
        type: "test.publish",
        version: "1",
        title: "Publish",
        inputSchema: true,
        configSchema: true,
        outputSchema: true,
        behavior: {
          primitiveFamily: "effect",
          determinism: "nondeterministic",
          effect: "external-write",
          idempotency: "idempotency-key",
          recovery: "reconcile",
          executionMode: "process",
          timeoutMs: 30_000,
          retry: { maxAttempts: 3, backoffMs: 500 },
          requiredCapabilities: ["network:http", "publish:write"],
        },
      },
    };

    expect(definition.manifest.behavior).toEqual({
      primitiveFamily: "effect",
      determinism: "nondeterministic",
      effect: "external-write",
      idempotency: "idempotency-key",
      recovery: "reconcile",
      executionMode: "process",
      timeoutMs: 30_000,
      retry: { maxAttempts: 3, backoffMs: 500 },
      requiredCapabilities: ["network:http", "publish:write"],
    });
  });
});
