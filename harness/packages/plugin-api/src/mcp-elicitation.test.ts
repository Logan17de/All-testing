import { describe, expect, it } from "vitest";
import { isSupportedMcpForm, mcpEnumOptions, validateMcpFormContent } from "./mcp-elicitation.js";
const schema = {
  type: "object",
  required: ["color", "colors", "age"],
  properties: {
    color: {
      type: "string",
      oneOf: [
        { const: "r", title: "Red" },
        { const: "b", title: "Blue" },
      ],
    },
    colors: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        anyOf: [
          { const: "r", title: "Red" },
          { const: "b", title: "Blue" },
        ],
      },
    },
    age: { type: "integer", minimum: 18, maximum: 100 },
    date: { type: "string", format: "date" },
  },
};
describe("bounded official MCP form schemas", () => {
  it("validates titled single/multiple selections and scalar constraints", () => {
    expect(isSupportedMcpForm(schema)).toBe(true);
    expect(mcpEnumOptions(schema.properties.color)).toEqual([
      { value: "r", label: "Red" },
      { value: "b", label: "Blue" },
    ]);
    expect(
      validateMcpFormContent(schema, {
        color: "r",
        colors: ["r", "b"],
        age: 18,
        date: "2024-02-29",
      }),
    ).toBe(true);
    for (const patch of [
      { color: "invalid" },
      { colors: ["r", "r"] },
      { colors: [] },
      { age: 17 },
      { age: 18.5 },
      { date: "2025-02-29" },
      { injected: true },
    ]) {
      expect(validateMcpFormContent(schema, { color: "r", colors: ["r"], age: 18, ...patch })).toBe(
        false,
      );
    }
    expect(validateMcpFormContent(schema, { color: "r", colors: ["r"] })).toBe(false);
  });
  it("rejects unsupported optional schemas even when answers omit them", () => {
    for (const field of [
      { type: "object", properties: {} },
      { type: "string", pattern: "(a+)+$" },
      { type: "array", items: { type: "object" } },
      { type: "string", oneOf: [{ const: "r", title: "Red" }], enum: ["r"] },
      { type: "string", default: 3 },
      { type: "number", minimum: Number.NaN },
    ]) {
      const malformed = { type: "object", properties: { optional: field } };
      expect(isSupportedMcpForm(malformed)).toBe(false);
      expect(validateMcpFormContent(malformed, {})).toBe(false);
    }
  });
  it("supports legacy labels/untitled multi-select and rejects malformed choice schemas", () => {
    expect(mcpEnumOptions({ enum: ["r"], enumNames: ["Red"] })).toEqual([
      { value: "r", label: "Red" },
    ]);
    expect(
      isSupportedMcpForm({
        type: "object",
        properties: {
          colors: { type: "array", items: { type: "string", enum: ["r"] }, default: ["r"] },
        },
      }),
    ).toBe(true);
    for (const choices of [
      { enum: ["r", "r"] },
      { enum: ["r"], enumNames: [] },
      { oneOf: [{ const: "r", title: "Red", executable: "danger" }] },
      { anyOf: [] },
    ])
      expect(mcpEnumOptions(choices)).toBeUndefined();
  });
  it("refuses named sensitive fields, prototype keys and invalid defaults", () => {
    expect(
      isSupportedMcpForm({ type: "object", properties: { api_key: { type: "string" } } }),
    ).toBe(false);
    expect(
      isSupportedMcpForm(
        JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'),
      ),
    ).toBe(false);
    expect(
      isSupportedMcpForm({
        type: "object",
        properties: { name: { type: "string", title: "Access token" } },
      }),
    ).toBe(false);
    expect(
      isSupportedMcpForm({
        type: "object",
        properties: { n: { type: "integer", minimum: 1, default: 0 } },
      }),
    ).toBe(false);
    expect(isSupportedMcpForm({ type: "object", properties: {}, required: ["missing"] })).toBe(
      false,
    );
  });
  it("strictly validates date-time formats without arbitrary regular expressions", () => {
    const form = { type: "object", properties: { stamp: { type: "string", format: "date-time" } } };
    expect(validateMcpFormContent(form, { stamp: "2024-02-29T23:59:59+01:00" })).toBe(true);
    for (const stamp of [
      "2025-02-29T23:59:59Z",
      "2024-02-29T24:00:00Z",
      "2024-02-29T12:00:00",
      "nonsense",
    ])
      expect(validateMcpFormContent(form, { stamp })).toBe(false);
  });
});
