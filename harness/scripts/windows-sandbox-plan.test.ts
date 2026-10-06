import { describe, expect, it } from "vitest";
import {
  parseWindowsSandboxPlanArguments,
  runWindowsSandboxPlan,
} from "./windows-sandbox-plan.mjs";

describe("review-only Windows sandbox CLI", () => {
  it("requires explicit paths and rejects setup, credential and automatic approval options", () => {
    const args = [
      "--source",
      "C:\\Project",
      "--private-state",
      "C:\\State\\runtime.db",
      "--work-area",
      "C:\\Scratch",
    ];
    expect(parseWindowsSandboxPlanArguments(args)).toEqual({
      backend: "dedicated-user",
      sourceRoot: "C:\\Project",
      privateStatePaths: ["C:\\State\\runtime.db"],
      disposableWorkArea: "C:\\Scratch",
    });
    for (const extra of ["--apply", "--password", "--sid", "--approve", "--source", "--backend"])
      expect(() => parseWindowsSandboxPlanArguments([...args, extra, "secret"])).toThrow();
    for (const missing of [[], ["--source"], ["--help", "--apply"]])
      expect(() => parseWindowsSandboxPlanArguments(missing)).toThrow();
  });
  it("help performs no runtime setup and states the review boundary", async () => {
    expect(await runWindowsSandboxPlan(["--help"])).toContain("no setup or execution");
    expect(await runWindowsSandboxPlan(["--help"])).toContain("No credentials");
  });
});
