import type {
  PreCrashRunningAttempt,
  RecoveredExecutionFrontier,
} from "./runtime-recovery.js";

export type PreCrashRecoveryPolicy = "rerun" | "reuse" | "reconcile" | "manual";

export type PreCrashRecoveryAction =
  | "rerun"
  | "hold-for-reuse"
  | "hold-for-reconciliation"
  | "hold-for-manual-review";

export interface PreCrashRecoveryClassification extends PreCrashRunningAttempt {
  readonly sourceNodeId: string;
  readonly recoveryPolicy: PreCrashRecoveryPolicy;
  readonly action: PreCrashRecoveryAction;
}

const RECOVERY_ACTIONS: Readonly<Record<PreCrashRecoveryPolicy, PreCrashRecoveryAction>> = {
  rerun: "rerun",
  reuse: "hold-for-reuse",
  reconcile: "hold-for-reconciliation",
  manual: "hold-for-manual-review",
};

function recoveryPolicyFor(
  value: string,
  sourceNodeId: string,
  opIndex: number,
): PreCrashRecoveryPolicy {
  if (value === "not-applicable") {
    throw new TypeError(
      `Pre-crash running op ${String(opIndex)} ('${sourceNodeId}') cannot use recovery policy 'not-applicable'.`,
    );
  }
  if (value === "rerun" || value === "reuse" || value === "reconcile" || value === "manual") {
    return value;
  }
  throw new TypeError(
    `Pre-crash running op ${String(opIndex)} ('${sourceNodeId}') has unknown recovery policy '${value}'.`,
  );
}

/**
 * Classify still-running durable attempts after restart without executing them.
 *
 * The compiler already owns effect/idempotency/recovery consistency. This runtime
 * boundary consumes only the frozen recovery policy from Execution IR and never
 * tries to re-derive whether an external write is safe to repeat.
 *
 * `rerun` is the only immediately runnable classification. A still-running
 * attempt has no committed terminal result, so `reuse`, `reconcile`, and
 * `manual` remain explicit holds until the corresponding recovery mechanism
 * resolves the uncertain pre-crash execution.
 */
export function classifyPreCrashRunningAttempts(
  frontier: Pick<RecoveredExecutionFrontier, "executionIr" | "preCrashRunningAttempts">,
): readonly PreCrashRecoveryClassification[] {
  const seenInvocations = new Set<string>();
  const classifications: PreCrashRecoveryClassification[] = [];

  for (const attempt of frontier.preCrashRunningAttempts) {
    const op = frontier.executionIr.ops[attempt.opIndex];
    if (op === undefined) {
      throw new RangeError(
        `Pre-crash running attempt references unavailable Execution IR op ${String(attempt.opIndex)}.`,
      );
    }
    if (op.behavior.executionMode === "none") {
      throw new TypeError(
        `Pre-crash running op ${String(attempt.opIndex)} ('${op.sourceNodeId}') has execution mode 'none'.`,
      );
    }

    const invocationKey = `${String(attempt.opIndex)}:${String(attempt.iteration)}`;
    if (seenInvocations.has(invocationKey)) {
      throw new TypeError(
        `Multiple pre-crash running attempts exist for op/iteration ${invocationKey}.`,
      );
    }
    seenInvocations.add(invocationKey);

    const recoveryPolicy = recoveryPolicyFor(
      op.behavior.recovery,
      op.sourceNodeId,
      attempt.opIndex,
    );
    classifications.push(
      Object.freeze({
        ...attempt,
        sourceNodeId: op.sourceNodeId,
        recoveryPolicy,
        action: RECOVERY_ACTIONS[recoveryPolicy],
      }),
    );
  }

  return Object.freeze(classifications);
}
