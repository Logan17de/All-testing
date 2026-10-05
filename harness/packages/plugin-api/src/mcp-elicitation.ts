/** Bounded, flat MCP 2025-11-25 forms matching the pinned Codex protocol. */
type RecordValue = Record<string, unknown>;
export interface McpEnumOption {
  readonly value: string;
  readonly label: string;
}
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit = 16384): value is string =>
  typeof value === "string" && value.length <= limit;
const only = (value: RecordValue, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const count = (value: unknown) =>
  value === undefined ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 16384);
const metadata = (field: RecordValue) =>
  (field.title === undefined || text(field.title, 4096)) &&
  (field.description === undefined || text(field.description, 4096));
const common = ["type", "title", "description", "default"];

export function mcpEnumOptions(field: unknown): readonly McpEnumOption[] | undefined {
  if (!record(field)) return undefined;
  if (Array.isArray(field.enum)) {
    if (
      !field.enum.length ||
      field.enum.length > 100 ||
      field.enum.some((value) => !text(value)) ||
      new Set(field.enum).size !== field.enum.length
    )
      return undefined;
    const names = field.enumNames;
    if (
      names !== undefined &&
      (!Array.isArray(names) ||
        names.length !== field.enum.length ||
        names.some((value) => !text(value, 4096)))
    )
      return undefined;
    return (field.enum as string[]).map((value, index) => ({
      value,
      label: Array.isArray(names) ? (names[index] as string) : value,
    }));
  }
  const choices = field.oneOf ?? field.anyOf;
  if (!Array.isArray(choices) || !choices.length || choices.length > 100) return undefined;
  const options: McpEnumOption[] = [];
  for (const choice of choices) {
    if (
      !record(choice) ||
      !only(choice, ["const", "title"]) ||
      !text(choice.const) ||
      !text(choice.title, 4096)
    )
      return undefined;
    options.push({ value: choice.const, label: choice.title });
  }
  return new Set(options.map((option) => option.value)).size === options.length
    ? options
    : undefined;
}
function fieldSupported(field: unknown): field is RecordValue {
  if (!record(field) || !metadata(field)) return false;
  switch (field.type) {
    case "boolean":
      return (
        only(field, common) && (field.default === undefined || typeof field.default === "boolean")
      );
    case "number":
    case "integer":
      return (
        only(field, [...common, "minimum", "maximum"]) &&
        [field.minimum, field.maximum].every(
          (value) => value === undefined || (typeof value === "number" && Number.isFinite(value)),
        ) &&
        (field.minimum === undefined ||
          field.maximum === undefined ||
          (field.minimum as number) <= (field.maximum as number)) &&
        (field.default === undefined || fieldValue(field, field.default))
      );
    case "string": {
      const variants = [field.enum, field.oneOf, field.anyOf].filter(
        (value) => value !== undefined,
      ).length;
      if (variants)
        return (
          variants === 1 &&
          field.anyOf === undefined &&
          only(field, [...common, "enum", "enumNames", "oneOf"]) &&
          (field.enumNames === undefined || field.enum !== undefined) &&
          mcpEnumOptions(field) !== undefined &&
          (field.default === undefined || fieldValue(field, field.default))
        );
      return (
        only(field, [...common, "minLength", "maxLength", "format"]) &&
        count(field.minLength) &&
        count(field.maxLength) &&
        (field.minLength === undefined ||
          field.maxLength === undefined ||
          (field.minLength as number) <= (field.maxLength as number)) &&
        (field.format === undefined ||
          (typeof field.format === "string" &&
            ["email", "uri", "date", "date-time"].includes(field.format))) &&
        (field.default === undefined || fieldValue(field, field.default))
      );
    }
    case "array": {
      if (
        !only(field, [...common, "items", "minItems", "maxItems"]) ||
        !count(field.minItems) ||
        !count(field.maxItems) ||
        (field.minItems !== undefined &&
          field.maxItems !== undefined &&
          (field.minItems as number) > (field.maxItems as number)) ||
        !record(field.items)
      )
        return false;
      const items = field.items;
      const validItems =
        items.enum !== undefined
          ? only(items, ["type", "enum"]) && items.type === "string"
          : only(items, ["anyOf"]) && items.anyOf !== undefined;
      return (
        validItems &&
        mcpEnumOptions(items) !== undefined &&
        (field.default === undefined || fieldValue(field, field.default))
      );
    }
    default:
      return false;
  }
}
function fieldValue(field: RecordValue, value: unknown): boolean {
  const bounds = (min: unknown, max: unknown, n: number) =>
    (min === undefined || n >= (min as number)) && (max === undefined || n <= (max as number));
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "number" || field.type === "integer")
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (field.type !== "integer" || Number.isSafeInteger(value)) &&
      bounds(field.minimum, field.maximum, value)
    );
  if (field.type === "array") {
    const options = mcpEnumOptions(field.items);
    return (
      !!options &&
      Array.isArray(value) &&
      value.length <= 100 &&
      new Set(value).size === value.length &&
      bounds(field.minItems, field.maxItems, value.length) &&
      value.every(
        (item) => typeof item === "string" && options.some((option) => option.value === item),
      )
    );
  }
  if (
    field.type !== "string" ||
    !text(value) ||
    !bounds(field.minLength, field.maxLength, [...value].length)
  )
    return false;
  const options = mcpEnumOptions(field);
  if (options && !options.some((option) => option.value === value)) return false;
  switch (field.format) {
    case undefined:
      return true;
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case "uri":
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const stamp = Date.parse(value);
      return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
    }
    case "date-time": {
      const date = value.slice(0, 10);
      return (
        /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
          value,
        ) &&
        fieldValue({ type: "string", format: "date" }, date) &&
        Number.isFinite(Date.parse(value))
      );
    }
    default:
      return false;
  }
}
export function isSupportedMcpForm(schema: unknown): boolean {
  if (
    !record(schema) ||
    schema.type !== "object" ||
    !record(schema.properties) ||
    !only(schema, ["$schema", "type", "properties", "required"]) ||
    (schema.$schema !== undefined && !text(schema.$schema, 4096))
  )
    return false;
  const properties = Object.entries(schema.properties);
  if (properties.length > 100) return false;
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.length > 100 ||
    new Set(required).size !== required.length ||
    required.some(
      (key) => typeof key !== "string" || !Object.hasOwn(schema.properties as object, key),
    )
  )
    return false;
  return properties.every(
    ([name, field]) =>
      text(name, 256) &&
      !["__proto__", "constructor", "prototype"].includes(name) &&
      !/(?:password|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|payment|credit[ _-]?card)/i.test(
        `${name} ${record(field) && typeof field.title === "string" ? field.title : ""}`,
      ) &&
      fieldSupported(field),
  );
}
export function validateMcpFormContent(schema: unknown, content: unknown): boolean {
  if (
    !isSupportedMcpForm(schema) ||
    !record(schema) ||
    !record(schema.properties) ||
    !record(content)
  )
    return false;
  const required = (schema.required ?? []) as string[];
  if (required.some((key) => !Object.hasOwn(content, key))) return false;
  return Object.entries(content).every(
    ([name, value]) =>
      Object.hasOwn(schema.properties as object, name) &&
      fieldValue((schema.properties as RecordValue)[name] as RecordValue, value),
  );
}
