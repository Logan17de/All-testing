export type InvocationPermissionDenialReason = "graph-denied" | "explicitly-denied" | "not-granted";

export class InvocationPermissionDeniedError extends Error {
  readonly code = "PERMISSION_DENIED" as const;
  readonly retryable = false as const;
  readonly remediation: Readonly<{
    action: "review-graph-policy" | "request-host-authorization";
    requiresHuman: true;
  }>;

  constructor(
    readonly op: number,
    capability: string,
    readonly reason: InvocationPermissionDenialReason,
  ) {
    const suffix =
      reason === "graph-denied"
        ? "the compiled graph denies it."
        : reason === "explicitly-denied"
          ? "current runtime authority explicitly denies it."
          : "current runtime authority does not grant it.";
    super(`Run op ${String(op)} requires capability '${capability}', but ${suffix}`);
    this.name = "InvocationPermissionDeniedError";
    this.remediation = Object.freeze({
      action: reason === "graph-denied" ? "review-graph-policy" : "request-host-authorization",
      requiresHuman: true,
    });
  }

  /** Machine responses omit arbitrary capability text, exception stacks and authority objects. */
  toJSON() {
    return {
      code: this.code,
      reason: this.reason,
      op: this.op,
      retryable: this.retryable,
      remediation: this.remediation,
    };
  }
}

/** Runtime demand enforcement only; graph shape and behavior validation remain compiler-owned. */
export function assertInvocationPermission(
  op: number,
  required: readonly string[],
  deniedByGraph: readonly string[],
  evaluate:
    | ((capability: string) => {
        readonly decision: "allow" | "deny";
        readonly denialReason?: "explicitly-denied" | "not-granted";
      })
    | undefined,
): void {
  for (const capability of new Set(required)) {
    if (deniedByGraph.includes(capability)) {
      throw new InvocationPermissionDeniedError(op, capability, "graph-denied");
    }
    const evaluation = evaluate?.(capability);
    if (evaluation?.decision === "allow") continue;
    throw new InvocationPermissionDeniedError(
      op,
      capability,
      evaluation?.denialReason === "explicitly-denied" ? "explicitly-denied" : "not-granted",
    );
  }
}
