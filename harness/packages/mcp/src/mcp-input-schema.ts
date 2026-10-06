import type { JsonObject, JsonSchema, JsonValue } from "@zet-harness/plugin-api";

/** Supported JSON Schema assertions only; unfamiliar assertions fail closed. */
const ASSERTIONS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "prefixItems",
  "additionalItems",
  "uniqueItems",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
  "pattern",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "minProperties",
  "maxProperties",
  "items",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "anyOf",
  "oneOf",
  "allOf",
]);
const ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const DIALECTS = new Set([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft/2020-12/schema",
]);
const schemaFailure = (): TypeError =>
  new TypeError("MCP tool input schema is unsupported or invalid.");
const inputFailure = (): TypeError => new TypeError("MCP tool input validation failed.");
interface Budget {
  nodes: number;
  characters: number;
  readonly maxNodes: number;
  readonly maxCharacters: number;
  readonly maxDepth: number;
}

/** Copies data descriptors only, rejects cycles/accessors/non-JSON, and deeply freezes. */
function snapshot(value: unknown, budget: Budget, depth = 0, seen = new Set<object>()): JsonValue {
  if (++budget.nodes > budget.maxNodes || depth > budget.maxDepth) throw inputFailure();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw inputFailure();
    return value;
  }
  if (typeof value === "string") {
    budget.characters += value.length;
    if (budget.characters > budget.maxCharacters) throw inputFailure();
    return value;
  }
  if (!value || typeof value !== "object" || seen.has(value)) throw inputFailure();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    throw inputFailure();
  seen.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length > budget.maxNodes || keys.some((key) => typeof key !== "string"))
      throw inputFailure();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (value.length > budget.maxNodes || keys.length !== value.length + 1) throw inputFailure();
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw inputFailure();
        output.push(snapshot(descriptor.value as unknown, budget, depth + 1, seen));
      }
      return Object.freeze(output);
    }
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of keys as string[]) {
      budget.characters += key.length;
      if (budget.characters > budget.maxCharacters) throw inputFailure();
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw inputFailure();
      output[key] = snapshot(descriptor.value as unknown, budget, depth + 1, seen);
    }
    return Object.freeze(output);
  } finally {
    seen.delete(value);
  }
}
function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
function integerBound(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw schemaFailure();
}
interface SchemaState {
  readonly root: JsonValue;
  readonly dialect: "07" | "2019" | "2020";
  readonly active: Set<JsonValue>;
  steps: number;
}
function localReference(reference: JsonValue, root: JsonValue): JsonValue {
  if (typeof reference !== "string" || !reference.startsWith("#/")) throw schemaFailure();
  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    throw schemaFailure();
  }
  let target = root;
  for (const segment of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(segment)) throw schemaFailure();
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(target) && !isArray(target)) throw schemaFailure();
    if (!Object.hasOwn(target, key)) throw schemaFailure();
    target = (target as Record<string, JsonValue>)[key]!;
  }
  if (typeof target !== "boolean" && !isObject(target)) throw schemaFailure();
  return target;
}
/** Deliberately tiny regex grammar: fixed literals or one character class with
 * optional repetition. No groups, alternation, backrefs or nested quantifiers.
 * Matching work is linear in bounded input length; unfamiliar patterns quarantine. */
