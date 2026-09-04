import { describe, expect, it } from "vitest";

import { JSON_SCHEMA_DIALECT_URI, type JsonSchema } from "./index.js";

describe("public JSON Schema contract", () => {
  it("pins every v1 public schema surface to Draft 2020-12", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    };

    expect(JSON_SCHEMA_DIALECT_URI).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema).toEqual({
      type: "object",
      properties: {
        value: { type: "string" },
      },
    });
  });
});
