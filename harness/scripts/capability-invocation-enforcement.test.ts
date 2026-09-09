import { describe, expect, it, vi } from "vitest";

import { CapabilityPermissionPolicy } from "@zet-harness/core";
import { PlainDagRun, SchedulerConcurrency } from "@zet-harness/scheduler";
import { createMockExecutionIr, createMockExecutionOp } from "@zet-harness/scheduler/testing";

function runtimePlan(capability: string) {
  return createMockExecutionIr([
    createMockExecutionOp("runtime-policy", [], {
      behavior: { requiredCapabilities: [capability] },
    }),
  ]);
}

describe("CapabilityPermissionPolicy invocation integration", () => {
  it("lets the real host policy authorize an exact required capability", async () => {
    const policy = new CapabilityPermissionPolicy({ granted: ["fs:read"] });
    const plan = runtimePlan("fs:read");
    const scheduler = new SchedulerConcurrency(1);
    const executor = vi.fn();

    await new PlainDagRun(plan, scheduler.createRun(plan), executor, {
      capabilityAuthority: policy,
    }).execute();

    expect(executor).toHaveBeenCalledOnce();
  });

  it("preserves exact-match and explicit-deny semantics at invocation time", async () => {
    const exactOnly = new CapabilityPermissionPolicy({ granted: ["fs:read"] });
    const exactPlan = runtimePlan("fs:read:metadata");
    const exactScheduler = new SchedulerConcurrency(1);
    const exactExecutor = vi.fn();

    await expect(
      new PlainDagRun(exactPlan, exactScheduler.createRun(exactPlan), exactExecutor, {
        capabilityAuthority: exactOnly,
      }).execute(),
    ).rejects.toThrow("current runtime authority does not grant it");
    expect(exactExecutor).not.toHaveBeenCalled();

    const denied = new CapabilityPermissionPolicy({
      granted: ["network:http"],
      denied: ["network:http"],
    });
    const deniedPlan = runtimePlan("network:http");
    const deniedScheduler = new SchedulerConcurrency(1);
    const deniedExecutor = vi.fn();

    await expect(
      new PlainDagRun(deniedPlan, deniedScheduler.createRun(deniedPlan), deniedExecutor, {
        capabilityAuthority: denied,
      }).execute(),
    ).rejects.toThrow("current runtime authority explicitly denies it");
    expect(deniedExecutor).not.toHaveBeenCalled();
  });
});
