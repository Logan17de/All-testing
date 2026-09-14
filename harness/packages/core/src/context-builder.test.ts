import { describe, expect, it } from "vitest";

import type { ModelAdapterManifest, ModelMessage } from "@zet-harness/plugin-api";

import {
  ContextBudgetError,
  FALLBACK_BYTES_PER_TOKEN,
  IMAGE_TOKEN_ESTIMATE,
  MESSAGE_TOKEN_OVERHEAD,
  buildModelContext,
  contextBudgetForModel,
  estimateTokens,
  type BuildContextInput,
  type TokenCounter,
} from "./context-builder.js";

const text = (role: ModelMessage["role"], value: string): ModelMessage => ({
  role,
  parts: [{ kind: "text", text: value }],
});

const system = text("system", "You are careful.");
const goal = text("developer", "Goal: ship the landing page.");

/** Messages of equal size, alternating user and assistant. */
function history(count: number): ModelMessage[] {
  return Array.from({ length: count }, (_, index) =>
    text(index % 2 === 0 ? "user" : "assistant", `message ${String(index)} ${"x".repeat(26)}`),
  );
}

const bytesOf = (message: ModelMessage | undefined): number =>
  new TextEncoder().encode(JSON.stringify(message)).length;

/** Every text counts as ten tokens, so every one-part message costs fourteen. */
const tenTokens: TokenCounter = () => 10;
const PER_MESSAGE = 10 + MESSAGE_TOKEN_OVERHEAD;

function failure(action: () => unknown): ContextBudgetError {
  try {
    action();
  } catch (error) {
    if (error instanceof ContextBudgetError) return error;
    throw error;
  }
  throw new Error("Expected the context build to be refused.");
}

