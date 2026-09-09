import { describe, expect, it, vi } from "vitest";

import { SchedulerConcurrency } from "./concurrency.js";
import { PlainDagRun, type PlainDagCapabilityAuthority } from "./plain-dag-run.js";
import { createMockExecutionIr, createMockExecutionOp } from "./testing.js";

function createRun(
  requiredCapabilities: readonly string[],
  executor: ConstructorParameters<typeof PlainDagRun>[2],
  options: ConstructorParameters<typeof PlainDagRun>[3] = {},
  deny: readonly string[] = [],
): PlainDagRun {
  const operation = createMockExecutionOp("capability-op", [], {
    behavior: { requiredCapabilities },
  });
  const base = createMockExecutionIr([operation]);
  const plan = {
    ...base,
    policies: {
      ...base.policies,
      capabilities: { ...base.policies.capabilities, deny: [...deny] },
    },
  };
  const scheduler = new SchedulerConcurrency(1);
  return new PlainDagRun(plan, scheduler.createRun(plan), executor, options);
}

describe("invocation capability policy", () => {
  it("runs capability-free ops without requiring host authority", async () => {
    const executor = vi.fn();
    const result = await createRun([], executor).execute();

    expect(executor).toHaveBeenCalledOnce();
    expect(result.attempts).toEqual([1]);
  });

  it("requires all declared capabilities and evaluates duplicates once per invocation", async () => {
    const evaluateImpl: PlainDagCapabilityAuthority["evaluate"] = (capability) => ({
      decision: capability === "fs:read" || capability === "network:http" ? "allow" : "deny",
    });
    const evaluate = vi.fn(evaluateImpl);
    const executor = vi.fn();

    await createRun(["fs:read", "fs:read", "network:http"], executor, {
      capabilityAuthority: { evaluate },
    }).execute();

    expect(executor).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls.map(([capability]) => capability)).toEqual([
      "fs:read",
      "network:http",
    ]);
  });

  it("fails closed before consuming an attempt when required authority is absent", async () => {
    const executor = vi.fn();
    const run = createRun(["fs:read"], executor);

    await expect(run.execute()).rejects.toThrow(
      "Run op 0 requires capability 'fs:read', but current runtime authority does not grant it.",
    );

    expect(executor).not.toHaveBeenCalled();
    expect(run.snapshot().attempts).toEqual([0]);
    expect(run.snapshot().attemptBudgetUsed).toEqual([0]);
    expect(run.snapshot().readiness.ops).toEqual([{ op: 0, status: "failed" }]);
  });

  it("preserves explicit-deny reason while keeping denial terminal", async () => {
    const executor = vi.fn();
    const run = createRun(["fs:write"], executor, {
      capabilityAuthority: {
        evaluate: () => ({ decision: "deny", denialReason: "explicitly-denied" }),
      },
    });

    await expect(run.execute()).rejects.toThrow(
      "Run op 0 requires capability 'fs:write', but current runtime authority explicitly denies it.",
    );
    expect(executor).not.toHaveBeenCalled();
    expect(run.snapshot().attempts).toEqual([0]);
  });

  it("keeps compiled graph deny as a one-way restriction without consulting host authority", async () => {
    const evaluate = vi.fn(() => ({ decision: "allow" as const }));
    const executor = vi.fn();
    const run = createRun(["network:http"], executor, { capabilityAuthority: { evaluate } }, [
      "network:http",
    ]);

    await expect(run.execute()).rejects.toThrow(
      "Run op 0 requires capability 'network:http', but the compiled graph denies it.",
    );
    expect(evaluate).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  it("re-checks current authority on retry and honors revocation before another attempt starts", async () => {
    let granted = true;
    const evaluate = vi.fn(() =>
      granted
        ? ({ decision: "allow" } as const)
        : ({ decision: "deny", denialReason: "explicitly-denied" } as const),
    );
    let executorCalls = 0;
    const operation = createMockExecutionOp("revoked-retry", [], {
      behavior: {
        requiredCapabilities: ["network:http"],
        retry: { maxAttempts: 2, backoffMs: 0 },
      },
    });
    const plan = createMockExecutionIr([operation]);
    const scheduler = new SchedulerConcurrency(1);
    const run = new PlainDagRun(
      plan,
      scheduler.createRun(plan),
      () => {
        executorCalls += 1;
        granted = false;
        throw new Error("transient provider failure");
      },
      { capabilityAuthority: { evaluate } },
    );

    await expect(run.execute()).rejects.toThrow(
      "Run op 0 requires capability 'network:http', but current runtime authority explicitly denies it.",
    );

    expect(executorCalls).toBe(1);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(run.snapshot().attempts).toEqual([1]);
    expect(run.snapshot().attemptBudgetUsed).toEqual([1]);
  });

  it("checks permission before effect retry proof or executor code", async () => {
    const executor = vi.fn();
    const hasBoundIdempotencyKey = vi.fn(() => true);
    const operation = createMockExecutionOp("denied-write", [], {
      behavior: {
        primitiveFamily: "effect",
        effect: "external-write",
        idempotency: "idempotency-key",
        recovery: "reconcile",
        requiredCapabilities: ["fs:write"],
        retry: { maxAttempts: 2 },
      },
    });
    const plan = createMockExecutionIr([operation]);
    const scheduler = new SchedulerConcurrency(1);
    const run = new PlainDagRun(plan, scheduler.createRun(plan), executor, {
      capabilityAuthority: {
        evaluate: () => ({ decision: "deny", denialReason: "not-granted" }),
      },
      effectRetry: { hasBoundIdempotencyKey },
    });

    await expect(run.execute()).rejects.toThrow(
      "Run op 0 requires capability 'fs:write', but current runtime authority does not grant it.",
    );
    expect(hasBoundIdempotencyKey).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
    expect(run.snapshot().attempts).toEqual([0]);
  });
});
