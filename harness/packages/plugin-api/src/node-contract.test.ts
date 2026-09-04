import { describe, expect, it } from "vitest";

import type { NodeDefinition } from "./index.js";

describe("universal node contract", () => {
  it("supports an executable JSON-safe node definition", async () => {
    const definition: NodeDefinition = {
      manifest: {
        type: "test.echo",
        version: "1",
        title: "Echo",
        description: "Returns its input value.",
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
    expect(result).toEqual({ outputs: { value: "hello" } });
  });

  it("allows compile-time/control definitions without a runtime executor", () => {
    const definition: NodeDefinition = {
      manifest: {
        type: "test.subgraph",
        version: "1",
        title: "Subgraph",
      },
    };

    expect(definition.execute).toBeUndefined();
  });
});
