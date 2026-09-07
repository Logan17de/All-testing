import type { ExecutionIrOpV1, ExecutionIrV1 } from "@zet-harness/graph";

import type { PlainDagOpExecution, PlainDagOpExecutor } from "./plain-dag-run.js";

const DEFAULT_MOCK_BEHAVIOR: ExecutionIrOpV1["behavior"] = Object.freeze({
  primitiveFamily: "pure",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "rerun",
  executionMode: "in-process",
  requiredCapabilities: Object.freeze([]),
});

export type MockExecutionOpOverrides = Omit<
  Partial<ExecutionIrOpV1>,
  "sourceNodeId" | "dependencies" | "behavior"
> & {
  readonly behavior?: Partial<ExecutionIrOpV1["behavior"]>;
};

/** Build one deterministic executable IR op for scheduler tests. */
export function createMockExecutionOp(
  sourceNodeId: string,
  dependencies: readonly number[] = [],
  overrides: MockExecutionOpOverrides = {},
): ExecutionIrOpV1 {
  const { behavior, ...opOverrides } = overrides;
  return {
    sourceNodeId,
    type: "test.node",
    version: "1",
    config: {},
    inputs: [],
    dependencies: [...dependencies],
    behavior: {
      ...DEFAULT_MOCK_BEHAVIOR,
      ...behavior,
      requiredCapabilities: [...(behavior?.requiredCapabilities ?? [])],
    },
    ...opOverrides,
  };
}

/** Build a minimal immutable-shape Execution IR for plain scheduler tests. */
export function createMockExecutionIr(
  ops: readonly ExecutionIrOpV1[],
  maxParallelism = 1,
): ExecutionIrV1 {
  if (!Number.isSafeInteger(maxParallelism) || maxParallelism < 1) {
    throw new TypeError("Mock execution IR maxParallelism must be a positive safe integer.");
  }

  return {
    format: "harness.ir/v1",
    graphInputs: [],
    graphOutputs: [],
    ops: [...ops],
    controlEdges: [],
    entrypoints: [],
    policies: {
      maxParallelism,
      capabilities: { required: [], optional: [], deny: [] },
    },
  };
}

export interface DeterministicMockGate {
  readonly promise: Promise<void>;
  readonly released: boolean;
  /** Release exactly once. Returns false for later idempotent calls. */
  release(): boolean;
}

/** Manual promise gate with no clocks or randomness. */
export function createDeterministicMockGate(): DeterministicMockGate {
  let released = false;
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });

  return Object.freeze({
    promise,
    get released(): boolean {
      return released;
    },
    release(): boolean {
      if (released) {
        return false;
      }
      released = true;
      resolve();
      return true;
    },
  });
}

interface DeterministicMockStepBase {
  /** Adapter/executor-internal retries charged before the scripted outcome. */
  readonly internalRetries?: number;
}

export type DeterministicMockExecutorStep =
  | (DeterministicMockStepBase & { readonly kind: "complete" })
  | (DeterministicMockStepBase & { readonly kind: "fail"; readonly error: unknown })
  | (DeterministicMockStepBase & {
      readonly kind: "gate";
      readonly gate: DeterministicMockGate;
      readonly outcome?: "complete" | { readonly error: unknown };
    })
  | (DeterministicMockStepBase & { readonly kind: "wait-for-abort" });

export type DeterministicMockExecutorScript = Readonly<
  Record<string, readonly DeterministicMockExecutorStep[]>
>;

export interface DeterministicMockInvocation {
  readonly sequence: number;
  readonly op: number;
  readonly sourceNodeId: string;
  readonly attempt: number;
  readonly internalRetries: number;
  readonly maxAttempts: number;
  readonly budgetUsedAtStart: number;
  readonly budgetRemainingAtStart: number;
}

export type DeterministicMockTraceEvent =
  | {
      readonly sequence: number;
      readonly phase: "start" | "complete";
      readonly op: number;
      readonly sourceNodeId: string;
      readonly attempt: number;
    }
  | {
      readonly sequence: number;
      readonly phase: "fail" | "abort";
      readonly op: number;
      readonly sourceNodeId: string;
      readonly attempt: number;
      readonly error: unknown;
    };

