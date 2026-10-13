import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { AdapterInvocationContext } from "@zet-harness/plugin-api";
import { createRuntimeCodingTools } from "./runtime-coding-tools.js";

function context(signal = new AbortController().signal): AdapterInvocationContext {
  return {
    signal,
    logicalEffectId: "security-fixture",
    runId: "fixture",
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
  };
}

it("exposes only read tools and refuses credentials and lexical escape through adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "zet-coding-security-"));
  try {
    await writeFile(join(root, "safe.ts"), "export const value = 1;");
    await writeFile(join(root, ".env"), "fixture-secret");
    await mkdir(join(root, "nested/.claude"), { recursive: true });
    await writeFile(join(root, "nested/.claude/.credentials.json"), "fixture-secret");
    await writeFile(join(root, ".secrets.json"), "fixture-secret");
    const tools = createRuntimeCodingTools({ root });
    expect(tools.map((tool) => tool.manifest.id)).toEqual(["harness.fs.read", "harness.fs.list"]);
    expect(tools.every((tool) => tool.manifest.behavior.effect === "external-read")).toBe(true);
    const read = tools[0]!;
    await expect(read.invoke({ path: "../outside" }, context())).rejects.toThrow("rejected");
    await expect(read.invoke({ path: ".env" }, context())).rejects.toThrow("rejected");
    await expect(
      read.invoke({ path: "nested/.claude/.credentials.json" }, context()),
    ).rejects.toThrow("rejected");
    await expect(read.invoke({ path: ".secrets.json" }, context())).rejects.toThrow("rejected");
    if (process.platform === "linux" || process.platform === "win32") {
      expect(await read.invoke({ path: "safe.ts" }, context())).toEqual({
        value: { content: "export const value = 1;" },
      });
    } else {
      await expect(read.invoke({ path: "safe.ts" }, context())).rejects.toThrow("rejected");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 75_000);

it("rejects an already cancelled coding invocation without returning workspace data", async () => {
  const root = await mkdtemp(join(tmpdir(), "zet-coding-cancel-"));
  try {
    const controller = new AbortController();
    controller.abort(new Error("fixture cancelled"));
    const read = createRuntimeCodingTools({ root })[0]!;
    await expect(read.invoke({ path: "safe.ts" }, context(controller.signal))).rejects.toThrow(
      "fixture cancelled",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
