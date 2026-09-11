import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LEGACY_WINDOWS_MAX_PATH, probeRuntimePathLimits } from "./runtime-path-limits.js";

describe("probeRuntimePathLimits", () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "zet-pathlimit-test-"));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  });

  it("reports the current platform", async () => {
    const report = await probeRuntimePathLimits({ baseDirectory: base });
    expect(report.platform).toBe(process.platform);
  });

  it("reaches a definite conclusion on a writable temp directory", async () => {
    const report = await probeRuntimePathLimits({ baseDirectory: base });
    expect(["supported", "unsupported"]).toContain(report.probe);
  });

  it("keeps the conclusion and the usable flag consistent", async () => {
    const report = await probeRuntimePathLimits({ baseDirectory: base });
    expect(report.longPathsUsableByRuntime).toBe(report.probe === "supported");
  });

  it("holds Windows external tools to the legacy limit even when the probe succeeds", async () => {
    const report = await probeRuntimePathLimits({ baseDirectory: base });
    if (report.platform === "win32") {
      expect(report.recommendedExternalPathLimit).toBe(LEGACY_WINDOWS_MAX_PATH);
    } else {
      expect(report.recommendedExternalPathLimit).toBeGreaterThan(LEGACY_WINDOWS_MAX_PATH);
    }
  });

  it("warns on Windows in both directions so the limitation is never silent", async () => {
    const report = await probeRuntimePathLimits({ baseDirectory: base });
    if (report.platform === "win32") {
      expect(report.warnings.length).toBeGreaterThan(0);
    }
  });

  it("returns a frozen report", async () => {
    const report = await probeRuntimePathLimits({ baseDirectory: base });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.warnings)).toBe(true);
  });

  it("does not throw when the probe directory cannot be used", async () => {
    const missing = join(base, "definitely", "not", "created");
    const report = await probeRuntimePathLimits({ baseDirectory: missing });
    expect(report.probe).toBe("inconclusive");
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it("falls back to the conservative limit when the probe is inconclusive", async () => {
    const missing = join(base, "also", "not", "created");
    const report = await probeRuntimePathLimits({ baseDirectory: missing });
    expect(report.longPathsUsableByRuntime).toBe(false);
    expect(report.recommendedExternalPathLimit).toBeLessThanOrEqual(1024);
  });

  it("removes its probe tree", async () => {
    const { readdir } = await import("node:fs/promises");
    await probeRuntimePathLimits({ baseDirectory: base });
    const remaining = await readdir(base);
    expect(remaining.filter((name) => name.startsWith("zet-pathprobe-"))).toEqual([]);
  });
});