describe("context builder", () => {
  it("keeps every section, in order, when the context fits", () => {
    const conversation = history(3);
    const built = buildModelContext({
      sections: [
        { id: "system", required: true, messages: [system] },
        { id: "goal", required: true, messages: [goal] },
        { id: "conversation", messages: conversation },
      ],
      budget: { maxTokens: 1_000 },
      countTokens: tenTokens,
    });

    expect(built.messages).toEqual([system, goal, ...conversation]);
    expect(built.totalTokens).toBe(5 * PER_MESSAGE);
    expect(built.usedFallbackCounting).toBe(false);
    expect(
      built.sections.map((section) => [section.id, section.keptMessages, section.droppedMessages]),
    ).toEqual([
      ["system", 1, 0],
      ["goal", 1, 0],
      ["conversation", 3, 0],
    ]);
    expect(built.totalBytes).toBe(built.sections.reduce((sum, section) => sum + section.bytes, 0));
  });

  it("drops the oldest conversation first, never the system policy or the goal, and always the same way", () => {
    const conversation = history(6);
    const input: BuildContextInput = {
      sections: [
        { id: "system", required: true, messages: [system] },
        { id: "goal", required: true, messages: [goal] },
        { id: "conversation", messages: conversation },
      ],
      budget: { maxTokens: 4 * PER_MESSAGE },
      countTokens: tenTokens,
    };

    const built = buildModelContext(input);
    expect(built.messages).toEqual([system, goal, conversation[4], conversation[5]]);
    expect(built.sections[2]).toMatchObject({ keptMessages: 2, droppedMessages: 4 });
    expect(built.totalTokens).toBe(4 * PER_MESSAGE);
    expect(buildModelContext(input)).toEqual(built);
  });

  it("falls back to a conservative estimate whenever the provider cannot count", () => {
    expect(estimateTokens("x".repeat(FALLBACK_BYTES_PER_TOKEN * 5))).toBe(5);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("éé")).toBe(2);

    const message = text("user", "abcdef");
    const counters: readonly (TokenCounter | undefined)[] = [
      undefined,
      () => undefined,
      () => -1,
      () => 1.5,
      () => {
        throw new Error("tokenizer offline");
      },
    ];
    for (const countTokens of counters) {
      const built = buildModelContext({
        sections: [{ id: "conversation", messages: [message] }],
        budget: { maxTokens: 100 },
        ...(countTokens === undefined ? {} : { countTokens }),
      });
      expect(built.totalTokens).toBe(2 + MESSAGE_TOKEN_OVERHEAD);
      expect(built.usedFallbackCounting).toBe(true);
    }

    const image: ModelMessage = {
      role: "user",
      parts: [{ kind: "image", artifactRef: "blob:1", mediaType: "image/png" }],
    };
    expect(
      buildModelContext({
        sections: [{ id: "conversation", messages: [image] }],
        budget: { maxTokens: 5_000 },
        countTokens: () => 1,
      }).totalTokens,
    ).toBe(IMAGE_TOKEN_ESTIMATE + MESSAGE_TOKEN_OVERHEAD);
  });

  it("enforces section and total byte caps even when the token count says everything fits", () => {
    const conversation = history(5);

    const capped = buildModelContext({
      sections: [
        { id: "system", required: true, messages: [system] },
        {
          id: "conversation",
          maxBytes: bytesOf(conversation[3]) + bytesOf(conversation[4]),
          messages: conversation,
        },
      ],
      budget: { maxTokens: 1_000_000 },
      countTokens: () => 1,
    });
    expect(capped.sections[1]).toMatchObject({ keptMessages: 2, droppedMessages: 3 });

    const limit =
      bytesOf(system) +
      bytesOf(conversation[2]) +
      bytesOf(conversation[3]) +
      bytesOf(conversation[4]);
    const totalCapped = buildModelContext({
      sections: [
        { id: "system", required: true, messages: [system] },
        { id: "conversation", messages: conversation },
      ],
      budget: { maxTokens: 1_000_000, maxBytes: limit },
      countTokens: () => 1,
    });
    expect(totalCapped.messages).toEqual([system, ...conversation.slice(2)]);
    expect(totalCapped.totalBytes).toBeLessThanOrEqual(limit);
  });

  it("never leaves a tool result without the call that asked for it", () => {
    const call: ModelMessage = {
      role: "assistant",
      parts: [{ kind: "tool-call", callId: "c1", name: "fs.read", arguments: { path: "a" } }],
    };
    const result: ModelMessage = {
      role: "tool",
      parts: [{ kind: "tool-result", callId: "c1", value: "contents" }],
    };
    const question = text("user", "q");
    const answer = text("assistant", "a");

    const built = buildModelContext({
      sections: [{ id: "conversation", messages: [call, result, question, answer] }],
      budget: { maxTokens: 2 * PER_MESSAGE },
      countTokens: tenTokens,
    });

    expect(built.messages).toEqual([question, answer]);
    expect(built.sections[0]).toMatchObject({ droppedMessages: 2 });
  });

  it("refuses to cut required context and rejects malformed budgets and sections", () => {
    expect(
      failure(() =>
        buildModelContext({
          sections: [
            { id: "system", required: true, messages: [system] },
            { id: "conversation", messages: history(3) },
          ],
          budget: { maxTokens: 10 },
          countTokens: tenTokens,
        }),
      ),
    ).toMatchObject({ code: "CONTEXT_REQUIRED_OVER_BUDGET" });
    expect(
      failure(() =>
        buildModelContext({
          sections: [{ id: "goal", required: true, maxBytes: 5, messages: [goal] }],
          budget: { maxTokens: 1_000 },
        }),
      ),
    ).toMatchObject({ code: "CONTEXT_SECTION_OVER_CAP", sectionId: "goal" });
    expect(
      failure(() =>
        buildModelContext({
          sections: [
            { id: "a", messages: [] },
            { id: "a", messages: [] },
          ],
          budget: { maxTokens: 1 },
        }),
      ),
    ).toMatchObject({ code: "CONTEXT_INVALID" });
    expect(
      failure(() => buildModelContext({ sections: [], budget: { maxTokens: 0 } })),
    ).toMatchObject({
      code: "CONTEXT_INVALID",
    });
    expect(
      failure(() => buildModelContext({ sections: [], budget: { maxTokens: 10, maxBytes: -1 } })),
    ).toMatchObject({ code: "CONTEXT_INVALID" });
  });

  it("derives a budget from a model's declared context window", () => {
    const manifest = (contextWindowTokens?: number): ModelAdapterManifest => ({
      id: "model",
      version: "1.0.0",
      title: "Model",
      requiredCapabilities: [],
      features: {
        streaming: false,
        tools: false,
        vision: false,
        structuredOutput: false,
        ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      },
    });

    expect(contextBudgetForModel(manifest(8_000), { reserveOutputTokens: 1_000 })).toEqual({
      maxTokens: 7_000,
    });
    expect(
      contextBudgetForModel(manifest(8_000), { reserveOutputTokens: 1_000, maxBytes: 200_000 }),
    ).toEqual({ maxTokens: 7_000, maxBytes: 200_000 });
    expect(
      failure(() => contextBudgetForModel(manifest(), { reserveOutputTokens: 1 })),
    ).toMatchObject({ code: "CONTEXT_WINDOW_UNKNOWN" });
    expect(
      failure(() => contextBudgetForModel(manifest(1_000), { reserveOutputTokens: 1_000 })),
    ).toMatchObject({ code: "CONTEXT_INVALID" });
  });
});
