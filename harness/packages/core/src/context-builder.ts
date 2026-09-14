import type { ModelAdapterManifest, ModelMessage, ModelMessagePart } from "@zet-harness/plugin-api";

/** The conservative fallback counts one token for every three UTF-8 bytes, rounded up. */
export const FALLBACK_BYTES_PER_TOKEN = 3;
/** Framing cost counted for every message, whatever the provider. */
export const MESSAGE_TOKEN_OVERHEAD = 4;
/** Images are counted at a fixed, deliberately high cost; their bytes live outside the message. */
export const IMAGE_TOKEN_ESTIMATE = 1_000;

const encoder = new TextEncoder();

/**
 * A provider's tokenizer. Return undefined when it cannot count; the builder then
 * uses the conservative estimate for that text and says so in its report.
 */
export type TokenCounter = (text: string) => number | undefined;

/** Hard limits on what one model request may carry. */
export interface ContextBudget {
  readonly maxTokens: number;
  /** A byte cap that holds even when token counting is wrong or unavailable. */
  readonly maxBytes?: number;
}

/**
 * One block of context, emitted in the order sections are given.
 *
 * Required sections (the system policy, the active goal) are never cut: the build
 * fails instead. Optional sections lose their oldest messages first.
 */
export interface ContextSectionInput {
  readonly id: string;
  readonly messages: readonly ModelMessage[];
  readonly required?: boolean;
  /** Hard byte cap for this section alone. */
  readonly maxBytes?: number;
}

export interface BuildContextInput {
  readonly sections: readonly ContextSectionInput[];
  readonly budget: ContextBudget;
  readonly countTokens?: TokenCounter;
}

export interface ContextSectionReport {
  readonly id: string;
  readonly required: boolean;
  readonly keptMessages: number;
  readonly droppedMessages: number;
  readonly tokens: number;
  readonly bytes: number;
}

/** The messages to send and a JSON-safe account of how they were chosen. */
export interface BuiltContext {
  readonly messages: readonly ModelMessage[];
  readonly totalTokens: number;
  readonly totalBytes: number;
  readonly budget: ContextBudget;
  readonly sections: readonly ContextSectionReport[];
  /** True when any text was counted with the fallback estimate instead of the provider. */
  readonly usedFallbackCounting: boolean;
}

export type ContextBudgetErrorCode =
  | "CONTEXT_INVALID"
  | "CONTEXT_WINDOW_UNKNOWN"
  | "CONTEXT_SECTION_OVER_CAP"
  | "CONTEXT_REQUIRED_OVER_BUDGET";

export class ContextBudgetError extends Error {
  readonly code: ContextBudgetErrorCode;
  readonly sectionId: string | undefined;

  constructor(code: ContextBudgetErrorCode, message: string, sectionId?: string) {
    super(message);
    this.name = "ContextBudgetError";
    this.code = code;
    this.sectionId = sectionId;
  }
}

/** Conservative token estimate for text no provider tokenizer has counted. */
export function estimateTokens(text: string): number {
  return Math.ceil(encoder.encode(text).length / FALLBACK_BYTES_PER_TOKEN);
}

function partText(part: ModelMessagePart): string {
  switch (part.kind) {
    case "text":
      return part.text;
    case "image":
      return part.artifactRef;
    case "tool-call":
      return `${part.name}${JSON.stringify(part.arguments)}`;
    case "tool-result":
      return JSON.stringify(part.value);
  }
}

interface Measured {
  readonly message: ModelMessage;
  readonly tokens: number;
  readonly bytes: number;
  readonly fallback: boolean;
}

function count(text: string, countTokens: TokenCounter | undefined): number | undefined {
  if (countTokens === undefined) return undefined;
  try {
    const counted = countTokens(text);
    return counted !== undefined && Number.isSafeInteger(counted) && counted >= 0
      ? counted
      : undefined;
  } catch {
    return undefined;
  }
}

function measure(message: ModelMessage, countTokens: TokenCounter | undefined): Measured {
  let tokens = MESSAGE_TOKEN_OVERHEAD;
  let fallback = false;
  for (const part of message.parts) {
    if (part.kind === "image") {
      tokens += IMAGE_TOKEN_ESTIMATE;
      continue;
    }
    const text = partText(part);
    const counted = count(text, countTokens);
    if (counted === undefined) {
      tokens += estimateTokens(text);
      fallback = true;
    } else {
      tokens += counted;
    }
  }
  return { message, tokens, bytes: encoder.encode(JSON.stringify(message)).length, fallback };
}

function requirePositive(value: number | undefined, what: string, sectionId?: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new ContextBudgetError(
      "CONTEXT_INVALID",
      `${what} must be a positive integer.`,
      sectionId,
    );
  }
}

interface SectionState {
  readonly id: string;
  readonly required: boolean;
  readonly maxBytes: number | undefined;
  readonly kept: Measured[];
  dropped: number;
}

function total(items: readonly Measured[], key: "tokens" | "bytes"): number {
  return items.reduce((sum, item) => sum + item[key], 0);
}

