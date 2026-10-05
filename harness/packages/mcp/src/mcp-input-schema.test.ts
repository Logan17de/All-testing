import { describe, expect, it, vi } from "vitest";
import type { AdapterInvocationContext, JsonObject } from "@zet-harness/plugin-api";
import { McpStdioClient } from "./mcp-client.js";
import { createMcpToolAdapter } from "./mcp-tools.js";
import { createMcpInputValidator } from "./mcp-input-schema.js";
function context(): AdapterInvocationContext {
  return {
    runId: "r",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "e",
    signal: new AbortController().signal,
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => 0,
    },
  };
}
function fixture(schema: Record<string, unknown>) {
  const registration = { id: "fixture", command: process.execPath, args: [] };
  const client = new McpStdioClient(registration);
  const call = vi
    .spyOn(client, "callTool")
    .mockResolvedValue({ content: [{ type: "text", text: "ok" }], isError: false });
  const descriptor = { name: "echo", inputSchema: schema };
  return {
    client,
    call,
    descriptor,
    adapter: createMcpToolAdapter(client, registration, descriptor),
  };
}
const boundedSchema = {
  type: "object",
  required: ["message", "count", "values"],
  additionalProperties: false,
  properties: {
    message: { type: "string", minLength: 1, maxLength: 3 },
    count: { type: "integer", minimum: 1, maximum: 3 },
    values: { type: "array", minItems: 1, maxItems: 2, items: { type: ["null", "boolean"] } },
  },
};
describe("bounded MCP input JSON Schema subset", () => {
  it("validates before remote call and never echoes credential values", async () => {
    const { adapter, call } = fixture(boundedSchema);
    const credential = "credential-must-not-leak";
    for (const input of [
      { message: credential, count: 1, values: [null] },
      { message: "ok", count: 1.5, values: [null] },
      { message: "ok", count: 2, values: [] },
      { message: "ok", count: 2, values: ["bad"] },
      { message: "ok", count: 2, values: [null], extra: true },
      { count: 2, values: [null] },
    ]) {
      await expect(adapter.invoke(input as JsonObject, context())).rejects.toThrow(
        "MCP tool input validation failed.",
      );
    }
    expect(call).not.toHaveBeenCalled();
    const error: unknown = await adapter
      .invoke({ message: credential, count: 1, values: [null] }, context())
      .catch((error: unknown) => error);
    expect((error as Error).message).not.toContain(credential);
  });
  it("accepts nullable values, Unicode codepoint lengths and numeric/array boundary values", async () => {
    const { adapter, call } = fixture(boundedSchema);
    await adapter.invoke({ message: "🌍", count: 1, values: [null, false] }, context());
    await adapter.invoke({ message: "abc", count: 3, values: [true] }, context());
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]![1]).toEqual({ message: "🌍", count: 1, values: [null, false] });
  });
  it("captures immutable schema and tool name even if original descriptor changes", async () => {
    const schema = {
      type: "object",
      required: ["message"],
      additionalProperties: false,
      properties: { message: { type: "string", maxLength: 2 } },
    };
    const { adapter, call, descriptor } = fixture(schema);
    schema.properties.message.maxLength = 200;
    schema.required = [];
    descriptor.name = "other";
    expect(Object.isFrozen(adapter.manifest.inputSchema)).toBe(true);
    expect(() => {
      (
        (adapter.manifest.inputSchema as Record<string, unknown>).properties as Record<
          string,
          unknown
        >
      ).message = {};
    }).toThrow();
    await expect(adapter.invoke({ message: "invalid" }, context())).rejects.toThrow(
      "validation failed",
    );
    expect(call).not.toHaveBeenCalled();
    await adapter.invoke({ message: "ok" }, context());
    expect(call.mock.calls[0]![0]).toBe("echo");
  });
  it("sends a separate deeply frozen input snapshot", async () => {
    const { adapter, call } = fixture({
      type: "object",
      properties: { nested: { type: "object" } },
    });
    const input = { nested: { value: "original" } };
    await adapter.invoke(input, context());
    input.nested.value = "changed";
    expect(call.mock.calls[0]![1]).toEqual({ nested: { value: "original" } });
    expect(Object.isFrozen(call.mock.calls[0]![1])).toBe(true);
    expect(Object.isFrozen(call.mock.calls[0]![1].nested)).toBe(true);
  });
  it.each([
    "$ref",
    "$defs",
    "pattern",
    "format",
    "uniqueItems",
    "prefixItems",
    "unevaluatedProperties",
    "dependentRequired",
    "not",
    "multipleOf",
  ])("refuses unsupported assertion %s instead of silently ignoring it", (keyword) => {
    expect(() =>
      fixture({ type: "object", [keyword]: keyword === "$ref" ? "https://remote/secret" : {} }),
    ).toThrow("schema is unsupported or invalid");
  });
  it("ignores known annotations and supports schema-valued additionalProperties", () => {
    const { validate } = createMcpInputValidator({
      type: "object",
      title: "annotation",
      description: "annotation",
      default: { anything: true },
      examples: [{}],
      properties: { fixed: true },
      additionalProperties: { type: "integer", minimum: 0 },
    });
    expect(validate({ fixed: "unconstrained", other: 0 })).toEqual({
      fixed: "unconstrained",
      other: 0,
    });
    expect(() => validate({ other: -1 })).toThrow("validation failed");
  });
  it("supports enums and const with object-key-order-independent JSON equality", () => {
    const { validate } = createMcpInputValidator({
      type: "object",
      properties: { choice: { enum: [null, { a: 1, b: [true] }] }, fixed: { const: "value" } },
      required: ["choice", "fixed"],
    });
    expect(validate({ choice: { b: [true], a: 1 }, fixed: "value" })).toEqual({
      choice: { b: [true], a: 1 },
      fixed: "value",
    });
    expect(() => validate({ choice: 0, fixed: "value" })).toThrow();
    expect(() => validate({ choice: null, fixed: "changed" })).toThrow();
  });
  it("handles anyOf/oneOf/allOf soundly, rejecting overlapping oneOf matches", () => {
    const { validate } = createMcpInputValidator({
      type: "object",
      properties: {
        value: {
          allOf: [{ type: "number" }, { exclusiveMinimum: 0 }],
          anyOf: [{ maximum: 2 }, { minimum: 4 }],
          oneOf: [{ maximum: 5 }, { minimum: 5 }],
        },
      },
    });
    expect(validate({ value: 1 })).toEqual({ value: 1 });
    expect(validate({ value: 6 })).toEqual({ value: 6 });
    for (const value of [0, 3, 5, "x"]) expect(() => validate({ value })).toThrow();
  });
  it("enforces min/maxProperties and false property schemas", () => {
    const { validate } = createMcpInputValidator({
      type: "object",
      minProperties: 1,
      maxProperties: 2,
      properties: { blocked: false },
    });
    expect(() => validate({})).toThrow();
    expect(() => validate({ a: 1, b: 2, c: 3 })).toThrow();
    expect(() => validate({ blocked: null })).toThrow();
    expect(validate({ a: 1 })).toEqual({ a: 1 });
  });
  it.each([
    { type: "unknown" },
    { type: ["string", "string"] },
    { required: ["a", "a"] },
    { minimum: true },
    { maxLength: -1 },
    { items: [{}] },
    { anyOf: [] },
    { properties: [] },
    { $schema: "unknown-dialect" },
  ])("rejects malformed schema definition %#", (schema) => {
    expect(() => createMcpInputValidator(schema)).toThrow("schema is unsupported or invalid");
  });
  it("rejects cyclic/oversized/accessor input without executing getters or remote calls", async () => {
    const { adapter, call } = fixture({ type: "object" });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const getter = vi.fn(() => "credential");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    for (const input of [
      cyclic,
      accessor,
      { huge: "x".repeat(262145) },
      { number: Infinity },
      { missing: undefined },
      { values: new Array(2) },
    ])
      await expect(adapter.invoke(input, context())).rejects.toThrow("validation failed");
    expect(getter).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });
  it("rejects cyclic or overly deep schemas before registering a tool", () => {
    const schema: Record<string, unknown> = { type: "object" };
    schema.properties = { nested: schema };
    expect(() => fixture(schema)).toThrow("unsupported or invalid");
    let deep: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 20; index++)
      deep = { type: "object", properties: { nested: deep } };
    expect(() => fixture(deep)).toThrow("unsupported or invalid");
  });
});
