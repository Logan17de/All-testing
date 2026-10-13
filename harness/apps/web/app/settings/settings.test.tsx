import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { settingsId, settingsMatches, SETTINGS_SECTIONS } from "./settings-view";
import { SettingsWorkspace } from "./settings-workspace";
import { SetupWizard } from "../setup/setup-wizard";
import { DefaultFolderSettings } from "./default-folder-settings";
describe("Settings", () => {
  it("searches real supported settings and preserves existing deep links", () => {
    expect(settingsMatches(" desktop ").map((item) => item.id)).toEqual(["computer"]);
    expect(settingsMatches("Personal").map((item) => item.id)).toEqual([
      "general",
      "chat",
      "account",
      "connections",
    ]);
    expect(settingsMatches("api keys").map((item) => item.id)).toEqual(["coding"]);
    expect(settingsMatches("no such setting")).toEqual([]);
    expect(settingsId("coding")).toBe("coding");
    expect(settingsId("chat")).toBe("chat");
    expect(settingsId("integrations")).toBe("integrations");
    expect(settingsId("unknown")).toBe("general");
  });
  it("keeps relevant controls in the popup instead of linking to separate settings pages", () => {
    const html = renderToStaticMarkup(<SettingsWorkspace initialSection="general" />);
    for (const section of SETTINGS_SECTIONS) expect(html).toContain(section.title);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Loading folder settings.");
    expect(html).not.toContain('href="/setup"');
    expect(html).not.toContain('href="/models"');
    expect(html).not.toContain("Passwords");
    expect(html).not.toContain("Usage &amp; billing");
  });
  it("embeds archived and model controls with clear loading states", () => {
    expect(renderToStaticMarkup(<SettingsWorkspace initialSection="archived" />)).toContain(
      "Search archived chats",
    );
    expect(renderToStaticMarkup(<SettingsWorkspace initialSection="coding" />)).toContain(
      "Loading models",
    );
    expect(renderToStaticMarkup(<SettingsWorkspace initialSection="browser" />)).not.toContain(
      'role="switch"',
    );
  });
  it("includes instructions and all five chat tool choices checked by default", () => {
    const html = renderToStaticMarkup(<SettingsWorkspace initialSection="chat" />);
    expect(html).toContain('aria-label="Chat settings"');
    expect(html).toContain('id="settings-chat-instructions"');
    expect(html.match(/type="checkbox"/g)).toHaveLength(5);
    expect(html.match(/checked=""/g)).toHaveLength(5);
    expect(html).toContain("each tool keeps its existing");
    expect(html).toContain("connection and approval requirements");
    expect(html).toContain("next tasks across chats");
    expect(settingsMatches("subagents").map((item) => item.id)).toEqual(["chat"]);
    expect(settingsMatches("retention").map((item) => item.id)).toEqual(["archived"]);
  });
  it("retains folder trust when setup is embedded without unrelated steps", () => {
    const initial = {
      workspace: { path: "D:\\Example", exists: true, trusted: false },
      modelsConfigured: 0,
      complete: false,
    };
    const embedded = renderToStaticMarkup(<DefaultFolderSettings initial={initial} />);
    expect(embedded).toContain("Trust this folder?");
    expect(embedded).toContain("Trust and use as default");
    expect(embedded).not.toContain("Connect a model");
    expect(embedded).not.toContain('href="/projects"');
    const full = renderToStaticMarkup(<SetupWizard initial={initial} />);
    expect(full).toContain("Connect a model");
  });
});
