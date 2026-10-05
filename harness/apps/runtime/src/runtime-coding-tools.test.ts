import { mkdtemp, rm, writeFile, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AdapterInvocationContext } from "@zet-harness/plugin-api";
import { createRuntimeCodingTools } from "./runtime-coding-tools.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zet-native-coding-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function context(signal = new AbortController().signal): AdapterInvocationContext {
  return {
    runId: "r",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "e",
    signal,
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => 0,
    },
  };
}
it("offers only provider-neutral read tools with fs:read demand", () => {
  const tools = createRuntimeCodingTools({ root });
  expect(tools.map((tool) => tool.manifest.id)).toEqual(["harness.fs.read", "harness.fs.list"]);
  expect(
    tools.every((tool) => tool.manifest.behavior.requiredCapabilities?.join() === "fs:read"),
  ).toBe(true);
});
it("reads and lists bounded ordinary workspace files or fails closed off Linux", async () => {
  await writeFile(join(root, "hello.ts"), "hello");
  await writeFile(join(root, ".env"), "private");
  const [read, list] = createRuntimeCodingTools({ root });
  if (process.platform !== "linux") {
    await expect(read!.invoke({ path: "hello.ts" }, context())).rejects.toThrow("rejected");
    return;
  }
  expect((await read!.invoke({ path: "hello.ts" }, context())).value).toEqual({ content: "hello" });
  expect((await list!.invoke({}, context())).value).toEqual({
    entries: [{ name: "hello.ts", type: "file" }],
    truncated: false,
  });
  await expect(read!.invoke({ path: ".env" }, context())).rejects.toThrow("rejected");
});
it("refuses escapes, hardlinks, symlinks and oversized files", async () => {
  const [read] = createRuntimeCodingTools({ root });
  await writeFile(join(root, "source"), "hello");
  await link(join(root, "source"), join(root, "hard"));
  await writeFile(join(root, "large"), "x".repeat(65537));
  if (process.platform === "linux") await symlink(join(root, "large"), join(root, "alias"));
  for (const path of ["../outside", "hard", "large", "alias", "C:secret", "file:stream"]) {
    await expect(read!.invoke({ path }, context())).rejects.toThrow("rejected");
  }
});
it("does not return results after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const [read] = createRuntimeCodingTools({ root });
  await expect(read!.invoke({ path: "hello" }, context(controller.signal))).rejects.toThrow();
});