/** Drop a section's oldest message, and any tool results left without their call. */
function dropOldest(section: SectionState): void {
  section.kept.shift();
  section.dropped += 1;
  while (section.kept[0]?.message.role === "tool") {
    section.kept.shift();
    section.dropped += 1;
  }
}

/**
 * Assemble model context inside hard token and byte budgets.
 *
 * The build is pure and deterministic. Section byte caps apply first, then the total
 * budget: while the context is over either limit, the earliest optional section that
 * still has messages loses its oldest one. Required sections are never cut; if they
 * alone do not fit, the build fails rather than sending a model a policy or goal it
 * cannot see in full.
 */
export function buildModelContext(input: BuildContextInput): BuiltContext {
  const budget = input.budget;
  if (!Number.isSafeInteger(budget.maxTokens) || budget.maxTokens < 1) {
    throw new ContextBudgetError("CONTEXT_INVALID", "budget.maxTokens must be a positive integer.");
  }
  requirePositive(budget.maxBytes, "budget.maxBytes");

  const ids = new Set<string>();
  const sections: SectionState[] = input.sections.map((section) => {
    if (section.id.length === 0 || ids.has(section.id)) {
      throw new ContextBudgetError(
        "CONTEXT_INVALID",
        "Context sections need unique, non-empty ids.",
        section.id,
      );
    }
    ids.add(section.id);
    requirePositive(section.maxBytes, `Section '${section.id}' maxBytes`, section.id);
    return {
      id: section.id,
      required: section.required === true,
      maxBytes: section.maxBytes,
      kept: section.messages.map((message) => measure(message, input.countTokens)),
      dropped: 0,
    };
  });
  const usedFallbackCounting = sections.some((section) =>
    section.kept.some((item) => item.fallback),
  );

  for (const section of sections) {
    if (section.maxBytes === undefined) continue;
    while (total(section.kept, "bytes") > section.maxBytes) {
      if (section.required) {
        throw new ContextBudgetError(
          "CONTEXT_SECTION_OVER_CAP",
          `Required section '${section.id}' is larger than its ${String(section.maxBytes)}-byte cap.`,
          section.id,
        );
      }
      dropOldest(section);
    }
  }

  const totalTokens = (): number =>
    sections.reduce((sum, section) => sum + total(section.kept, "tokens"), 0);
  const totalBytes = (): number =>
    sections.reduce((sum, section) => sum + total(section.kept, "bytes"), 0);
  const overBudget = (): boolean =>
    totalTokens() > budget.maxTokens ||
    (budget.maxBytes !== undefined && totalBytes() > budget.maxBytes);

  while (overBudget()) {
    const victim = sections.find((section) => !section.required && section.kept.length > 0);
    if (victim === undefined) {
      const bytes = budget.maxBytes === undefined ? "" : ` and ${String(budget.maxBytes)} bytes`;
      throw new ContextBudgetError(
        "CONTEXT_REQUIRED_OVER_BUDGET",
        `The required context needs ${String(totalTokens())} tokens and ${String(totalBytes())} bytes, over the budget of ${String(budget.maxTokens)} tokens${bytes}.`,
      );
    }
    dropOldest(victim);
  }

  return Object.freeze({
    messages: Object.freeze(
      sections.flatMap((section) => section.kept.map((item) => item.message)),
    ),
    totalTokens: totalTokens(),
    totalBytes: totalBytes(),
    budget: Object.freeze({ ...budget }),
    sections: Object.freeze(
      sections.map((section) =>
        Object.freeze({
          id: section.id,
          required: section.required,
          keptMessages: section.kept.length,
          droppedMessages: section.dropped,
          tokens: total(section.kept, "tokens"),
          bytes: total(section.kept, "bytes"),
        }),
      ),
    ),
    usedFallbackCounting,
  });
}

export interface ModelContextBudgetOptions {
  /** Tokens kept free for the model's reply. */
  readonly reserveOutputTokens: number;
  readonly maxBytes?: number;
}

/**
 * Derive a budget from a model's declared context window.
 *
 * An undeclared window is not treated as unlimited, for the same reason routing
 * refuses it: guessing would send work to a model that silently truncates it.
 */
export function contextBudgetForModel(
  manifest: ModelAdapterManifest,
  options: ModelContextBudgetOptions,
): ContextBudget {
  const contextWindow = manifest.features.contextWindowTokens;
  if (contextWindow === undefined) {
    throw new ContextBudgetError(
      "CONTEXT_WINDOW_UNKNOWN",
      `Model '${manifest.id}' does not declare a context window, so no safe budget can be derived.`,
    );
  }
  requirePositive(options.reserveOutputTokens, "reserveOutputTokens");
  requirePositive(options.maxBytes, "maxBytes");
  const maxTokens = contextWindow - options.reserveOutputTokens;
  if (maxTokens < 1) {
    throw new ContextBudgetError(
      "CONTEXT_INVALID",
      `Reserving ${String(options.reserveOutputTokens)} output tokens leaves no room in the ${String(contextWindow)}-token window of model '${manifest.id}'.`,
    );
  }
  return Object.freeze({
    maxTokens,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
}
