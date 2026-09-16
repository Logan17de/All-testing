import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { SqliteDatabase } from "@zet-harness/db";
import { readGoalActionEffect, recordGoalActionEffect } from "@zet-harness/db/durable-goal-records";
import { readProject } from "@zet-harness/db/durable-project-records";
import type {
  AdapterInvocationContext,
  JsonObject,
  JsonSchema,
  JsonValue,
  ModelToolSpecification,
  NodeBehavior,
  ToolAdapter,
  ToolResult,
} from "@zet-harness/plugin-api";

/**
 * The shared shape of the project actions a model may call.
 *
 * Goals, todos and memories are different subjects but one contract. A read answers
 * from the current records. A write runs in a single serialized commit and is
 * recorded against the invocation's logical effect id, the action and a hash of its
 * input, so a retried attempt returns the recorded result instead of acting twice.
 * Anything the model could correct — unknown fields, an id outside this project, a
 * refused change — comes back as `{ ok: false, error }` rather than failing the step,
 * and a refused write changes nothing.
 *
 * The at-most-once ledger is `goal_action_effects`, named when goals were the only
 * actions. Its rows are keyed by action id, so other subjects share it without a new
 * table; a shipped migration is never edited to rename it.
 */

export const READ_BEHAVIOR: NodeBehavior = {
  primitiveFamily: "effect",
  determinism: "nondeterministic",
  effect: "external-read",
  idempotency: "idempotent",
  recovery: "rerun",
  executionMode: "in-process",
  requiredCapabilities: [],
};

export const WRITE_BEHAVIOR: NodeBehavior = {
  primitiveFamily: "effect",
  determinism: "nondeterministic",
  effect: "external-write",
  // A retry reuses the invocation's logical effect id, and the recorded result is
  // returned instead of acting a second time, so rerunning is safe.
  idempotency: "idempotency-key",
  recovery: "rerun",
  executionMode: "in-process",
  requiredCapabilities: [],
};

export const SORTABLE_ID_SCHEMA = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
};

export const ACTION_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

export function objectSchema(
  properties: Record<string, JsonValue>,
  required: readonly string[],
): JsonSchema {
  return { type: "object", properties, required: [...required], additionalProperties: false };
}

/** Input the model should correct; returned to it as a refusal rather than thrown. */
export class ActionInputError extends Error {
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = "ActionInputError";
    this.code = code;
    this.field = field;
  }
}

export const invalidInput = (message: string, field?: string): ActionInputError =>
  new ActionInputError("ACTION_INPUT_INVALID", message, field);

export function only(input: JsonObject, allowed: readonly string[]): void {
  for (const field of Object.keys(input)) {
    if (!allowed.includes(field)) throw invalidInput(`Unknown field '${field}'.`, field);
  }
}

export function optionalString(input: JsonObject, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidInput(`${field} must be a string.`, field);
  return value;
}

export function requiredString(input: JsonObject, field: string): string {
  const value = optionalString(input, field);
  if (value === undefined) throw invalidInput(`${field} is required.`, field);
  return value;
}

export function optionalInteger(input: JsonObject, field: string): number | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidInput(`${field} must be an integer.`, field);
  }
  return value;
}

export function optionalBoolean(input: JsonObject, field: string): boolean | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalidInput(`${field} must be true or false.`, field);
  return value;
}

export function optionalStringList(
  input: JsonObject,
  field: string,
): readonly string[] | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw invalidInput(`${field} must be a list of ids.`, field);
  }
  return value.filter((item): item is string => typeof item === "string");
}

export function json(value: unknown): JsonValue {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);
}

/** Key-sorted JSON, so equal inputs always hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** What a refusal needs: a stable code, a reason the model can act on, and maybe a field. */
export interface RefusableError {
  readonly code: string;
  readonly message: string;
  readonly field?: string | undefined;
}

export function refusal(error: RefusableError): JsonObject {
  return {
    ok: false,
    error: {
      code: error.code,
      reason: error.message,
      ...(error.field === undefined ? {} : { field: error.field }),
    },
  };
}

