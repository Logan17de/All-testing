import type { WindowsSandboxPlanInput } from "../apps/runtime/src/runtime-windows-sandbox-plan.js";

export function parseWindowsSandboxPlanArguments(
  args: readonly string[],
): WindowsSandboxPlanInput | { help: true };
export function runWindowsSandboxPlan(args: readonly string[]): Promise<string>;
