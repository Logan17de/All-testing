import { describe, expect, it } from "vitest";
import { hasExecutedSandboxTests, pluginDraft } from "./plugin-maker-view";
describe("quarantined plugin drafts", () => {
  const draft = {
    hash: "a".repeat(64),
    files: [{ path: "manifest.json", content: "{}", sha256: "b".repeat(64) }],
    requestedCapabilities: [],
    quarantined: true,
    enabled: false,
  };
  it("accepts the server's immutable disabled artifact", () => {
    expect(pluginDraft(draft)?.files[0]?.path).toBe("manifest.json");
  });
  it("refuses activation claims, malformed hashes and duplicate files", () => {
    expect(pluginDraft({ ...draft, enabled: true })).toBeUndefined();
    expect(pluginDraft({ ...draft, hash: "draft" })).toBeUndefined();
    expect(pluginDraft({ ...draft, files: [...draft.files, ...draft.files] })).toBeUndefined();
  });
});

it("keeps enabling unavailable for static, failed or unexecuted test reports", () => {
  expect(hasExecutedSandboxTests({ mode: "offline-static", executed: false, passed: true })).toBe(
    false,
  );
  expect(
    hasExecutedSandboxTests({ mode: "required-os-sandbox", executed: false, passed: true }),
  ).toBe(false);
  expect(
    hasExecutedSandboxTests({ mode: "required-os-sandbox", executed: true, passed: false }),
  ).toBe(false);
  expect(
    hasExecutedSandboxTests({ mode: "required-os-sandbox", executed: true, passed: true }),
  ).toBe(true);
});
