import type { DatabaseSync } from "node:sqlite";

import { hashExecutionIrContentV1, type ExecutionIrV1 } from "@zet-harness/graph";

/** Journaled once when a run is refused because its plan is no longer what it was. */
export const RUN_IDENTITY_MISMATCH_EVENT_TYPE = "harness.run.identity-mismatch" as const;

/** How the runtime resolves a node type today: the plugin that would run it. */
export type RuntimeNodeResolver = (
  type: string,
  version: string,
) => { readonly pluginId: string; readonly pluginVersion: string } | undefined;

export type PlanIdentityIssueCode =
  | "PLAN_UNAVAILABLE"
  | "PLAN_IR_CHANGED"
  | "PLAN_PINS_UNREADABLE"
  | "PLAN_NODE_UNAVAILABLE"
  | "PLAN_PLUGIN_CHANGED";

export interface PlanIdentityIssue {
  readonly code: PlanIdentityIssueCode;
  readonly message: string;
  readonly nodeId?: string;
}

export interface PlanIdentityReport {
  readonly compiledPlanId: number;
  readonly ok: boolean;
  readonly issues: readonly PlanIdentityIssue[];
}

interface NodePin {
  readonly nodeId: string;
  readonly type: string;
  readonly version: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
}

function readPins(json: string): readonly NodePin[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const pins: NodePin[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const pin = entry as Record<string, unknown>;
    const fields = ["nodeId", "type", "version", "pluginId", "pluginVersion"] as const;
    if (fields.some((field) => typeof pin[field] !== "string")) return undefined;
    pins.push({
      nodeId: pin["nodeId"] as string,
      type: pin["type"] as string,
      version: pin["version"] as string,
      pluginId: pin["pluginId"] as string,
      pluginVersion: pin["pluginVersion"] as string,
    });
  }
  return pins;
}

/**
 * Check that a compiled plan is still what a run was admitted against.
 *
 * Two things can change under a run between one wake-up and the next: the stored
 * plan itself, and the code its nodes resolve to. The Execution IR is content
 * hashed at compile time, so an edited plan row is detectable without recompiling
 * anything, and the plan's pins record the exact node and plugin versions the
 * compiler resolved, so a node that is gone or now comes from a different plugin
 * version is detectable without running it. Neither check needs the authoring
 * document, which execution never reads.
 *
 * Without a resolver only the plan's own content is checked.
 */
export async function verifyCompiledPlanIdentity(
  connection: DatabaseSync,
  compiledPlanId: number,
  resolveNode?: RuntimeNodeResolver,
): Promise<PlanIdentityReport> {
  const issues: PlanIdentityIssue[] = [];
  const frozen = (): PlanIdentityReport =>
    Object.freeze({
      compiledPlanId,
      ok: issues.length === 0,
      issues: Object.freeze(issues.map((issue) => Object.freeze(issue))),
    });

  const row = connection
    .prepare(
      `SELECT ir_hash AS irHash, execution_ir_json AS irJson, node_pins_json AS nodePinsJson
       FROM compiled_plans WHERE compiled_plan_id = ?`,
    )
    .get(compiledPlanId) as
    { readonly irHash: string; readonly irJson: string; readonly nodePinsJson: string } | undefined;
  if (row === undefined) {
    issues.push({
      code: "PLAN_UNAVAILABLE",
      message: `The compiled plan ${String(compiledPlanId)} this run was created from is no longer stored.`,
    });
    return frozen();
  }

  let ir: ExecutionIrV1 | undefined;
  try {
    ir = JSON.parse(row.irJson) as ExecutionIrV1;
  } catch {
    ir = undefined;
  }
  if (ir === undefined) {
    issues.push({
      code: "PLAN_IR_CHANGED",
      message: "The stored execution plan is no longer readable JSON.",
    });
  } else if ((await hashExecutionIrContentV1(ir)) !== row.irHash) {
    issues.push({
      code: "PLAN_IR_CHANGED",
      message:
        "The stored execution plan no longer matches the content it was compiled with, so this run would do different work than it started.",
    });
  }

  const pins = readPins(row.nodePinsJson);
  if (pins === undefined) {
    issues.push({
      code: "PLAN_PINS_UNREADABLE",
      message: "The node versions this plan was compiled against cannot be read.",
    });
    return frozen();
  }
  if (resolveNode === undefined) return frozen();

  for (const pin of pins) {
    const resolved = resolveNode(pin.type, pin.version);
    if (resolved === undefined) {
      issues.push({
        code: "PLAN_NODE_UNAVAILABLE",
        message: `Node '${pin.nodeId}' needs ${pin.type}@${pin.version}, which no enabled plugin provides now.`,
        nodeId: pin.nodeId,
      });
    } else if (resolved.pluginId !== pin.pluginId || resolved.pluginVersion !== pin.pluginVersion) {
      issues.push({
        code: "PLAN_PLUGIN_CHANGED",
        message: `Node '${pin.nodeId}' was compiled against ${pin.pluginId}@${pin.pluginVersion} and would now run on ${resolved.pluginId}@${resolved.pluginVersion}.`,
        nodeId: pin.nodeId,
      });
    }
  }
  return frozen();
}
