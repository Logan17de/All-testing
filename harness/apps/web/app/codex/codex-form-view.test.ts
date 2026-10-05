import { describe, expect, it } from "vitest";
import { formContent, formFields } from "./codex-form-view";

describe("official MCP form views", () => {
  it("renders titled single choice and multi choice without arbitrary JSON editing", () => {
    const schema = {
      type: "object",
      properties: {
        choice: {
          type: "string",
          oneOf: [
            { const: "one", title: "First" },
            { const: "two", title: "Second" },
          ],
        },
        choices: {
          type: "array",
          items: {
            anyOf: [
              { const: "a", title: "Alpha" },
              { const: "b", title: "Beta" },
            ],
          },
          minItems: 1,
          maxItems: 2,
        },
      },
      required: ["choice", "choices"],
    };
    const form = formFields(schema);
    expect(form.supported).toBe(true);
    expect(form.fields[0]?.options?.[0]).toEqual({ value: "one", label: "First" });
    expect(form.fields[1]?.options?.[0]).toEqual({ value: "a", label: "Alpha" });
    expect(formContent(form.fields, { choice: "two", choices: ["a"] }, schema).content).toEqual({
      choice: "two",
      choices: ["a"],
    });
    expect(
      formContent(form.fields, { choice: "invalid", choices: ["a"] }, schema).error,
    ).toBeDefined();
  });
  it("fails closed on sensitive fields, unsupported schemas, invalid dates and number bounds", () => {
    expect(
      formFields({ type: "object", properties: { password: { type: "string" } } }).supported,
    ).toBe(false);
    expect(
      formFields({ type: "object", properties: { nested: { type: "object", properties: {} } } })
        .supported,
    ).toBe(false);
    const schema = {
      type: "object",
      properties: {
        date: { type: "string", format: "date" },
        count: { type: "integer", minimum: 1, maximum: 3 },
      },
      required: ["date", "count"],
    };
    const form = formFields(schema);
    expect(
      formContent(form.fields, { date: "2026-02-30", count: "2" }, schema).error,
    ).toBeDefined();
    expect(
      formContent(form.fields, { date: "2026-02-28", count: "4" }, schema).error,
    ).toBeDefined();
    expect(formContent(form.fields, { date: "2026-02-28", count: "2" }, schema).content).toEqual({
      date: "2026-02-28",
      count: 2,
    });
  });
});
