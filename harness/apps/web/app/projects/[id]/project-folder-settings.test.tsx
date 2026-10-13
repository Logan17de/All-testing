import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProjectFolderSettings } from "./project-folder-settings";
it("offers explicit trust review for an existing folder without implicitly trusting it", () => {
  const html = renderToStaticMarkup(
    <ProjectFolderSettings projectId="fixture" workspacePath="D:\Work" archived={false} />,
  );
  expect(html).toContain("Review folder trust");
  expect(html).toContain("Choose folder");
  expect(html).toContain("does not rename the PC folder");
  expect(html).not.toContain("Project folder trusted and saved");
  expect(html).not.toContain("Start conversation");
});
it("does not expose folder mutation for archived projects", () => {
  const html = renderToStaticMarkup(
    <ProjectFolderSettings projectId="fixture" workspacePath={null} archived />,
  );
  expect(html).toContain("No folder selected");
  expect(html).not.toContain("Choose folder");
  expect(html).toContain("cannot change it");
});
