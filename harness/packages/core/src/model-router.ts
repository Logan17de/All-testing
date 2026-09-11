import type { CapabilityId, ModelAdapterManifest, Version } from "@zet-harness/plugin-api";

import type { CapabilityPermissionPolicy } from "./capability-permission-policy.js";

/**
 * What a node needs from a model.
 *
 * Every flag is opt-in: an omitted requirement is not a requirement. A node
 * that does not ask for tools must not be denied a model that happens to
 * support them.
 */
export interface ModelRequirements {
  readonly tools?: boolean;
  readonly vision?: boolean;
  readonly structuredOutput?: boolean;
  readonly streaming?: boolean;
  readonly minContextWindowTokens?: number;
  /** Pin one exact model. A pin that cannot be honoured fails; it never falls back. */
  readonly modelId?: string;
  readonly modelVersion?: Version;
}

export type ModelRejectionReason =
  | "not-pinned-model"
  | "missing-tools"
  | "missing-vision"
  | "missing-structured-output"
  | "missing-streaming"
  | "context-window-too-small"
  | "unknown-context-window"
  | "capability-denied";

export interface ModelCandidateEvaluation {
  readonly id: string;
  readonly version: Version;
  readonly eligible: boolean;
  /** Every reason the candidate failed, in a stable order. */
  readonly rejections: readonly ModelRejectionReason[];
}

export type ModelRoutingOutcome = "selected" | "no-eligible-model" | "empty-catalog";

/**
 * A recorded routing decision.
 *
 * This is the object the run trace stores. It is deliberately JSON-safe and
 * self-contained: reading a trace later must explain why one model was chosen
 * without needing the catalog that existed at the time.
 */
export interface ModelRoutingDecision {
  readonly outcome: ModelRoutingOutcome;
  readonly selectedId: string | null;
  readonly selectedVersion: Version | null;
  readonly requirements: ModelRequirements;
  readonly candidates: readonly ModelCandidateEvaluation[];
  /** How the winner was picked among eligible candidates. */
  readonly selectionRule: "explicit-pin" | "preference-order" | "lexicographic" | "none";
}

export interface RouteModelOptions {
  readonly manifests: readonly ModelAdapterManifest[];
  readonly requirements?: ModelRequirements;
  /**
   * Host authority. A model whose demanded capabilities are not granted is not
   * eligible, so routing can never select something the broker would refuse.
   */
  readonly policy?: CapabilityPermissionPolicy;
  /**
   * Host preference, most preferred first, as `id` or `id@version`.
   *
   * Preference is the only tie-break a host controls. Anything not listed falls
   * back to lexicographic order, so the result is always reproducible.
   */
  readonly preferenceOrder?: readonly string[];
}

function compareManifests(left: ModelAdapterManifest, right: ModelAdapterManifest): number {
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  if (left.version === right.version) return 0;
  return left.version < right.version ? -1 : 1;
}

function preferenceRank(
  manifest: ModelAdapterManifest,
  preferenceOrder: readonly string[] | undefined,
): number {
  if (preferenceOrder === undefined) return Number.MAX_SAFE_INTEGER;
  const exact = preferenceOrder.indexOf(`${manifest.id}@${manifest.version}`);
  if (exact !== -1) return exact;
  const byId = preferenceOrder.indexOf(manifest.id);
  return byId === -1 ? Number.MAX_SAFE_INTEGER : byId;
}

function evaluate(
  manifest: ModelAdapterManifest,
  requirements: ModelRequirements,
  policy: CapabilityPermissionPolicy | undefined,
): ModelCandidateEvaluation {
  const rejections: ModelRejectionReason[] = [];
  const features = manifest.features;

  if (requirements.modelId !== undefined) {
    const idMatches = manifest.id === requirements.modelId;
    const versionMatches =
      requirements.modelVersion === undefined || manifest.version === requirements.modelVersion;
    if (!idMatches || !versionMatches) rejections.push("not-pinned-model");
  }

  if (requirements.tools === true && !features.tools) rejections.push("missing-tools");
  if (requirements.vision === true && !features.vision) rejections.push("missing-vision");
  if (requirements.structuredOutput === true && !features.structuredOutput) {
    rejections.push("missing-structured-output");
  }
  if (requirements.streaming === true && !features.streaming) rejections.push("missing-streaming");

  if (requirements.minContextWindowTokens !== undefined) {
    const declared = features.contextWindowTokens;
    if (declared === undefined) {
      // An undeclared window is not treated as unlimited. Guessing here would
      // route work to a model that silently truncates it.
      rejections.push("unknown-context-window");
    } else if (declared < requirements.minContextWindowTokens) {
      rejections.push("context-window-too-small");
    }
  }

  if (policy !== undefined) {
    const required: readonly CapabilityId[] = manifest.requiredCapabilities;
    if (!policy.evaluateAll(required).allowed) rejections.push("capability-denied");
  }

  return Object.freeze({
    id: manifest.id,
    version: manifest.version,
    eligible: rejections.length === 0,
    rejections: Object.freeze(rejections),
  });
}

/**
 * Select a model by declared capability, and record why.
 *
 * Selection is deterministic: the same catalog and the same requirements always
 * produce the same decision, because eligible candidates are ordered by host
 * preference and then lexicographically rather than by registration order. A
 * replayed trace must be able to reach the same model.
 *
 * This function chooses; it does not authorize. The invocation broker still
 * performs its own capability checks, and a policy passed here only narrows the
 * candidate set.
 */
export function routeModel(options: RouteModelOptions): ModelRoutingDecision {
  const requirements = Object.freeze({ ...(options.requirements ?? {}) });
  const manifests = [...options.manifests].sort(compareManifests);

  const candidates = Object.freeze(
    manifests.map((manifest) => evaluate(manifest, requirements, options.policy)),
  );

  if (manifests.length === 0) {
    return Object.freeze({
      outcome: "empty-catalog",
      selectedId: null,
      selectedVersion: null,
      requirements,
      candidates,
      selectionRule: "none",
    });
  }

  const eligible = manifests.filter((manifest) =>
    candidates.some(
      (candidate) =>
        candidate.id === manifest.id &&
        candidate.version === manifest.version &&
        candidate.eligible,
    ),
  );

  if (eligible.length === 0) {
    return Object.freeze({
      outcome: "no-eligible-model",
      selectedId: null,
      selectedVersion: null,
      requirements,
      candidates,
      selectionRule: "none",
    });
  }

  const ranked = [...eligible].sort((left, right) => {
    const leftRank = preferenceRank(left, options.preferenceOrder);
    const rightRank = preferenceRank(right, options.preferenceOrder);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return compareManifests(left, right);
  });

  const winner = ranked[0];
  if (winner === undefined) {
    return Object.freeze({
      outcome: "no-eligible-model",
      selectedId: null,
      selectedVersion: null,
      requirements,
      candidates,
      selectionRule: "none",
    });
  }

  const selectionRule: ModelRoutingDecision["selectionRule"] =
    requirements.modelId !== undefined
      ? "explicit-pin"
      : preferenceRank(winner, options.preferenceOrder) !== Number.MAX_SAFE_INTEGER
        ? "preference-order"
        : "lexicographic";

  return Object.freeze({
    outcome: "selected",
    selectedId: winner.id,
    selectedVersion: winner.version,
    requirements,
    candidates,
    selectionRule,
  });
}

/** Event type for the recorded routing decision in the durable journal. */
export const MODEL_ROUTING_DECISION_EVENT_TYPE = "harness.model.routing-decision" as const;
export const MODEL_ROUTING_DECISION_SCHEMA_VERSION = 1 as const;