function safePattern(value: JsonValue): RegExp {
  if (typeof value !== "string" || value.length > 256) throw schemaFailure();
  let body = value.startsWith("^") ? value.slice(1) : value;
  if (body.endsWith("$") && !body.endsWith("\\$")) body = body.slice(0, -1);
  const literal = /^(?:[a-zA-Z0-9 _,-]|\\[.\\+*?{}()[\]$^|/-])*$/;
  const singleClass =
    /^\[(?:[a-zA-Z0-9 _,-]|\\[dDsSwW])+\](?:[+*?]|\{[0-9]{1,5}(?:,[0-9]{0,5})?\})?$/;
  if (!literal.test(body) && !singleClass.test(body)) throw schemaFailure();
  if (singleClass.test(body) && /\][+*?{]/.test(body) && !value.startsWith("^"))
    throw schemaFailure();
  try {
    return new RegExp(value, "u");
  } catch {
    throw schemaFailure();
  }
}
function inspect(schema: JsonValue, state: SchemaState): void {
  if (++state.steps > 4096 || state.active.size > 32 || state.active.has(schema))
    throw schemaFailure();
  state.active.add(schema);
  try {
    inspectBody(schema, state);
  } finally {
    state.active.delete(schema);
  }
}
function inspectBody(schema: JsonValue, state: SchemaState): void {
  if (typeof schema === "boolean") return;
  if (!isObject(schema)) throw schemaFailure();
  for (const key of Object.keys(schema))
    if (!ASSERTIONS.has(key) && !ANNOTATIONS.has(key)) throw schemaFailure();
  if (
    schema.$schema !== undefined &&
    (typeof schema.$schema !== "string" || !DIALECTS.has(schema.$schema))
  )
    throw schemaFailure();
  for (const key of ["$id", "$comment", "title", "description"])
    if (schema[key] !== undefined && typeof schema[key] !== "string") throw schemaFailure();
  for (const key of ["deprecated", "readOnly", "writeOnly"])
    if (schema[key] !== undefined && typeof schema[key] !== "boolean") throw schemaFailure();
  if (schema.examples !== undefined && !isArray(schema.examples)) throw schemaFailure();
  if (schema.$id !== undefined) {
    try {
      if (new URL(schema.$id as string, "https://mcp.invalid/schema").hash) throw schemaFailure();
    } catch {
      throw schemaFailure();
    }
  }
  if (schema !== state.root && (schema.$id !== undefined || schema.$schema !== undefined))
    throw schemaFailure();
  if (schema.$ref !== undefined) {
    const target = localReference(schema.$ref, state.root);
    inspect(target, state);
  }
  if (schema.type !== undefined) {
    const types = isArray(schema.type) ? schema.type : [schema.type];
    if (
      !types.length ||
      types.length > TYPES.size ||
      types.some((type) => typeof type !== "string" || !TYPES.has(type)) ||
      new Set(types).size !== types.length
    )
      throw schemaFailure();
  }
  if (
    schema.enum !== undefined &&
    (!isArray(schema.enum) || !schema.enum.length || schema.enum.length > 200)
  )
    throw schemaFailure();
  if (isArray(schema.enum ?? null)) {
    const options = schema.enum as readonly JsonValue[];
    const budget = { steps: 0 };
    for (let index = 0; index < options.length; index++)
      for (let other = 0; other < index; other++)
        if (equal(options[index]!, options[other]!, budget)) throw schemaFailure();
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties) || Object.keys(schema.properties).length > 200)
      throw schemaFailure();
    for (const value of Object.values(schema.properties)) inspect(value, state);
  }
  if (
    schema.required !== undefined &&
    (!isArray(schema.required) ||
      schema.required.length > 200 ||
      schema.required.some((value) => typeof value !== "string") ||
      new Set(schema.required).size !== schema.required.length)
  )
    throw schemaFailure();
  if (schema.additionalProperties !== undefined) inspect(schema.additionalProperties, state);
  if (schema.items !== undefined) {
    if (isArray(schema.items)) {
      if (state.dialect === "2020" || !schema.items.length || schema.items.length > 200)
        throw schemaFailure();
      for (const item of schema.items) inspect(item, state);
    } else inspect(schema.items, state);
  }
  if (schema.additionalItems !== undefined) {
    if (state.dialect === "2020") throw schemaFailure();
    inspect(schema.additionalItems, state);
  }
  if (schema.prefixItems !== undefined) {
    if (
      state.dialect !== "2020" ||
      !isArray(schema.prefixItems) ||
      !schema.prefixItems.length ||
      schema.prefixItems.length > 200
    )
      throw schemaFailure();
    for (const child of schema.prefixItems) inspect(child, state);
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean")
    throw schemaFailure();
  if (schema.pattern !== undefined) safePattern(schema.pattern);
  for (const key of ["not", "if", "then", "else"])
    if (schema[key] !== undefined) inspect(schema[key], state);
  for (const key of ["$defs", "definitions", "dependentSchemas"]) {
    const entries = schema[key];
    if (entries === undefined) continue;
    if (
      (key === "dependentSchemas" && state.dialect === "07") ||
      !isObject(entries) ||
      Object.keys(entries).length > 200
    )
      throw schemaFailure();
    for (const child of Object.values(entries)) inspect(child, state);
  }
  for (const key of ["dependentRequired", "dependencies"]) {
    const entries = schema[key];
    if (entries === undefined) continue;
    if (
      (key === "dependentRequired" && state.dialect === "07") ||
      (key === "dependencies" && state.dialect !== "07") ||
      !isObject(entries) ||
      Object.keys(entries).length > 200
    )
      throw schemaFailure();
    for (const child of Object.values(entries)) {
      if (isArray(child)) {
        if (
          child.length > 200 ||
          child.some((name) => typeof name !== "string") ||
          new Set(child).size !== child.length
        )
          throw schemaFailure();
      } else if (key === "dependencies") inspect(child, state);
      else throw schemaFailure();
    }
  }
  for (const key of [
    "minProperties",
    "maxProperties",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
  ])
    if (schema[key] !== undefined) integerBound(schema[key]);
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"])
    if (
      schema[key] !== undefined &&
      (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))
    )
      throw schemaFailure();
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[key];
    if (branches === undefined) continue;
    if (!isArray(branches) || !branches.length || branches.length > 32) throw schemaFailure();
    for (const branch of branches) inspect(branch, state);
  }
}
function equal(left: JsonValue, right: JsonValue, budget = { steps: 0 }): boolean {
  if (++budget.steps > 100_000) throw inputFailure();
  if (left === right) return true;
  if (isArray(left) && isArray(right))
    return (
      left.length === right.length &&
      left.every((item, index) => equal(item, right[index]!, budget))
    );
  if (isObject(left) && isObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && equal(left[key]!, right[key]!, budget))
    );
  }
  return false;
}
function matchesType(value: JsonValue, type: JsonValue): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}
function matches(
  schema: JsonValue,
  value: JsonValue,
  budget: { steps: number },
  state: SchemaState,
): boolean {
  if (++budget.steps > 100_000) throw inputFailure();
  if (typeof schema === "boolean") return schema;
  const rules = schema as Record<string, JsonValue>;
  if (rules.$ref !== undefined) {
    const valid = matches(localReference(rules.$ref, state.root), value, budget, state);
    if (!valid || state.dialect === "07") return valid;
  }
  if (rules.not !== undefined && matches(rules.not, value, budget, state)) return false;
  if (rules.if !== undefined) {
    const branch = matches(rules.if, value, budget, state) ? rules.then : rules.else;
    if (branch !== undefined && !matches(branch, value, budget, state)) return false;
  }
  if (
    rules.type !== undefined &&
    !(isArray(rules.type) ? rules.type : [rules.type]).some((type) => matchesType(value, type))
  )
    return false;
  if (
    rules.enum !== undefined &&
    !(rules.enum as JsonValue[]).some((option) => equal(value, option, budget))
  )
    return false;
  if (Object.hasOwn(rules, "const") && !equal(value, rules.const!, budget)) return false;
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (
      (rules.minProperties !== undefined && keys.length < (rules.minProperties as number)) ||
      (rules.maxProperties !== undefined && keys.length > (rules.maxProperties as number))
    )
      return false;
    if ((rules.required as string[] | undefined)?.some((key) => !Object.hasOwn(value, key)))
      return false;
    for (const keyword of ["dependentRequired", "dependentSchemas", "dependencies"]) {
      const entries = rules[keyword] as Record<string, JsonValue> | undefined;
      if (!entries) continue;
      for (const [name, child] of Object.entries(entries)) {
        if (!Object.hasOwn(value, name)) continue;
        if (isArray(child)) {
          if (child.some((required) => !Object.hasOwn(value, required as string))) return false;
        } else if (!matches(child, value, budget, state)) return false;
      }
    }
    const properties = (rules.properties ?? {}) as Record<string, JsonValue>;
    for (const key of keys) {
      const child = Object.hasOwn(properties, key) ? properties[key] : rules.additionalProperties;
      if (child !== undefined && !matches(child, value[key]!, budget, state)) return false;
    }
  }
  if (isArray(value)) {
    if (
      (rules.minItems !== undefined && value.length < (rules.minItems as number)) ||
      (rules.maxItems !== undefined && value.length > (rules.maxItems as number))
    )
      return false;
    const prefix = (rules.prefixItems ??
      (isArray(rules.items ?? null) ? rules.items : [])) as readonly JsonValue[];
    for (let index = 0; index < value.length; index++) {
      const child =
        index < prefix.length
          ? prefix[index]
          : isArray(rules.items ?? null)
            ? rules.additionalItems
            : rules.items;
      if (child !== undefined && !matches(child, value[index]!, budget, state)) return false;
    }
    if (rules.uniqueItems === true) {
      for (let index = 0; index < value.length; index++)
        for (let other = 0; other < index; other++)
          if (equal(value[index]!, value[other]!, budget)) return false;
    }
  }
  if (typeof value === "string") {
    if (rules.pattern !== undefined && !safePattern(rules.pattern).test(value)) return false;
    const length = Array.from(value).length;
    if (
      (rules.minLength !== undefined && length < (rules.minLength as number)) ||
      (rules.maxLength !== undefined && length > (rules.maxLength as number))
    )
      return false;
  }
  if (typeof value === "number") {
    if (
      (rules.minimum !== undefined && value < (rules.minimum as number)) ||
      (rules.maximum !== undefined && value > (rules.maximum as number)) ||
      (rules.exclusiveMinimum !== undefined && value <= (rules.exclusiveMinimum as number)) ||
      (rules.exclusiveMaximum !== undefined && value >= (rules.exclusiveMaximum as number))
    )
      return false;
  }
  if (
    rules.allOf !== undefined &&
    !(rules.allOf as JsonValue[]).every((branch) => matches(branch, value, budget, state))
  )
    return false;
  if (
    rules.anyOf !== undefined &&
    !(rules.anyOf as JsonValue[]).some((branch) => matches(branch, value, budget, state))
  )
    return false;
  if (
    rules.oneOf !== undefined &&
    (rules.oneOf as JsonValue[]).filter((branch) => matches(branch, value, budget, state))
      .length !== 1
  )
    return false;
  return true;
}