/** Provider-safe function name for a tool id: letters, digits, underscores and hyphens. */
export function modelToolName(toolId: string): string {
  return toolId.replace(/[^A-Za-z0-9_-]/gu, "_");
}

/** What a model request needs to offer these actions to a model. */
export function actionToolSpecifications(
  tools: readonly ToolAdapter[],
): readonly ModelToolSpecification[] {
  return Object.freeze(
    tools.map((tool) =>
      Object.freeze({
        name: modelToolName(tool.manifest.id),
        ...(tool.manifest.description === undefined
          ? {}
          : { description: tool.manifest.description }),
        inputSchema: tool.manifest.inputSchema,
      }),
    ),
  );
}

export interface ActionRunnerOptions {
  readonly database: SqliteDatabase;
  /** Every action is confined to this project; ids from other projects are not found. */
  readonly projectId: string;
  /** UTC epoch milliseconds. */
  readonly now: () => number;
  /** Errors returned to the model as a refusal instead of failing the step. */
  readonly isRefusal: (error: unknown) => error is RefusableError;
  /** SQLite savepoint name for a write; a bare identifier, unique per action family. */
  readonly savepoint: string;
}

export interface ActionRunners {
  readonly read: (
    context: AdapterInvocationContext,
    perform: (connection: DatabaseSync) => JsonObject,
  ) => Promise<ToolResult>;
  readonly write: (
    action: string,
    input: JsonObject,
    context: AdapterInvocationContext,
    perform: (connection: DatabaseSync) => JsonObject,
  ) => Promise<ToolResult>;
}

export function createActionRunners(options: ActionRunnerOptions): ActionRunners {
  const { database, projectId, now, isRefusal, savepoint } = options;
  if (!/^[a-z_][a-z0-9_]*$/u.test(savepoint)) {
    throw new TypeError("An action savepoint name must be a bare SQLite identifier.");
  }

  const read: ActionRunners["read"] = (context, perform) =>
    Promise.resolve().then(() => {
      context.signal.throwIfAborted();
      try {
        return { value: { ok: true, ...perform(database.connection()) } };
      } catch (error) {
        if (isRefusal(error)) return { value: refusal(error) };
        throw error;
      }
    });

  const write: ActionRunners["write"] = async (action, input, context, perform) => {
    context.signal.throwIfAborted();
    const inputSha256 = createHash("sha256").update(canonicalJson(input)).digest("hex");
    const value = await database.commit((connection): JsonObject => {
      if (readProject(connection, projectId) === undefined) {
        return refusal(
          new ActionInputError(
            "PROJECT_NOT_FOUND",
            "The project these actions belong to does not exist.",
          ),
        );
      }
      const key = { logicalEffectId: context.logicalEffectId, action, inputSha256 };
      const recorded = readGoalActionEffect(connection, key);
      if (recorded !== undefined) return recorded.result as JsonObject;

      let result: JsonObject;
      connection.exec(`SAVEPOINT ${savepoint}`);
      try {
        result = { ok: true, ...perform(connection) };
        connection.exec(`RELEASE ${savepoint}`);
      } catch (error) {
        connection.exec(`ROLLBACK TO ${savepoint}`);
        connection.exec(`RELEASE ${savepoint}`);
        if (!isRefusal(error)) throw error;
        result = refusal(error);
      }
      recordGoalActionEffect(connection, { ...key, projectId, result, nowMs: now() });
      return result;
    });
    return { value };
  };

  return { read, write };
}

/** One model-visible action, described the way every other tool adapter is. */
export function actionTool(
  id: string,
  title: string,
  description: string,
  inputSchema: JsonSchema,
  behavior: NodeBehavior,
  invoke: (input: JsonObject, context: AdapterInvocationContext) => Promise<ToolResult>,
): ToolAdapter {
  return Object.freeze({
    manifest: Object.freeze({
      id,
      version: "1",
      title,
      description,
      inputSchema,
      outputSchema: ACTION_OUTPUT_SCHEMA,
      behavior,
    }),
    invoke,
  });
}
