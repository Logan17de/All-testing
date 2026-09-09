import { describe, expect, it } from "vitest";

import {
  computeUpperBound,
  evaluateBaselineSnapshot,
  type BaselinePolicy,
  type BaselineSnapshot,
} from "./check-lightweight-baseline.js";

const policy: BaselinePolicy = {
  startupMedianMs: { multiplier: 3, additive: 100 },
  idleRssMedianBytes: { multiplier: 1.5, additive: 32 * 1024 * 1024 },
  compilerMedianMs: { multiplier: 2, additive: 2 },
  schedulerMedianMs: { multiplier: 3, additive: 1 },
  sqliteMedianMs: { multiplier: 4, additive: 5 },
};

const reference: BaselineSnapshot = {
  startupMedianMs: 50,
  idleRssMedianBytes: 64 * 1024 * 1024,
  compilerMedianMs: 2,
  schedulerMedianMs: 0.25,
  sqliteMedianMs: 0.5,
  directRuntimeDependencies: {
    total: 1,
    workspace: 1,
    external: 0,
    names: ["@zet-harness/db"],
  },
};

describe("lightweight baseline CI policy", () => {
  it("uses the larger of multiplicative and additive slack", () => {
    expect(computeUpperBound(10, { multiplier: 2, additive: 25 })).toBe(35);
    expect(computeUpperBound(20, { multiplier: 3, additive: 5 })).toBe(60);
  });

  it("passes improvements and ordinary machine noise", () => {
    const observed: BaselineSnapshot = {
      ...reference,
      startupMedianMs: 120,
      idleRssMedianBytes: 80 * 1024 * 1024,
      compilerMedianMs: 3.5,
      schedulerMedianMs: 1,
      sqliteMedianMs: 4,
    };

    expect(evaluateBaselineSnapshot("ubuntu-latest", observed, reference, policy).status).toBe(
      "pass",
    );
  });

  it("fails a large performance regression", () => {
    const observed: BaselineSnapshot = {
      ...reference,
      compilerMedianMs: 4.1,
    };

    const result = evaluateBaselineSnapshot("ubuntu-latest", observed, reference, policy);
    expect(result.status).toBe("fail");
    expect(result.checks.find((check) => check.metric === "compiler median ms")?.pass).toBe(false);
  });

  it("treats direct runtime dependency drift as an exact failure", () => {
    const observed: BaselineSnapshot = {
      ...reference,
      directRuntimeDependencies: {
        total: 2,
        workspace: 1,
        external: 1,
        names: ["@zet-harness/db", "example-package"],
      },
    };

    const result = evaluateBaselineSnapshot("windows-latest", observed, reference, policy);
    expect(result.status).toBe("fail");
    expect(result.checks.find((check) => check.metric === "direct runtime dependencies")?.pass).toBe(
      false,
    );
  });
});
