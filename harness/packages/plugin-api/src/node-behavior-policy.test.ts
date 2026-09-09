import { describe, expect, it } from "vitest";

import type { NodeBehavior } from "./index.js";
import { checkNodeBehaviorPolicy, validateNodeBehaviorPolicy } from "./node-behavior-policy.js";

const baseBehavior: NodeBehavior = {
  primitiveFamily: "pure",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "rerun",
  executionMode: "in-process",
  retry: { maxAttempts: 1 },
  requiredCapabilities: [],
};

const compileOnlyBehavior: NodeBehavior = {
  primitiveFamily: "control",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "not-applicable",
  executionMode: "none",
  requiredCapabilities: [],
};

function behavior(overrides: Partial<NodeBehavior>): NodeBehavior {
  return { ...baseBehavior, ...overrides };
}

function codes(value: NodeBehavior): readonly string[] {
  return checkNodeBehaviorPolicy(value).violations.map((violation) => violation.code);
}

describe("NodeBehavior cross-field policy", () => {
  it("accepts pure executable and compile-time/control behavior shapes", () => {
    expect(validateNodeBehaviorPolicy(baseBehavior)).toBe(true);
    expect(validateNodeBehaviorPolicy(compileOnlyBehavior)).toBe(true);
  });

  it("keeps determinism separate from side-effect idempotency", () => {
    for (const determinism of ["deterministic", "nondeterministic"] as const) {
      expect(
        validateNodeBehaviorPolicy(
          behavior({
            primitiveFamily: "effect",
            determinism,
            effect: "external-read",
            idempotency: "idempotent",
          }),
        ),
      ).toBe(true);
    }
  });

  it("requires primitive-family and effect-class agreement", () => {
    expect(codes(behavior({ primitiveFamily: "effect" }))).toEqual([
      "NODE_BEHAVIOR_EFFECT_FAMILY_MISMATCH",
    ]);
    expect(
      codes(
        behavior({
          effect: "external-read",
          idempotency: "idempotent",
        }),
      ),
    ).toEqual(["NODE_BEHAVIOR_EFFECT_FAMILY_MISMATCH"]);
  });

  it("pins idempotency vocabulary to the effect class", () => {
    expect(codes(behavior({ idempotency: "idempotent" }))).toEqual([
      "NODE_BEHAVIOR_IDEMPOTENCY_INVALID",
    ]);
    expect(
      codes(
        behavior({
          primitiveFamily: "effect",
          effect: "external-read",
          idempotency: "unknown",
        }),
      ),
    ).toEqual(["NODE_BEHAVIOR_IDEMPOTENCY_INVALID"]);
    expect(
      codes(
        behavior({
          primitiveFamily: "effect",
          effect: "external-write",
          idempotency: "not-applicable",
        }),
      ),
    ).toEqual(["NODE_BEHAVIOR_IDEMPOTENCY_INVALID"]);
  });

  it("requires recovery to agree with runtime executability", () => {
    expect(codes({ ...compileOnlyBehavior, recovery: "rerun" })).toEqual([
      "NODE_BEHAVIOR_RECOVERY_INVALID",
    ]);
    expect(codes(behavior({ recovery: "not-applicable" }))).toEqual([
      "NODE_BEHAVIOR_RECOVERY_INVALID",
    ]);
    expect(
      codes({
        ...compileOnlyBehavior,
        primitiveFamily: "effect",
        effect: "external-read",
        idempotency: "idempotent",
      }),
    ).toEqual(["NODE_BEHAVIOR_EFFECT_EXECUTION_MODE_INVALID"]);
  });

  it("reserves reconcile recovery for external writes", () => {
    expect(codes(behavior({ recovery: "reconcile" }))).toEqual([
      "NODE_BEHAVIOR_RECOVERY_INVALID",
    ]);
    expect(
      validateNodeBehaviorPolicy(
        behavior({
          primitiveFamily: "effect",
          effect: "external-write",
          idempotency: "idempotent",
          recovery: "reconcile",
        }),
      ),
    ).toBe(true);
  });

  it("forbids automatic rerun for unknown external writes", () => {
    const unsafe = behavior({
      primitiveFamily: "effect",
      determinism: "deterministic",
      effect: "external-write",
      idempotency: "unknown",
      recovery: "rerun",
    });

    expect(checkNodeBehaviorPolicy(unsafe).violations).toEqual([
      expect.objectContaining({
        code: "NODE_BEHAVIOR_RECOVERY_UNSAFE",
        field: "recovery",
      }),
    ]);
  });

  it("leaves effect-aware retry ceilings to the separate retry-policy layer", () => {
    expect(
      validateNodeBehaviorPolicy(
        behavior({
          primitiveFamily: "effect",
          effect: "external-write",
          idempotency: "unknown",
          recovery: "manual",
          retry: { maxAttempts: 99 },
        }),
      ),
    ).toBe(true);
  });
});
