import { describe, expect, it, vi } from "vitest";

import { SchedulerConcurrency } from "./concurrency.js";
import { InvocationPermissionDeniedError } from "./invocation-permission.js";
import { PlainDagRun } from "./plain-dag-run.js";
import { createMockExecutionIr, createMockExecutionOp } from "./testing.js";

describe("machine-readable invocation permission denials", () => {
  it.each(["graph-denied", "explicitly-denied", "not-granted"] as const)(
    "returns a terminal %s denial without running or charging an attempt",
    async (reason) => {
      const capability = "sensitive-capability-name";
      const base = createMockExecutionIr([
        createMockExecutionOp("denial", [], {
          behavior: { requiredCapabilities: [capability], retry: { maxAttempts: 4 } },
        }),
      ]);
      const plan = {
        ...base,
        policies: {
          ...base.policies,
          capabilities: {
            ...base.policies.capabilities,
            deny: reason === "graph-denied" ? [capability] : [],
          },
        },
      };
      const scheduler = new SchedulerConcurrency(1);
      const executor = vi.fn();
      const evaluate = vi.fn(() => ({
        decision: "deny" as const,
        denialReason:
          reason === "explicitly-denied" ? ("explicitly-denied" as const) : ("not-granted" as const),
      }));
      const run = new PlainDagRun(plan, scheduler.createRun(plan), executor, {
        capabilityAuthority: { evaluate },
      });
      const error: unknown = await run.execute().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(InvocationPermissionDeniedError);
      if (!(error instanceof InvocationPermissionDeniedError)) {
        throw new Error("Expected a typed permission denial.");
      }
      expect(error.toJSON()).toEqual({
        code: "PERMISSION_DENIED",
        reason,
        op: 0,
        retryable: false,
        remediation: {
          action: reason === "graph-denied" ? "review-graph-policy" : "request-host-authorization",
          requiresHuman: true,
        },
      });
      expect(JSON.stringify(error)).not.toContain(capability);
      expect(JSON.stringify(error)).not.toContain("stack");
      expect(Object.isFrozen(error.remediation)).toBe(true);
      expect(executor).not.toHaveBeenCalled();
      expect(run.snapshot().attempts).toEqual([0]);
      expect(run.snapshot().attemptBudgetUsed).toEqual([0]);
      if (reason === "graph-denied") expect(evaluate).not.toHaveBeenCalled();
    },
  );
});
