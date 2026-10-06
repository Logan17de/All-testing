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
    "pattern",
    "format",
    "uniqueItems",
    "prefixItems",
    "unevaluatedProperties",
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

describe("bounded local references and additional assertions", () => {
  it("resolves escaped local pointers, freezes original schema and enforces modern ref siblings", () => {
    const source = {
      type: "object",
      $defs: { "a/b~c": { type: "string", minLength: 2 } },
      properties: {
        text: { $ref: "#/$defs/a~1b~0c", maxLength: 3 },
      },
    };
    const { validate, schema } = createMcpInputValidator(source);
    source.$defs["a/b~c"].minLength = 0;
    expect(Object.isFrozen((schema as Record<string, unknown>).$defs)).toBe(true);
    expect(validate({ text: "abc" })).toEqual({ text: "abc" });
    expect(() => validate({ text: "a" })).toThrow();
    expect(() => validate({ text: "abcd" })).toThrow();
  });
  it("supports draft07 references with ignored sibling assertions", () => {
    const { validate } = createMcpInputValidator({
      $schema: "http://json-schema.org/draft-07/schema#",
      definitions: { text: { type: "string" } },
      properties: { value: { $ref: "#/definitions/text", maxLength: 0 } },
    });
    expect(validate({ value: "nonempty" })).toEqual({ value: "nonempty" });
    expect(() => validate({ value: 0 })).toThrow();
  });
  it.each([
    { $ref: "https://remote.example/schema" },
    { $ref: "#/missing" },
    { $ref: "#/title", title: "not schema" },
    { $defs: { x: { $ref: "#/$defs/x" } }, properties: { x: { $ref: "#/$defs/x" } } },
    { $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } } },
    { $defs: { x: { $id: "nested", type: "string" } } },
    { properties: { x: { $schema: "https://json-schema.org/draft/2020-12/schema" } } },
    { $ref: "#/$defs/bad~2escape", $defs: { "bad~2escape": {} } },
  ])("rejects external, malformed, cyclic or scoped references %#", (schema) => {
    expect(() => createMcpInputValidator(schema)).toThrow("unsupported or invalid");
  });
  it("enforces draft2020 tuples, trailing items and deep unique equality", () => {
    const { validate } = createMcpInputValidator({
      properties: {
        tuple: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "integer" }],
          items: false,
        },
        unique: { uniqueItems: true },
      },
    });
    expect(validate({ tuple: ["ok", 2], unique: [{ a: 1 }, { a: 2 }] })).toEqual({
      tuple: ["ok", 2],
      unique: [{ a: 1 }, { a: 2 }],
    });
    for (const input of [
      { tuple: ["ok", "bad"] },
      { tuple: ["ok", 2, null] },
      {
        unique: [
          { a: 1, b: 2 },
          { b: 2, a: 1 },
        ],
      },
    ])
      expect(() => validate(input)).toThrow();
    expect(validate({ tuple: [] })).toEqual({ tuple: [] });
  });
  it("supports explicit draft07 tuples and rejects dialect ambiguity", () => {
    const { validate } = createMcpInputValidator({
      $schema: "http://json-schema.org/draft-07/schema#",
      properties: { tuple: { items: [{ type: "boolean" }], additionalItems: false } },
    });
    expect(validate({ tuple: [true] })).toEqual({ tuple: [true] });
    expect(() => validate({ tuple: [true, 1] })).toThrow();
    expect(() => createMcpInputValidator({ items: [{}] })).toThrow();
    expect(() =>
      createMcpInputValidator({
        $schema: "http://json-schema.org/draft-07/schema#",
        prefixItems: [{}],
      }),
    ).toThrow();
  });
  it("enforces negation, conditionals and modern dependencies only when triggered", () => {
    const { validate } = createMcpInputValidator({
      type: "object",
      not: { required: ["blocked"] },
      if: { properties: { mode: { const: "a" } }, required: ["mode"] },
      then: { required: ["a"] },
      else: { not: { required: ["a"] } },
      dependentRequired: { first: ["second"] },
      dependentSchemas: { flag: { properties: { flag: { const: true } } } },
    });
    expect(validate({ mode: "a", a: 1, first: 1, second: 2, flag: true })).toBeTruthy();
    expect(validate({})).toEqual({});
    for (const input of [{ mode: "a" }, { a: 1 }, { first: 1 }, { flag: false }, { blocked: true }])
      expect(() => validate(input)).toThrow();
    const ignored = createMcpInputValidator({ then: false, else: false });
    expect(ignored.validate({})).toEqual({});
  });
  it("supports legacy draft07 property and schema dependencies", () => {
    const { validate } = createMcpInputValidator({
      $schema: "http://json-schema.org/draft-07/schema#",
      dependencies: { a: ["b"], c: { required: ["d"] } },
    });
    expect(validate({ a: 1, b: 2, c: 3, d: 4 })).toBeTruthy();
    expect(() => validate({ a: 1 })).toThrow();
    expect(() => validate({ c: 1 })).toThrow();
  });
  it("accepts linear anchored character classes and fixed literal searches", () => {
    const { validate } = createMcpInputValidator({
      properties: {
        slug: { pattern: "^[a-z0-9_-]{1,64}$" },
        text: { pattern: "literal\\.suffix" },
      },
    });
    expect(validate({ slug: "valid-1", text: "a literal.suffix here" })).toBeTruthy();
    expect(() => validate({ slug: "UPPER" })).toThrow();
    expect(() => validate({ text: "literalXsuffix" })).toThrow();
  });
  it.each(["(a+)+$", "[a]+$", "(a|aa)+", "^a+a+$", "^.*$", "^([a-z]+)\\1$"])(
    "quarantines unsafe/unsupported regex %s",
    (pattern) => {
      expect(() => createMcpInputValidator({ properties: { text: { pattern } } })).toThrow(
        "unsupported or invalid",
      );
    },
  );
  it("rejects invalid compatible input before remote invocation", async () => {
    const { adapter, call } = fixture({
      $defs: { positive: { type: "integer", minimum: 1 } },
      properties: { n: { $ref: "#/$defs/positive" } },
    });
    await expect(adapter.invoke({ n: 0 }, context())).rejects.toThrow("validation failed");
    expect(call).not.toHaveBeenCalled();
    await adapter.invoke({ n: 1 }, context());
    expect(call).toHaveBeenCalledOnce();
  });
});

it("bounds reference expansion, validation work and invalid annotations", () => {
  const defs: Record<string, unknown> = { base: { type: "string" } };
  for (let index = 0; index < 12; index++)
    defs[`d${index}`] = {
      allOf: Array.from({ length: 4 }, () => ({
        $ref: `#/$defs/${index ? `d${index - 1}` : "base"}`,
      })),
    };
  expect(() =>
    createMcpInputValidator({ $defs: defs, properties: { x: { $ref: "#/$defs/d11" } } }),
  ).toThrow("unsupported or invalid");
  const { validate } = createMcpInputValidator({ properties: { list: { uniqueItems: true } } });
  expect(() => validate({ list: Array.from({ length: 500 }, (_, index) => index) })).toThrow(
    "validation failed",
  );
  for (const schema of [
    { title: false },
    { $id: 1 },
    { readOnly: "yes" },
    { examples: {} },
    { $id: "https://example.com/#anchor" },
  ])
    expect(() => createMcpInputValidator(schema)).toThrow("unsupported or invalid");
});
