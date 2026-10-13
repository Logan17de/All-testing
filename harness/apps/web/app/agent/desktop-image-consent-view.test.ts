import { describe, expect, it } from "vitest";
import {
  desktopImageConsents,
  desktopScreenshotScope,
  desktopImageScope,
} from "./desktop-image-consent-view";
import type { DesktopStatus } from "./desktop-view";
const status: DesktopStatus = {
  state: "armed",
  generation: 7,
  task: "inspect layout",
  expiresAt: 1000,
  actionsRemaining: 0,
  selection: { monitorId: "virtual", windowId: "123" },
  monitors: [{ id: "virtual", x: -1920, y: 0, width: 3840, height: 1080, scale: 1.5 }],
  windows: [{ id: "123", title: "Fixture" }],
};
const request = {
  id: "request-1",
  generation: 7,
  task: "inspect layout",
  purpose: "transmission",
  artifactId: "exact-image",
  captureScope: {
    monitorId: "captured",
    x: -1920,
    y: 0,
    width: 3840,
    height: 1080,
    windowId: "123",
  },
  destination: {
    runId: "turn-1",
    sessionId: "chat-1",
    modelId: "model-1",
    accountId: "opaque-account-binding",
    maxUses: 3,
    expiresAtMs: 900,
  },
};
describe("destination-bound desktop image consent", () => {
  it("preserves exact current-turn destination and reuse bound even after action budget exhaustion", () => {
    expect(desktopImageConsents([request], status, 100)[0]).toMatchObject({
      id: "request-1",
      artifactId: "exact-image",
      destination: request.destination,
    });
    expect(desktopScreenshotScope(status)).toContain("Entire monitor virtual: 3840 × 1080");
    expect(desktopScreenshotScope(status)).toContain("window selection does not crop");
  });
  it("discards other task/generation requests and blocks incomplete or expired sharing", () => {
    expect(
      desktopImageConsents(
        [
          { ...request, generation: 6 },
          { ...request, task: "other" },
        ],
        status,
        100,
      ),
    ).toEqual([]);
    for (const destination of [
      undefined,
      { ...request.destination, modelId: "" },
      { ...request.destination, maxUses: 0 },
      { ...request.destination, maxUses: 9 },
      { ...request.destination, expiresAtMs: 99 },
      { ...request.destination, expiresAtMs: 1001 },
      { ...request.destination, unexpected: "grant" },
    ])
      expect(desktopImageConsents([{ ...request, destination }], status, 100)[0]).toHaveProperty(
        "blockedReason",
      );
    expect(desktopImageConsents([request], status, 1000)[0]).toHaveProperty("blockedReason");
    expect(desktopImageConsents([request], { ...status, state: "idle" }, 100)).toEqual([]);
  });
  it("requires exact expiry/capture scope and preserves account-free binding", () => {
    expect(
      desktopImageConsents(
        [{ ...request, destination: { ...request.destination, accountId: null, maxUses: 8 } }],
        status,
        100,
      )[0]?.destination?.accountId,
    ).toBeNull();
    expect(desktopImageScope(desktopImageConsents([request], status, 100)[0]!)).toContain(
      "Entire captured monitor captured",
    );
    for (const invalid of [
      { ...request, captureScope: undefined },
      { ...request, destination: { ...request.destination, expiresAtMs: undefined } },
      { ...request, captureScope: { ...request.captureScope, width: 0 } },
    ])
      expect(desktopImageConsents([invalid], status, 100)[0]).toHaveProperty("blockedReason");
  });
});
