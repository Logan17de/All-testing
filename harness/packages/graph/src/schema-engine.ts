import Ajv2020 from "ajv/dist/2020.js";

/**
 * Internal JSON Schema engine for graph-boundary shape/value validation.
 *
 * Ajv is deliberately contained in @zet-harness/graph. Public contracts expose
 * JSON Schema, not Ajv types, and scheduler/runtime semantics must not depend on
 * this implementation choice.
 */
export function createDraft202012SchemaEngine(): Ajv2020 {
  return new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });
}
