import { describe, expect, it } from "vitest";

import type { NodeDefinition } from "./index.js";

describe("universal node contract", () => {
  it("supports an executable JSON-safe node definition with static schemas", async () => {
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
    expect(result).toEqual({ outputs: { value: "hello" } });
  });

  it("allows boolean JSON schemas and compile-time/control definitions", () => {
    const definition: NodeDefinition = {
      manifest: {
        type: "test.subgraph",
        version: "1",
        title: "Subgraph",
        inputSchema: true,
        configSchema: true,
        outputSchema: true,
      },
    };

    expect(definition.manifest.configSchema).toBe(true);
    expect(definition.execute).toBeUndefined();
  });
});
