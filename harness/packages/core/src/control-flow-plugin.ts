import {
  PLUGIN_API_VERSION,
  type HarnessPlugin,
  type JsonValue,
  type NodeBehavior,
} from "@zet-harness/plugin-api";

export const CONTROL_FLOW_PLUGIN_ID = "harness.control-flow-plugin" as const;
export const CONDITION_NODE_TYPE = "harness.condition" as const;
export const ROUTE_NODE_TYPE = "harness.route" as const;
export const JOIN_ALL_NODE_TYPE = "harness.join-all" as const;
export const JOIN_ANY_NODE_TYPE = "harness.join-any" as const;
export const LOOP_NODE_TYPE = "harness.loop" as const;

export type ConditionOperator = "equals" | "not-equals" | "contains" | "truthy" | "falsy";

export const CONDITION_OPERATORS: readonly ConditionOperator[] = Object.freeze([
  "equals",
  "not-equals",
  "contains",
  "truthy",
  "falsy",
]);

const PURE: NodeBehavior = {
  primitiveFamily: "pure",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "rerun",
  executionMode: "in-process",
  requiredCapabilities: [],
};

/** Scheduler-owned: no executor runs, so there is nothing to retry or recover. */
const CONTROL: NodeBehavior = {
  primitiveFamily: "control",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "not-applicable",
  executionMode: "none",
  requiredCapabilities: [],
};

/** Order-independent JSON text, so structurally equal values compare equal. */
function canonical(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${(value as readonly JsonValue[]).map((item) => canonical(item)).join(",")}]`;
  }
  const record = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

/** JSON truthiness: false, null, 0, "", empty arrays and empty objects are falsy. */
function isTruthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * Decide one condition.
 *
 * `contains` checks a substring for strings and a structurally equal element for
 * arrays; any other combination does not match rather than guessing.
 */
export function evaluateCondition(
  operator: ConditionOperator,
  value: JsonValue | undefined,
  compare: JsonValue | undefined,
): boolean {
  switch (operator) {
    case "equals":
      return canonical(value) === canonical(compare);
    case "not-equals":
      return canonical(value) !== canonical(compare);
    case "contains":
      if (typeof value === "string" && typeof compare === "string") return value.includes(compare);
      if (Array.isArray(value)) {
        const wanted = canonical(compare);
        return (value as readonly JsonValue[]).some((item) => canonical(item) === wanted);
      }
      return false;
    case "truthy":
      return isTruthy(value);
    case "falsy":
      return !isTruthy(value);
  }
}

function isConditionOperator(value: JsonValue | undefined): value is ConditionOperator {
  return typeof value === "string" && (CONDITION_OPERATORS as readonly string[]).includes(value);
}

/**
 * First-party control flow: a condition, a yes/no router, two joins and a bounded loop.
 *
 * Registered through the same public plugin path as any third-party node. The
 * router and joins are resolved by the scheduler and never executed; only the
 * condition runs code. Plugin authors can declare routers and joins with their
 * own branch and lane names in exactly the same way.
 */
export function createControlFlowPlugin(): HarnessPlugin {
  return {
    manifest: {
      id: CONTROL_FLOW_PLUGIN_ID,
      name: "Control flow",
      version: "1",
      apiVersion: PLUGIN_API_VERSION,
    },
    activate(context) {
      context.nodes.register({
        manifest: {
          type: CONDITION_NODE_TYPE,
          version: "1",
          title: "Condition",
          description: "Checks a value and outputs 'yes' or 'no' for a Route node to follow.",
          inputs: { value: { schema: true, required: true } },
          outputs: {
            branch: { schema: { type: "string" } },
            matched: { schema: { type: "boolean" } },
          },
          configSchema: {
            type: "object",
            properties: {
              operator: { type: "string", enum: [...CONDITION_OPERATORS] },
              compare: true,
            },
            required: ["operator"],
            additionalProperties: false,
          },
          behavior: PURE,
        },
        execute(request) {
          const operator = request.config["operator"];
          if (!isConditionOperator(operator)) {
            throw new TypeError(
              `Condition operator must be one of: ${CONDITION_OPERATORS.join(", ")}.`,
            );
          }
          const matched = evaluateCondition(
            operator,
            request.inputs["value"],
            request.config["compare"],
          );
          return { outputs: { branch: matched ? "yes" : "no", matched } };
        },
      });

      context.nodes.register({
        manifest: {
          type: ROUTE_NODE_TYPE,
          version: "1",
          title: "Route",
          description:
            "Continues down the 'yes' or 'no' branch named on its branch input and skips the other.",
          inputs: { branch: { schema: { type: "string" }, required: true } },
          outputs: {},
          configSchema: { type: "object", additionalProperties: false },
          behavior: CONTROL,
          control: { kind: "router", entry: "in", branches: ["yes", "no"] },
        },
      });

      context.nodes.register({
        manifest: {
          type: JOIN_ALL_NODE_TYPE,
          version: "1",
          title: "Wait for all",
          description:
            "Continues once every active path into lanes a and b has finished. Skipped paths do not block it.",
          inputs: {},
          outputs: {},
          configSchema: { type: "object", additionalProperties: false },
          behavior: CONTROL,
          control: { kind: "join", inputs: ["a", "b"], output: "out", mode: "all-active" },
        },
      });

      context.nodes.register({
        manifest: {
          type: JOIN_ANY_NODE_TYPE,
          version: "1",
          title: "Wait for any",
          description: "Continues as soon as one path into lane a or b has finished.",
          inputs: {},
          outputs: {},
          configSchema: { type: "object", additionalProperties: false },
          behavior: CONTROL,
          control: { kind: "join", inputs: ["a", "b"], output: "out", mode: "any" },
        },
      });

      context.nodes.register({
        manifest: {
          type: LOOP_NODE_TYPE,
          version: "1",
          title: "Loop",
          description:
            "Runs the steps wired from its body port again, at most maxIterations times. The body returns through the repeat port; a false 'again' input, or passing maxWallTimeMs, ends the loop early.",
          inputs: { again: { schema: { type: "boolean" } } },
          outputs: {},
          configSchema: {
            type: "object",
            properties: {
              maxIterations: { type: "integer", minimum: 1, maximum: 1000 },
              maxWallTimeMs: { type: "integer", minimum: 1 },
            },
            required: ["maxIterations"],
            additionalProperties: false,
          },
          behavior: CONTROL,
          control: { kind: "loop", entry: "in", continue: "repeat", body: "body", exit: "done" },
        },
      });
    },
  };
}
