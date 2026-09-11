import type { AdapterUsage, ModelResult, ModelStreamEvent } from "@zet-harness/plugin-api";

/**
 * Transient observer for streamed model output.
 *
 * Deltas are handed to the host as they arrive and then dropped. Nothing in
 * this module retains the text of a delta, which is what keeps streaming from
 * turning the durable journal into a token log.
 */
export interface ModelStreamObserver {
  readonly onTextDelta?: (text: string) => void;
  readonly onToolCall?: (callId: string, name: string) => void;
  readonly onUsage?: (usage: AdapterUsage) => void;
}

export interface ModelStreamStatistics {
  readonly textDeltaCount: number;
  readonly textCharacterCount: number;
  readonly toolCallCount: number;
}

export interface ConsumedModelStream {
  /** The completed result: the durable output, as opposed to the deltas. */
  readonly result: ModelResult;
  /** Counts only. Deliberately no transcript. */
  readonly statistics: ModelStreamStatistics;
  readonly usage: AdapterUsage | undefined;
}

export class ModelStreamError extends Error {
  readonly code: "no-completion" | "duplicate-completion";

  constructor(code: "no-completion" | "duplicate-completion", message: string) {
    super(message);
    this.name = "ModelStreamError";
    this.code = code;
  }
}

/**
 * Consume a model stream into one durable result.
 *
 * The adapter contract already states that the completed result, not every
 * delta, is the durable output. This enforces that: deltas are forwarded to a
 * transient observer and counted, and only the final result and usage survive.
 *
 * An observer callback that throws must not corrupt the stream, so callback
 * failures are contained. A stream that never completes is an error rather than
 * a silently partial result.
 */
export async function consumeModelStream(
  events: AsyncIterable<ModelStreamEvent>,
  observer: ModelStreamObserver = {},
): Promise<ConsumedModelStream> {
  let textDeltaCount = 0;
  let textCharacterCount = 0;
  let toolCallCount = 0;
  let usage: AdapterUsage | undefined;
  let result: ModelResult | undefined;

  const safely = (run: () => void): void => {
    try {
      run();
    } catch {
      // A host display callback must not be able to fail an execution or
      // strand the transport mid-stream.
    }
  };

  for await (const event of events) {
    switch (event.type) {
      case "text-delta": {
        textDeltaCount += 1;
        textCharacterCount += event.text.length;
        const onTextDelta = observer.onTextDelta;
        if (onTextDelta !== undefined) {
          safely(() => {
            onTextDelta(event.text);
          });
        }
        break;
      }
      case "tool-call": {
        toolCallCount += 1;
        const onToolCall = observer.onToolCall;
        if (onToolCall !== undefined) {
          safely(() => {
            onToolCall(event.call.callId, event.call.name);
          });
        }
        break;
      }
      case "usage": {
        usage = event.usage;
        const onUsage = observer.onUsage;
        if (onUsage !== undefined) {
          safely(() => {
            onUsage(event.usage);
          });
        }
        break;
      }
      case "completed": {
        if (result !== undefined) {
          throw new ModelStreamError(
            "duplicate-completion",
            "A model stream published more than one completed result.",
          );
        }
        result = event.result;
        break;
      }
    }
  }

  if (result === undefined) {
    throw new ModelStreamError(
      "no-completion",
      "A model stream ended without publishing a completed result.",
    );
  }

  // The result's own usage is authoritative: a final accounting supersedes an
  // interim usage event, and never the other way around.
  const finalUsage = result.usage ?? usage;

  return Object.freeze({
    result,
    statistics: Object.freeze({ textDeltaCount, textCharacterCount, toolCallCount }),
    usage: finalUsage,
  });
}

export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens: number;
  /** Decimal string; monetary totals are never accumulated as binary floats. */
  readonly cost: string | null;
  readonly currency: string | null;
  /** Number of reports that contributed, for auditing partial provider data. */
  readonly reportCount: number;
  /** True when at least one report omitted monetary cost. */
  readonly costIncomplete: boolean;
}

const EMPTY_TOTALS: UsageTotals = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cost: null,
  currency: null,
  reportCount: 0,
  costIncomplete: false,
});

/** Add two decimal strings exactly, without going through a binary float. */
function addDecimalStrings(left: string, right: string): string {
  const parse = (
    value: string,
  ): { readonly negative: boolean; readonly digits: string; readonly scale: number } => {
    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    const [whole = "0", fraction = ""] = unsigned.split(".");
    return { negative, digits: `${whole}${fraction}`, scale: fraction.length };
  };

  const a = parse(left);
  const b = parse(right);
  const scale = Math.max(a.scale, b.scale);
  const scaleUp = (parsed: ReturnType<typeof parse>): bigint => {
    const padded = parsed.digits + "0".repeat(scale - parsed.scale);
    const magnitude = BigInt(padded === "" ? "0" : padded);
    return parsed.negative ? -magnitude : magnitude;
  };

  const sum = scaleUp(a) + scaleUp(b);
  if (scale === 0) return sum.toString();

  const negative = sum < 0n;
  const digits = (negative ? -sum : sum).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Accumulate provider usage reports.
 *
 * Missing values stay missing rather than becoming zero: a provider that does
 * not report cached tokens has not reported zero cached tokens. Monetary
 * amounts are summed as decimal strings, because accumulating currency in
 * binary floating point loses money at the cent.
 *
 * Mixing currencies is refused rather than silently converted; this code has no
 * exchange rate and must not invent one.
 */
export function accumulateUsage(reports: readonly (AdapterUsage | undefined)[]): UsageTotals {
  let totals = EMPTY_TOTALS;

  for (const report of reports) {
    if (report === undefined) continue;

    const cost = report.cost;
    if (cost !== undefined && totals.currency !== null && cost.currency !== totals.currency) {
      throw new TypeError("Cannot total usage costs reported in different currencies.");
    }

    totals = Object.freeze({
      inputTokens: totals.inputTokens + (report.inputTokens ?? 0),
      outputTokens: totals.outputTokens + (report.outputTokens ?? 0),
      totalTokens: totals.totalTokens + (report.totalTokens ?? 0),
      cachedInputTokens: totals.cachedInputTokens + (report.cachedInputTokens ?? 0),
      cost:
        cost === undefined
          ? totals.cost
          : addDecimalStrings(totals.cost ?? "0", cost.amountDecimal),
      currency: cost === undefined ? totals.currency : cost.currency,
      reportCount: totals.reportCount + 1,
      costIncomplete: totals.costIncomplete || cost === undefined,
    });
  }

  return totals;
}
