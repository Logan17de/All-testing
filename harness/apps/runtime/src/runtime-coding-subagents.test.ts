import { describe, expect, it, vi } from "vitest";
import type {
  AdapterInvocationContext,
  ModelRequest,
  ModelResult,
  ToolAdapter,
} from "@zet-harness/plugin-api";
import { createRuntimeCodingSubagentTool } from "./runtime-coding-subagents.js";
const context = (signal = new AbortController().signal): AdapterInvocationContext => ({
  signal,
  runId: "test-run",
  logicalEffectId: "effect",
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
const answer = (): ModelResult => ({
  message: { role: "assistant", parts: [{ kind: "text", text: "report" }] },
  finishReason: "stop",
});
const readTool = (): ToolAdapter => ({
  manifest: {
    id: "harness.fs.read",
    version: "1",
    title: "Read",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    behavior: {
      primitiveFamily: "effect",
      determinism: "nondeterministic",
      effect: "external-read",
      idempotency: "idempotent",
      recovery: "rerun",
      executionMode: "in-process",
      requiredCapabilities: ["fs:read"],
    },
  },
  invoke: vi.fn(() => Promise.resolve({ value: { content: "fixture" } })),
});
describe("bounded separate-context child agent", () => {
  it("passes isolated task and fixed read tools, performs a bounded read then reports", async () => {
    const read = readTool();
    const generate = vi
      .fn<(request: ModelRequest, context: AdapterInvocationContext) => Promise<ModelResult>>()
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          parts: [
            {
              kind: "tool-call",
              callId: "read",
              name: "harness_fs_read",
              arguments: { path: "test.ts" },
            },
          ],
        },
        finishReason: "tool-calls",
      })
      .mockResolvedValueOnce(answer());
    const tool = createRuntimeCodingSubagentTool({ generate, readTools: [read] });
    expect(await tool.invoke({ task: "Review test.ts" }, context())).toEqual({
      value: { summary: "report", modelSteps: 2, toolCalls: 1, limited: false },
    });
    expect(generate.mock.calls[0]?.[0].messages).toHaveLength(2);
    expect(generate.mock.calls[0]?.[0].tools?.map((t: { name: string }) => t.name)).toEqual([
      "harness_fs_read",
    ]);
    expect(read.invoke).toHaveBeenCalledTimes(1);
  });
  it("rejects recursive or unauthorized tool calls and enforces four-child run budget", async () => {
    const generate = vi.fn<
      (request: ModelRequest, context: AdapterInvocationContext) => Promise<ModelResult>
    >(() => Promise.resolve(answer()));
    const tool = createRuntimeCodingSubagentTool({ generate, readTools: [] });
    for (let n = 0; n < 4; n++) await tool.invoke({ task: "Review" }, context());
    await expect(tool.invoke({ task: "Review" }, context())).rejects.toThrow("budget exhausted");
    expect(generate).toHaveBeenCalledTimes(4);
    const recursive = createRuntimeCodingSubagentTool({
      readTools: [],
      generate: () =>
        Promise.resolve({
          message: {
            role: "assistant",
            parts: [
              {
                kind: "tool-call",
                callId: "nested",
                name: "harness_agent_delegate",
                arguments: {},
              },
            ],
          },
          finishReason: "tool-calls",
        }),
    });
    await expect(recursive.invoke({ task: "Review" }, context())).rejects.toThrow("unavailable");
  });
  it("rejects promptly when parent aborts even if provider ignores cancellation", async () => {
    const controller = new AbortController();
    const generate = vi.fn(() => new Promise<ModelResult>(() => undefined));
    const tool = createRuntimeCodingSubagentTool({ generate, readTools: [] });
    const work = tool.invoke({ task: "Review" }, context(controller.signal));
    const assertion = expect(work).rejects.toThrow("user cancelled");
    controller.abort(new Error("user cancelled"));
    await assertion;
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("refuses mutation adapters and oversized task/output", async () => {
    const write = readTool();
    const mutated = { ...write, manifest: { ...write.manifest, id: "harness.fs.write" } };
    const generate = vi.fn<
      (request: ModelRequest, context: AdapterInvocationContext) => Promise<ModelResult>
    >(() => Promise.resolve(answer()));
    const tool = createRuntimeCodingSubagentTool({ generate, readTools: [mutated] });
    await expect(tool.invoke({ task: "x".repeat(8001) }, context())).rejects.toThrow("Invalid");
    await tool.invoke({ task: "Review" }, context());
    expect(generate.mock.calls[0]?.[0].tools).toEqual([]);
    const huge = createRuntimeCodingSubagentTool({
      readTools: [],
      generate: () =>
        Promise.resolve({
          message: { role: "assistant", parts: [{ kind: "text", text: "x".repeat(17000) }] },
          finishReason: "stop",
        }),
    });
    await expect(huge.invoke({ task: "Review" }, context())).rejects.toThrow("output exceeds");
  });
  it("enforces the child deadline locally without a cooperative provider", async () => {
    vi.useFakeTimers();
    try {
      const tool = createRuntimeCodingSubagentTool({
        readTools: [],
        generate: () => new Promise<ModelResult>(() => undefined),
      });
      const work = tool.invoke({ task: "Review" }, context());
      const assertion = expect(work).rejects.toThrow("deadline exceeded");
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
