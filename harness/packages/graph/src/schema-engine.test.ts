import { describe, expect, it } from "vitest";

import { JSON_SCHEMA_DIALECT_URI } from "@zet-harness/plugin-api";

import { createDraft202012SchemaEngine } from "./schema-engine.js";

describe("Draft 2020-12 schema engine boundary", () => {
  it("compiles the frozen dialect and validates only local shape/value constraints", () => {
    const ajv = createDraft202012SchemaEngine();
    const validate = ajv.compile({
      $schema: JSON_SCHEMA_DIALECT_URI,
      type: "object",
      properties: {
        timeoutMs: { type: "integer", minimum: 1 },
        tuple: {
          type: "array",
          prefixItems: [{ type: "string" }],
          items: false,
          minItems: 1,
          maxItems: 1,
        },
      },
      required: ["timeoutMs", "tuple"],
      additionalProperties: false,
    });

    expect(validate({ timeoutMs: 250, tuple: ["ok"] })).toBe(true);
    expect(validate({ timeoutMs: 0, tuple: ["ok"] })).toBe(false);
    expect(validate({ timeoutMs: 250, tuple: [123] })).toBe(false);
    expect(validate({ timeoutMs: 250, tuple: ["ok"], extra: true })).toBe(false);
  });
});
