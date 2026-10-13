import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopSession } from "../agent/desktop-session";

describe("Desktop session unavailable state", () => {
  it("renders task groups and an actionable companion explanation", () => {
    const html = renderToStaticMarkup(<DesktopSession initialTask="Inspect a local app" />);
    expect(html).toContain("Session status");
    expect(html).toContain("Task and display");
    expect(html).toContain("Local preview");
    expect(html).toContain("Request an action");
    expect(html).toContain("Runtime desktop access is unavailable");
    expect(html).toContain("A trusted local desktop companion is required");
    expect(html).not.toContain("Screenshot scope is unavailable");
    expect(html).toContain("Session setup and controls");
    expect(html).toMatch(/<details class="desktopSession__controls">/);
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html).toContain('value="Inspect a local app"');
  });

  it("keeps capture, arming, stop and input requests disabled without a companion", () => {
    const html = renderToStaticMarkup(<DesktopSession />);
    for (const label of [
      "Refresh monitors and windows",
      "Arm task session",
      "Stop desktop session",
      "Capture local preview",
    ]) {
      const button = html.match(new RegExp(`<button[^>]*>\\s*${label}\\s*</button>`))?.[0];
      expect(button, label).toContain('disabled=""');
    }
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toContain("require host approval for input");
  });
});
