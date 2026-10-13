import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { NewProjectForm } from "./new-project-form";
import { SetupWizard } from "../setup/setup-wizard";
import { FolderPicker } from "../setup/folder-picker";

it("asks for a real PC folder before exposing project naming or creation", () => {
  const html = renderToStaticMarkup(<NewProjectForm defaultFolder={"D:\\Work"} />);
  expect(html).toContain("Choose a PC folder");
  expect(html).toContain("Browse folders on the PC running the harness");
  expect(html).not.toContain("Project display name");
  expect(html).not.toContain(">Create project</button>");
});
it("exposes default folder meaning without changing the folder name", () => {
  const html = renderToStaticMarkup(
    <SetupWizard
      initial={{
        workspace: { path: "D:\\Work", exists: true, trusted: true },
        modelsConfigured: 0,
        complete: true,
      }}
    />,
  );
  expect(html).toContain("New chat uses this folder by default");
  expect(html).toContain("Selecting it does not rename or move anything");
  expect(html).toContain("Change default folder");
});
it("provides a labeled manual path and honest loading state", () => {
  const html = renderToStaticMarkup(
    <FolderPicker initialPath={"D:\\Work"} onChoose={() => undefined} />,
  );
  expect(html).toContain("Or type a folder path");
  expect(html).toContain('value="D:\\Work"');
  expect(html).toContain('role="status"');
});
it("requires exact-folder trust for a previously configured untrusted default", () => {
  const html = renderToStaticMarkup(
    <SetupWizard
      initial={{
        workspace: { path: "D:\\Work", exists: true, trusted: false },
        modelsConfigured: 0,
        complete: false,
      }}
    />,
  );
  expect(html).toContain("Trust this folder?");
  expect(html).toContain("Trust and use as default");
  expect(html).not.toContain("Change default folder");
});
