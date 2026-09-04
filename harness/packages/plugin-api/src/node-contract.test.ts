import { describe, expect, it } from "vitest";

import type { NodeDefinition } from "./index.js";

describe("universal node contract", () => {
  it("supports executable JSON-safe nodes with explicit input/output ports", async () => {
    const definition: NodeDefinition = {
      manifest: {
        type: "test.echo",
        version: "1",
        title: "Echo",
        description: "Returns its input value.",
        inputs: {
          value: {
            schema: true,
            required: true,
          },
        },
        outputs: {
          value: {
            schema: true,
            required: true,
          },
        },
        configSchema: {
          type: "object",
          additionalProperties: false,
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
    expect(definition.manifest.inputs.value).toEqual({ schema: true, required: true });
    expect(definition.manifest.outputs.value).toEqual({ schema: true, required: true });
    expect(definition.manifest.behavior).toMatchObject({
      primitiveFamily: "pure",
      determinism: "deterministic",
      effect: "none",
      executionMode: "in-process",
    });
    expect(result).toEqual({ outputs: { value: "hello" } });
  });

  it("represents compile-time/control definitions without fake runtime ports or executors", () => {
    const definition: NodeDefinition = {
      manifest: {
        type: "test.subgraph",
        version: "1",
        title: "Subgraph",
        inputs: {},
        outputs: {},
        configSchema: true,
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

    expect(definition.manifest.inputs).toEqual({});
    expect(definition.manifest.outputs).toEqual({});
    expect(definition.manifest.configSchema).toBe(true);
    expect(definition.manifest.behavior.executionMode).toBe("none");
    expect(definition.execute).toBeUndefined();
  });

  it("marks secret-only inputs and recoverable external writes statically", () => {
    const definition: NodeDefinition = {
      manifest: {
        type: "test.publish",
        version: "1",
        title: "Publish",
        inputs: {
          payload: { schema: true, required: true },
          apiKey: {
            schema: { type: "string" },
            required: true,
            secret: true,
          },
        },
        outputs: {
          publicationId: { schema: { type: "string" } },
        },
        configSchema: true,
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

    expect(definition.manifest.inputs.apiKey).toEqual({
      schema: { type: "string" },
      required: true,
      secret: true,
    });
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
