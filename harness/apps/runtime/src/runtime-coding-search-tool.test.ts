import { expect, it } from "vitest";
import type { AdapterInvocationContext } from "@zet-harness/plugin-api";
import { createRuntimeCodingSearchTool } from "./runtime-coding-search-tool.js";
const context = (): AdapterInvocationContext => ({
  signal: new AbortController().signal,
  runId: "fixture",
  logicalEffectId: "search",
  opIndex: 0,
  iteration: 0,
  attempt: 1,
  retryBudget: {
    maxAttempts: 1,
    repeatAuthorized: false,
    usedAttempts: 1,
    remainingAttempts: 0,
    reportInternalRetries: () => 0,
  },
});
it("passes only the query and returns findings/sources without an execution route", async () => {
  const calls: string[] = [];
  const tool = createRuntimeCodingSearchTool({
    search: (query) => {
      calls.push(query);
      return Promise.resolve({
        text: "A useful finding",
        citations: [{ url: "https://example.com/source", title: "Source" }],
      });
    },
  });
  expect(await tool.invoke({ query: "research topic" }, context())).toEqual({
    value: {
      findings: "A useful finding",
      sources: [{ url: "https://example.com/source", title: "Source" }],
    },
  });
  expect(calls).toEqual(["research topic"]);
  expect(tool.manifest.behavior.requiredCapabilities).toEqual(["network:codex-search"]);
  await expect(tool.invoke({ query: "topic", tools: ["shell"] }, context())).rejects.toThrow(
    "Invalid",
  );
  expect(calls).toHaveLength(1);
});
it("propagates denial and cancellation without retrying another executor", async () => {
  let calls = 0;
  const tool = createRuntimeCodingSearchTool({
    search: () => {
      calls++;
      return Promise.reject(new Error("provider denied"));
    },
  });
  await expect(tool.invoke({ query: "topic" }, context())).rejects.toThrow("provider denied");
  expect(calls).toBe(1);
  const ctx = context();
  const controller = new AbortController();
  controller.abort();
  await expect(
    tool.invoke({ query: "topic" }, { ...ctx, signal: controller.signal }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