export interface DeterministicMockExecutorSnapshot {
  readonly invocations: readonly DeterministicMockInvocation[];
  readonly trace: readonly DeterministicMockTraceEvent[];
  readonly active: number;
  readonly maxActive: number;
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function abortReasonError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new Error(
    signal.reason === undefined
      ? "Deterministic mock execution aborted."
      : `Deterministic mock execution aborted: ${String(signal.reason)}`,
  );
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(abortReasonError(signal));
  }

  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(abortReasonError(signal));
      },
      { once: true },
    );
  });
}

/**
 * Scripted, deterministic PlainDag executor for scheduler tests.
 *
 * Scripts are keyed by stable `sourceNodeId`; each array position corresponds to
 * the one-based scheduler attempt. Unscripted nodes complete immediately. A node
 * with an explicit script must provide every attempt it expects to execute, so a
 * missing scripted attempt fails loudly instead of silently passing a test.
 */
export class DeterministicPlainDagExecutor {
  private readonly scripts = new Map<string, readonly DeterministicMockExecutorStep[]>();
  private readonly invocations: DeterministicMockInvocation[] = [];
  private readonly trace: DeterministicMockTraceEvent[] = [];
  private sequence = 0;
  private active = 0;
  private maxActive = 0;

  constructor(script: DeterministicMockExecutorScript = {}) {
    for (const [sourceNodeId, steps] of Object.entries(script)) {
      this.scripts.set(sourceNodeId, freezeArray(steps));
    }
  }

  readonly execute: PlainDagOpExecutor = async (execution) => {
    const step = this.resolveStep(execution);
    const internalRetries = step.internalRetries ?? 0;
    const invocation = Object.freeze({
      sequence: this.nextSequence(),
      op: execution.op,
      sourceNodeId: execution.operation.sourceNodeId,
      attempt: execution.attempt,
      internalRetries,
      maxAttempts: execution.retryBudget.maxAttempts,
      budgetUsedAtStart: execution.retryBudget.usedAttempts,
      budgetRemainingAtStart: execution.retryBudget.remainingAttempts,
    });
    this.invocations.push(invocation);
    this.trace.push(
      Object.freeze({
        sequence: invocation.sequence,
        phase: "start" as const,
        op: invocation.op,
        sourceNodeId: invocation.sourceNodeId,
        attempt: invocation.attempt,
      }),
    );

    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);

    try {
      if (internalRetries !== 0) {
        execution.retryBudget.reportInternalRetries(internalRetries);
      }

      switch (step.kind) {
        case "complete":
          break;
        case "fail":
          throw step.error;
        case "gate":
          await step.gate.promise;
          if (step.outcome !== undefined && step.outcome !== "complete") {
            throw step.outcome.error;
          }
          break;
        case "wait-for-abort":
          await waitForAbort(execution.signal);
          break;
      }

      this.trace.push(
        Object.freeze({
          sequence: this.nextSequence(),
          phase: "complete" as const,
          op: invocation.op,
          sourceNodeId: invocation.sourceNodeId,
          attempt: invocation.attempt,
        }),
      );
    } catch (error) {
      const aborted = step.kind === "wait-for-abort" && execution.signal.aborted;
      this.trace.push(
        Object.freeze({
          sequence: this.nextSequence(),
          phase: aborted ? ("abort" as const) : ("fail" as const),
          op: invocation.op,
          sourceNodeId: invocation.sourceNodeId,
          attempt: invocation.attempt,
          error,
        }),
      );
      throw error;
    } finally {
      this.active -= 1;
    }
  };

  snapshot(): DeterministicMockExecutorSnapshot {
    return Object.freeze({
      invocations: freezeArray(this.invocations),
      trace: freezeArray(this.trace),
      active: this.active,
      maxActive: this.maxActive,
    });
  }

  private resolveStep(execution: PlainDagOpExecution): DeterministicMockExecutorStep {
    const sourceNodeId = execution.operation.sourceNodeId;
    const steps = this.scripts.get(sourceNodeId);
    if (steps === undefined) {
      return { kind: "complete" };
    }

    const step = steps[execution.attempt - 1];
    if (step === undefined) {
      throw new RangeError(
        `No deterministic mock step configured for '${sourceNodeId}' attempt ${String(execution.attempt)}.`,
      );
    }
    return step;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }
}
