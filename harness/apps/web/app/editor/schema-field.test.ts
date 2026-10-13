import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SchemaField } from "./schema-field";

const render = (
  schema: Parameters<typeof SchemaField>[0]["schema"],
  value: Parameters<typeof SchemaField>[0]["value"],
) =>
  renderToStaticMarkup(
    createElement(SchemaField, { label: "Config", schema, value, onChange: () => {} }),
  );

describe("real inspector schema controls", () => {
  it("renders a numeric zero rather than treating it as unset", () => {
    expect(render({ type: "number" }, 0)).toContain('value="0"');
  });
  it("renders integer steps and required field labels", () => {
    const html = renderToStaticMarkup(
      createElement(SchemaField, {
        label: "Retries",
        schema: { type: "integer" },
        value: 3,
        required: true,
        onChange: () => {},
      }),
    );
    expect(html).toContain('step="1"');
    expect(html).toContain("Retries (required)");
  });
  it("preserves falsy enum selections rather than the unset option", () => {
    const html = render({ enum: [false, true] }, false);
    expect(html).toContain('<option value="false" selected="">false</option>');
  });
  it("gives long prompt values a multiline editor with the declared limit", () => {
    const schema = { type: "string", maxLength: 4000 } as const;
    const html = render(schema, "Line one\nLine two");
    expect(html).toContain("<textarea");
    expect(html).toContain('maxLength="4000"');
    expect(html).toContain("Line one\nLine two");
  });
  it("renders current object values as JSON and escapes source content", () => {
    const html = render({ type: "object" }, { text: "<script>sample</script>" });
    expect(html).toContain("&lt;script&gt;sample&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('spellCheck="false"');
  });
});