/** Bounded supported subset, not a universal JSON Schema validator. */
export function createMcpInputValidator(source: Record<string, unknown>): {
  readonly schema: JsonSchema;
  readonly validate: (input: JsonObject) => JsonObject;
} {
  let schema: JsonValue;
  let state: SchemaState;
  try {
    schema = snapshot(source, {
      nodes: 0,
      characters: 0,
      maxNodes: 2048,
      maxCharacters: 65536,
      maxDepth: 16,
    });
    const dialect = isObject(schema) ? schema.$schema : undefined;
    state = {
      root: schema,
      dialect:
        typeof dialect === "string" && dialect.includes("draft-07")
          ? "07"
          : typeof dialect === "string" && dialect.includes("2019-09")
            ? "2019"
            : "2020",
      active: new Set(),
      steps: 0,
    };
    inspect(schema, state);
  } catch {
    throw schemaFailure();
  }
  return Object.freeze({
    schema: schema as JsonSchema,
    validate(input: JsonObject): JsonObject {
      try {
        const value = snapshot(input, {
          nodes: 0,
          characters: 0,
          maxNodes: 20000,
          maxCharacters: 262144,
          maxDepth: 32,
        });
        if (!isObject(value) || !matches(schema, value, { steps: 0 }, state)) throw inputFailure();
        return value;
      } catch {
        throw inputFailure();
      }
    },
  });
}
