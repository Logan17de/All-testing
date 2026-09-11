import type { AdapterUsage, ModelResult, ModelStreamEvent } from "@zet-harness/plugin-api";
import { describe, expect, it } from "vitest";

import { ModelStreamError, accumulateUsage, consumeModelStream } from "./model-stream-sink.js";

const RESULT: ModelResult = Object.freeze({
  message: Object.freeze({
    role: "assistant" as const,
    parts: Object.freeze([{ kind: "text" as const, text: "final answer" }]),
  }),
  finishReason: "stop" as const,
});

async function* stream(...events: ModelStreamEvent[]): AsyncIterable<ModelStreamEvent> {
  // Yield across a microtask so the consumer is exercised asynchronously,
  // the way a real transport delivers events.
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

describe("consuming a stream", () => {
  it("returns the completed result", async () => {
    const consumed = await consumeModelStream(stream({ type: "completed", result: RESULT }));
    expect(consumed.result).toEqual(RESULT);
  });

  it("forwards text deltas to the observer", async () => {
    const seen: string[] = [];
    await consumeModelStream(
      stream(
        { type: "text-delta", text: "hel" },
        { type: "text-delta", text: "lo" },
        { type: "completed", result: RESULT },
      ),
      { onTextDelta: (text) => seen.push(text) },
    );
    expect(seen).toEqual(["hel", "lo"]);
  });

  it("keeps counts but not the streamed text", async () => {
    const consumed = await consumeModelStream(
      stream(
        { type: "text-delta", text: "hel" },
        { type: "text-delta", text: "lo" },
        { type: "completed", result: RESULT },
      ),
    );
    expect(consumed.statistics.textDeltaCount).toBe(2);
    expect(consumed.statistics.textCharacterCount).toBe(5);
    // The durable surface must not contain a transcript of the deltas.
    expect(JSON.stringify(consumed.statistics)).not.toContain("hel");
  });

  it("counts tool calls and reports their identity to the observer", async () => {
    const seen: string[] = [];
    const consumed = await consumeModelStream(
      stream(
        {
          type: "tool-call",
          call: { kind: "tool-call", callId: "c1", name: "fs.read", arguments: {} },
        },
        { type: "completed", result: RESULT },
      ),
      { onToolCall: (callId, name) => seen.push(`${callId}:${name}`) },
    );
    expect(consumed.statistics.toolCallCount).toBe(1);
    expect(seen).toEqual(["c1:fs.read"]);
  });

  it("reports interim usage to the observer", async () => {
    const seen: AdapterUsage[] = [];
    await consumeModelStream(
      stream({ type: "usage", usage: { inputTokens: 10 } }, { type: "completed", result: RESULT }),
      { onUsage: (usage) => seen.push(usage) },
    );
    expect(seen).toEqual([{ inputTokens: 10 }]);
  });

  it("prefers the result's own usage over an interim report", async () => {
    const consumed = await consumeModelStream(
      stream(
        { type: "usage", usage: { inputTokens: 10 } },
        {
          type: "completed",
          result: { ...RESULT, usage: { inputTokens: 12, outputTokens: 3 } },
        },
      ),
    );
    expect(consumed.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
  });

  it("falls back to the interim usage when the result carries none", async () => {
    const consumed = await consumeModelStream(
      stream({ type: "usage", usage: { inputTokens: 7 } }, { type: "completed", result: RESULT }),
    );
    expect(consumed.usage).toEqual({ inputTokens: 7 });
  });

  it("leaves usage absent when nothing reported any", async () => {
    const consumed = await consumeModelStream(stream({ type: "completed", result: RESULT }));
    expect(consumed.usage).toBeUndefined();
  });
});

describe("stream integrity", () => {
  it("refuses a stream that never completes", async () => {
    await expect(
      consumeModelStream(stream({ type: "text-delta", text: "partial" })),
    ).rejects.toBeInstanceOf(ModelStreamError);
  });

  it("refuses a second completed result", async () => {
    await expect(
      consumeModelStream(
        stream({ type: "completed", result: RESULT }, { type: "completed", result: RESULT }),
      ),
    ).rejects.toBeInstanceOf(ModelStreamError);
  });

  it("reports a closed error code", async () => {
    const error = await consumeModelStream(stream()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelStreamError);
    expect((error as ModelStreamError).code).toBe("no-completion");
  });

  it("survives an observer callback that throws", async () => {
    const consumed = await consumeModelStream(
      stream({ type: "text-delta", text: "x" }, { type: "completed", result: RESULT }),
      {
        onTextDelta: () => {
          throw new Error("display failed");
        },
      },
    );
    expect(consumed.result).toEqual(RESULT);
    expect(consumed.statistics.textDeltaCount).toBe(1);
  });
});

describe("usage accumulation", () => {
  it("returns zeroes for no reports", () => {
    const totals = accumulateUsage([]);
    expect(totals.reportCount).toBe(0);
    expect(totals.totalTokens).toBe(0);
    expect(totals.cost).toBeNull();
  });

  it("skips absent reports", () => {
    const totals = accumulateUsage([undefined, { inputTokens: 5 }, undefined]);
    expect(totals.reportCount).toBe(1);
    expect(totals.inputTokens).toBe(5);
  });

  it("sums token counts across reports", () => {
    const totals = accumulateUsage([
      { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    ]);
    expect(totals.inputTokens).toBe(15);
    expect(totals.outputTokens).toBe(3);
    expect(totals.totalTokens).toBe(18);
  });

  it("treats a missing field as missing, contributing nothing", () => {
    const totals = accumulateUsage([{ inputTokens: 10 }, { outputTokens: 4 }]);
    expect(totals.inputTokens).toBe(10);
    expect(totals.outputTokens).toBe(4);
    expect(totals.cachedInputTokens).toBe(0);
  });

  it("sums costs exactly as decimals", () => {
    const totals = accumulateUsage([
      { cost: { amountDecimal: "0.10", currency: "USD" } },
      { cost: { amountDecimal: "0.20", currency: "USD" } },
    ]);
    // 0.1 + 0.2 in binary floating point is 0.30000000000000004.
    expect(totals.cost).toBe("0.30");
    expect(totals.currency).toBe("USD");
  });

  it("keeps precision across many small amounts", () => {
    const totals = accumulateUsage(
      Array.from({ length: 10 }, () => ({ cost: { amountDecimal: "0.01", currency: "USD" } })),
    );
    expect(totals.cost).toBe("0.10");
  });

  it("handles differing decimal scales", () => {
    const totals = accumulateUsage([
      { cost: { amountDecimal: "1", currency: "USD" } },
      { cost: { amountDecimal: "0.005", currency: "USD" } },
    ]);
    expect(totals.cost).toBe("1.005");
  });

  it("refuses to total mixed currencies rather than inventing a rate", () => {
    expect(() =>
      accumulateUsage([
        { cost: { amountDecimal: "1.00", currency: "USD" } },
        { cost: { amountDecimal: "1.00", currency: "EUR" } },
      ]),
    ).toThrow(TypeError);
  });

  it("flags an incomplete cost total when a report omits cost", () => {
    const totals = accumulateUsage([
      { cost: { amountDecimal: "0.50", currency: "USD" } },
      { inputTokens: 3 },
    ]);
    expect(totals.costIncomplete).toBe(true);
    expect(totals.cost).toBe("0.50");
  });

  it("does not flag an incomplete total when every report carries cost", () => {
    const totals = accumulateUsage([
      { cost: { amountDecimal: "0.50", currency: "USD" } },
      { cost: { amountDecimal: "0.25", currency: "USD" } },
    ]);
    expect(totals.costIncomplete).toBe(false);
    expect(totals.cost).toBe("0.75");
  });

  it("never invents a cost when none was reported", () => {
    const totals = accumulateUsage([{ inputTokens: 100, outputTokens: 100 }]);
    expect(totals.cost).toBeNull();
    expect(totals.currency).toBeNull();
  });
});
