import { mkdtemp, rm, writeFile, symlink, link, rename } from "node:fs/promises";
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
it(
  "reads and lists bounded ordinary workspace files or fails closed off Linux/Windows",
  async () => {
    await writeFile(join(root, "hello.ts"), "hello");
    await writeFile(join(root, ".env"), "private");
    const [read, list] = createRuntimeCodingTools({ root });
    if (process.platform !== "linux" && process.platform !== "win32") {
      await expect(read!.invoke({ path: "hello.ts" }, context())).rejects.toThrow("rejected");
      return;
    }
    expect((await read!.invoke({ path: "hello.ts" }, context())).value).toEqual({
      content: "hello",
    });
    expect((await list!.invoke({}, context())).value).toEqual({
      entries: [{ name: "hello.ts", type: "file" }],
      truncated: false,
    });
    await expect(read!.invoke({ path: ".env" }, context())).rejects.toThrow("rejected");
  },
  process.platform === "win32" ? 150_000 : 5000,
);
it(
  "refuses escapes, hardlinks, symlinks and oversized files",
  async () => {
    const [read] = createRuntimeCodingTools({ root });
    await writeFile(join(root, "source"), "hello");
    await link(join(root, "source"), join(root, "hard"));
    await writeFile(join(root, "large"), "x".repeat(65537));
    if (process.platform === "linux") await symlink(join(root, "large"), join(root, "alias"));
    for (const path of ["../outside", "hard", "large", "alias", "C:secret", "file:stream"]) {
      await expect(read!.invoke({ path }, context())).rejects.toThrow("rejected");
    }
  },
  process.platform === "win32" ? 150_000 : 5000,
);
it("does not return results after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const [read] = createRuntimeCodingTools({ root });
  await expect(read!.invoke({ path: "hello" }, context(controller.signal))).rejects.toThrow();
});

it.skipIf(process.platform !== "linux")(
  "excludes exact private DB sidecars and original inode aliases from read/list",
  async () => {
    const database = join(root, "chat.sqlite");
    await writeFile(database, "private chat content");
    await writeFile(`${database}-wal`, "private WAL");
    await writeFile(join(root, "public.ts"), "public");
    const [read, list] = createRuntimeCodingTools({
      root,
      privatePaths: [database, `${database}-wal`, `${database}-shm`],
    });
    await expect(read!.invoke({ path: "chat.sqlite" }, context())).rejects.toThrow("rejected");
    await expect(read!.invoke({ path: "chat.sqlite-wal" }, context())).rejects.toThrow("rejected");
    expect(JSON.stringify((await list!.invoke({}, context())).value)).not.toContain("chat.sqlite");
    await rename(database, join(root, "renamed.sqlite"));
    await expect(read!.invoke({ path: "renamed.sqlite" }, context())).rejects.toThrow("rejected");
    expect((await read!.invoke({ path: "public.ts" }, context())).value).toEqual({
      content: "public",
    });
  },
);

it.skipIf(process.platform !== "linux")(
  "private canonical paths survive configured workspace aliases and replacements",
  async () => {
    const database = join(root, "chat.sqlite");
    await writeFile(database, "original");
    const alias = `${root}-alias`;
    await symlink(root, alias, "dir");
    try {
      const paths = [database, `${database}-wal`, `${database}-shm`];
      const [read] = createRuntimeCodingTools({ root: alias, privatePaths: paths });
      paths.length = 0;
      await expect(read!.invoke({ path: "chat.sqlite" }, context())).rejects.toThrow("rejected");
      await rename(database, join(root, "renamed.sqlite"));
      await writeFile(database, "replacement");
      await expect(read!.invoke({ path: "renamed.sqlite" }, context())).rejects.toThrow("rejected");
      await expect(read!.invoke({ path: "chat.sqlite" }, context())).rejects.toThrow("rejected");
      await link(database, join(root, "hard.sqlite"));
      await expect(read!.invoke({ path: "hard.sqlite" }, context())).rejects.toThrow("rejected");
    } finally {
      await rm(alias, { force: true });
    }
  },
);
