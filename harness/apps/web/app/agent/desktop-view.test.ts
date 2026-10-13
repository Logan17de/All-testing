import { describe, expect, it } from "vitest";
import {
  desktopConsents,
  desktopArmed,
  desktopSessionActive,
  desktopStatus,
  monitorContains,
  previewPointToDesktop,
} from "./desktop-view";

describe("desktop session consent view", () => {
  it("fails closed for absent, expired or exhausted sessions", () => {
    const status = desktopStatus({
      state: "armed",
      generation: 1,
      task: "fixture",
      expiresAt: 100,
      actionsRemaining: 2,
      monitors: [],
      windows: [],
    })!;
    expect(desktopArmed(null, 0)).toBe(false);
    expect(desktopArmed(status, 99)).toBe(true);
    expect(desktopArmed(status, 100)).toBe(false);
    expect(desktopArmed({ ...status, actionsRemaining: 0 }, 99)).toBe(false);
    expect(desktopSessionActive({ ...status, actionsRemaining: 0 }, 99)).toBe(true);
    expect(
      desktopStatus({ state: "disabled", generation: 0, monitors: [], windows: [] })?.state,
    ).toBe("disabled");
    expect(desktopStatus({ ...status, expiresAt: undefined })).toBeUndefined();
  });
  it("uses physical monitor coordinates including negative monitor origins", () => {
    const monitor = { id: "left", x: -1920, y: 0, width: 1920, height: 1080, scale: 1.5 };
    expect(monitorContains(monitor, -100, 20)).toBe(true);
    expect(monitorContains(monitor, 0, 20)).toBe(false);
    expect(monitorContains(monitor, -100.5, 20)).toBe(false);
  });
});

it("shows only consent requests for the current task and generation", () => {
  const status = desktopStatus({
    state: "armed",
    generation: 7,
    task: "fixture",
    expiresAt: 100,
    actionsRemaining: 0,
    monitors: [],
    windows: [],
  })!;
  const valid = {
    id: "one",
    generation: 7,
    task: "fixture",
    purpose: "input",
    action: { kind: "click", x: -10, y: 20 },
  };
  expect(
    desktopConsents(
      [
        valid,
        { ...valid, id: "stale", generation: 6 },
        { ...valid, id: "other", task: "another" },
        { ...valid, purpose: "unknown" },
      ],
      status,
    ),
  ).toEqual([valid]);
  expect(desktopConsents([valid], { ...status, state: "idle" })).toEqual([]);
});

it("maps local screenshot points to physical monitor pixels without losing negative origins", () => {
  const scope = { x: -1920, y: 100, width: 1920, height: 1080 };
  expect(previewPointToDesktop(scope, 1920, 1080, 960, 540, 100, 50)).toEqual({
    x: -1720,
    y: 200,
  });
  expect(previewPointToDesktop(scope, 1920, 1080, 960, 540, -1, 10)).toBeUndefined();
  expect(previewPointToDesktop(scope, 1920, 1080, 960, 540, 960, 10)).toBeUndefined();
  expect(previewPointToDesktop(scope, 1919, 1080, 960, 540, 10, 10)).toBeUndefined();
  expect(previewPointToDesktop(scope, 1920, 1080, 0, 540, 10, 10)).toBeUndefined();
});
