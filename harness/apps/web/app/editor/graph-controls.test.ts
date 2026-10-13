import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Controls, ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";

describe("real graph canvas controls", () => {
  it("renders keyboard-focusable native buttons for zoom, fit and interaction", () => {
    const html = renderToStaticMarkup(
      createElement(ReactFlowProvider, null, createElement(Controls)),
    );
    for (const label of ["Zoom In", "Zoom Out", "Fit View", "Toggle Interactivity"]) {
      expect(html).toMatch(new RegExp(`<button[^>]*aria-label="${label}"`));
    }
    expect(html).not.toContain('tabindex="-1"');
  });
});
