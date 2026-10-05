type Value = Record<string, unknown>;
const object = (value: unknown): Value =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};
export type FormOption = { value: string; label: string };
export type FormField = {
  name: string;
  title: string;
  description: string;
  type: string;
  required: boolean;
  options: FormOption[] | null;
  schema: Value;
};
import {
  isSupportedMcpForm,
  mcpEnumOptions,
  validateMcpFormContent,
} from "@zet-harness/plugin-api/mcp-elicitation";

export function formFields(raw: unknown): { fields: FormField[]; supported: boolean } {
  const schema = object(raw);
  const required = Array.isArray(schema.required) ? schema.required : [];
  const fields = Object.entries(object(schema.properties)).map(([name, rawProperty]) => {
    const property = object(rawProperty);
    const type = typeof property.type === "string" ? property.type : "";
    const options = mcpEnumOptions(type === "array" ? object(property.items) : property);
    return {
      name,
      title: typeof property.title === "string" ? property.title : name,
      description: typeof property.description === "string" ? property.description : "",
      type,
      required: required.includes(name),
      options:
        options?.map((option) => ({ value: String(option.value), label: option.label })) || null,
      schema: property,
    };
  });
  return { fields, supported: isSupportedMcpForm(raw) };
}

export function formContent(
  fields: readonly FormField[],
  values: Readonly<Record<string, string | string[]>>,
  schema?: unknown,
): { content?: Value; error?: string } {
  const content: Value = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined || value === "") {
      if (field.required) return { error: `Provide ${field.title}.` };
      continue;
    }
    if (field.type === "array") {
      if (!Array.isArray(value)) return { error: `Select values for ${field.title}.` };
      if (
        (typeof field.schema.minItems === "number" && value.length < field.schema.minItems) ||
        (typeof field.schema.maxItems === "number" && value.length > field.schema.maxItems)
      )
        return { error: `Check the number of selections for ${field.title}.` };
      content[field.name] = value;
    } else if (typeof value !== "string") return { error: `Invalid value for ${field.title}.` };
    else if (field.type === "boolean") content[field.name] = value === "true";
    else if (field.type === "number" || field.type === "integer") {
      const number = Number(value);
      if (
        !Number.isFinite(number) ||
        (field.type === "integer" && !Number.isInteger(number)) ||
        (typeof field.schema.minimum === "number" && number < field.schema.minimum) ||
        (typeof field.schema.maximum === "number" && number > field.schema.maximum)
      )
        return { error: `Provide a valid ${field.type} for ${field.title}.` };
      content[field.name] = number;
    } else {
      if (
        (typeof field.schema.minLength === "number" && value.length < field.schema.minLength) ||
        (typeof field.schema.maxLength === "number" && value.length > field.schema.maxLength)
      )
        return { error: `Check the length of ${field.title}.` };
      content[field.name] = value;
    }
  }
  if (schema !== undefined && !validateMcpFormContent(schema, content))
    return { error: "Check your answers against the requested field constraints." };
  return { content };
}
