import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PluginMakerWorkspace } from "./plugin-maker-workspace";

it("explains the workspace precondition and blocks scaffold until it is verified", () => {
  const html = renderToStaticMarkup(<PluginMakerWorkspace />);
  expect(html).toContain("Select a workspace in");
  expect(html).toContain('href="/setup"');
  expect(html).toContain("Draft creation is unavailable until a workspace is selected");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Create quarantined scaffold<\/button>/);
});
