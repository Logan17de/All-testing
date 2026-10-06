import { expect, it } from "vitest";
import {
  createWindowsSandboxPreparationPlan,
  type WindowsSandboxPlanInput,
} from "./runtime-windows-sandbox-plan.js";
const input: WindowsSandboxPlanInput = {
  backend: "dedicated-user",
  sourceRoot: "C:\\Projects\\Fixture",
  privateStatePaths: ["C:\\Private\\runtime.sqlite-wal", "C:\\Private\\runtime.sqlite"],
  disposableWorkArea: "D:\\Disposable\\Fixture",
};
it("produces deterministic immutable review metadata without execution authority", () => {
  const plan = createWindowsSandboxPreparationPlan(input);
  expect(plan).toEqual(
    createWindowsSandboxPreparationPlan({
      ...input,
      privateStatePaths: [...input.privateStatePaths].reverse(),
    }),
  );
  expect(plan).toMatchObject({
    version: 1,
    availability: "disabled",
    executionAuthority: "none",
    purpose: "human-review-only",
    prerequisites: { version: 1 },
  });
  expect(plan.setup.every((action) => action.requiresExplicitHumanApproval)).toBe(true);
  expect(plan.rollback.map((action) => action.id)).toEqual([
    "disable-dispatch",
    "revoke-dedicated-logon",
    "stop-owned-processes",
    "remove-disposable-workarea",
    "restore-recorded-acls",
    "restore-recorded-firewall-policy",
    "restore-recorded-logon-policy",
    "remove-private-credentials",
    "remove-dedicated-account",
  ]);
  expect(Object.isFrozen(plan)).toBe(true);
  expect(Object.isFrozen(plan.paths.privateStatePaths)).toBe(true);
  expect(Object.isFrozen(plan.prerequisites.items[0])).toBe(true);
  expect(Object.isFrozen(plan.setup[0])).toBe(true);
  expect(Object.keys(plan)).not.toContain("commands");
  expect(Object.keys(plan)).not.toContain("apply");
  const serialized = JSON.stringify(plan);
  expect(serialized).not.toContain("password");
  expect(serialized).not.toContain("powershell.exe");
});
it("rejects noncanonical, device, ambiguous and malformed Windows paths", () => {
  for (const path of [
    "C:\\",
    "c:\\Project",
    "C:Project",
    "\\Project",
    "\\\\server\\share\\project",
    "\\\\?\\C:\\Project",
    "C:/Project",
    "C:\\Project\\..\\Other",
    "C:\\Project\\",
    "C:\\Project\\file:stream",
    "C:\\Project\\bad\nname",
    "C:\\Project\\name.",
    "C:\\Project\\name ",
    "C:\\Project\\NUL.txt",
    "C:\\Project\\CONIN$",
    "C:\\Project\\CONOUT$.txt",
    "C:\\Project\\COM¹",
    "C:\\Project\\LPT².txt",
    "C:\\Project\\*.txt",
  ]) {
    expect(() => createWindowsSandboxPreparationPlan({ ...input, sourceRoot: path })).toThrow(
      "Invalid Windows sandbox",
    );
  }
});
it("rejects duplicates and all source/private/disposable ancestor overlaps", () => {
  for (const change of [
    { disposableWorkArea: "C:\\Projects\\Fixture\\Copy" },
    { disposableWorkArea: "C:\\Projects" },
    { privateStatePaths: ["C:\\Projects\\Fixture\\runtime.sqlite"] },
    { privateStatePaths: ["D:\\Disposable\\Fixture\\state"] },
    { privateStatePaths: ["C:\\Private\\state", "C:\\PRIVATE\\STATE"] },
    { privateStatePaths: ["C:\\Private", "C:\\Private\\state"] },
    { privateStatePaths: [] },
  ])
    expect(() => createWindowsSandboxPreparationPlan({ ...input, ...change })).toThrow();
  expect(() =>
    createWindowsSandboxPreparationPlan({
      ...input,
      disposableWorkArea: "C:\\Projects\\Fixture-copy",
    }),
  ).not.toThrow();
});
it("rejects executable, credential and imported-authority fields rather than enabling a backend", () => {
  for (const extra of [
    { backend: "appcontainer" },
    { commands: ["run"] },
    { password: "synthetic-never-accepted" },
    { availability: "enabled" },
    { executionAuthority: "approved" },
  ]) {
    expect(() =>
      createWindowsSandboxPreparationPlan({ ...input, ...extra } as WindowsSandboxPlanInput),
    ).toThrow();
  }
  const plan = createWindowsSandboxPreparationPlan(input);
  expect(() =>
    createWindowsSandboxPreparationPlan(
      JSON.parse(JSON.stringify(plan)) as WindowsSandboxPlanInput,
    ),
  ).toThrow();
});
