import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AdapterInvocationContext, JsonObject } from "@zet-harness/plugin-api";
import { createRuntimeCodingFileTools } from "./runtime-coding-file-tools.js";
const context = (signal = new AbortController().signal): AdapterInvocationContext => ({
  signal,
  runId: "fixture",
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
const request: JsonObject = {
  path: "script.sh",
  expectedContent: "alpha\nbeta\n",
  edits: [{ oldText: "beta", newText: "gamma" }],
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zet-file-tools-"));
  await writeFile(join(root, "script.sh"), "alpha\nbeta\n");
  await chmod(join(root, "script.sh"), 0o755);
  return root;
}
describe.runIf(process.platform === "linux")(
  "consent-gated structured file operations (real temporary files)",
  () => {
    it("patches exact source atomically, preserves executable bits and creates one directory", async () => {
      const root = await fixture();
      const approve = vi.fn(() => Promise.resolve(true));
      try {
        const [patch, make] = createRuntimeCodingFileTools({ root, approve });
        await patch!.invoke(request, context());
        expect(await readFile(join(root, "script.sh"), "utf8")).toBe("alpha\ngamma\n");
        expect((await stat(join(root, "script.sh"))).mode & 0o777).toBe(0o755);
        await make!.invoke({ path: "new-directory" }, context());
        expect((await lstat(join(root, "new-directory"))).isDirectory()).toBe(true);
        expect(approve).toHaveBeenCalledTimes(2);
        expect(await readdir(root)).toEqual(["new-directory", "script.sh"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it("denies patch and mkdir without effects", async () => {
      const root = await fixture();
      try {
        const [patch, make] = createRuntimeCodingFileTools({
          root,
          approve: () => Promise.resolve(false),
        });
        await expect(patch!.invoke(request, context())).rejects.toThrow("rejected");
        await expect(make!.invoke({ path: "denied" }, context())).rejects.toThrow("rejected");
        expect(await readFile(join(root, "script.sh"), "utf8")).toBe(request.expectedContent);
        expect(await readdir(root)).toEqual(["script.sh"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it("validates every patch edit before approval and rolls back malformed/ambiguous plans", async () => {
      const root = await fixture();
      const approve = vi.fn(() => Promise.resolve(true));
      try {
        const patch = createRuntimeCodingFileTools({ root, approve })[0]!;
        await expect(
          patch.invoke(
            {
              ...request,
              edits: [
                { oldText: "beta", newText: "gamma" },
                { oldText: "missing", newText: "oops" },
              ],
            },
            context(),
          ),
        ).rejects.toThrow("rejected");
        await expect(
          patch.invoke(
            {
              ...request,
              expectedContent: "repeat repeat",
              edits: [{ oldText: "repeat", newText: "oops" }],
            },
            context(),
          ),
        ).rejects.toThrow("rejected");
        await expect(patch.invoke({ ...request, extra: "unsafe" }, context())).rejects.toThrow(
          "rejected",
        );
        expect(approve).not.toHaveBeenCalled();
        expect(await readFile(join(root, "script.sh"), "utf8")).toBe(request.expectedContent);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it("rejects stale source after approval without overwriting a concurrent edit", async () => {
      const root = await fixture();
      try {
        const patch = createRuntimeCodingFileTools({
          root,
          approve: async () => {
            await writeFile(join(root, "script.sh"), "concurrent edit");
            return true;
          },
        })[0]!;
        await expect(patch.invoke(request, context())).rejects.toThrow("rejected");
        expect(await readFile(join(root, "script.sh"), "utf8")).toBe("concurrent edit");
        expect(await readdir(root)).toEqual(["script.sh"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it("refuses credential paths, hardlinks and parent symlink races", async () => {
      const root = await fixture();
      const external = await mkdtemp(join(tmpdir(), "zet-file-external-"));
      try {
        const tools = createRuntimeCodingFileTools({ root, approve: () => Promise.resolve(true) });
        await expect(tools[0]!.invoke({ ...request, path: ".env" }, context())).rejects.toThrow(
          "rejected",
        );
        await link(join(root, "script.sh"), join(root, "linked.sh"));
        await expect(tools[0]!.invoke(request, context())).rejects.toThrow("rejected");
        await mkdir(join(root, "parent"));
        await writeFile(join(root, "parent", "file.ts"), "original");
        await writeFile(join(external, "file.ts"), "private fixture");
        const patch = createRuntimeCodingFileTools({
          root,
          approve: async () => {
            await rename(join(root, "parent"), join(root, "old-parent"));
            await symlink(external, join(root, "parent"), "dir");
            return true;
          },
        })[0]!;
        await expect(
          patch.invoke(
            {
              path: "parent/file.ts",
              expectedContent: "original",
              edits: [{ oldText: "original", newText: "changed" }],
            },
            context(),
          ),
        ).rejects.toThrow("rejected");
        expect(await readFile(join(external, "file.ts"), "utf8")).toBe("private fixture");
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(external, { recursive: true, force: true });
      }
    });
    it("rejects cancellation and mutated caller arguments while awaiting consent", async () => {
      const root = await fixture();
      const controller = new AbortController();
      try {
        const input = {
          path: "script.sh",
          expectedContent: "alpha\nbeta\n",
          edits: [{ oldText: "beta", newText: "gamma" }],
        };
        const patch = createRuntimeCodingFileTools({
          root,
          approve: () => {
            input.path = "outside";
            input.edits = [];
            return Promise.resolve(true);
          },
        })[0]!;
        await patch.invoke(input, context());
        expect(await readFile(join(root, "script.sh"), "utf8")).toBe("alpha\ngamma\n");
        const make = createRuntimeCodingFileTools({
          root,
          approve: () => {
            controller.abort();
            return Promise.resolve(true);
          },
        })[1]!;
        await expect(
          make.invoke({ path: "cancelled" }, context(controller.signal)),
        ).rejects.toBeDefined();
        expect(await readdir(root)).toEqual(["script.sh"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);
it.runIf(process.platform !== "linux" && process.platform !== "win32")(
  "fails closed before consent without descriptor support",
  async () => {
    const approve = vi.fn(() => Promise.resolve(true));
    const tool = createRuntimeCodingFileTools({ root: tmpdir(), approve })[0]!;
    await expect(tool.invoke(request, context())).rejects.toThrow("rejected");
    expect(approve).not.toHaveBeenCalled();
  },
);

it("offers Windows expected-content mutations and dispatches exact approved snapshots (mock bridge)", async () => {
  const windows = await import("./runtime-windows-coding.js");
  const bridge = vi
    .spyOn(windows, "executeWindowsCodingOperation")
    .mockResolvedValue({ operation: "fixture" });
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const root = await fixture();
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const approve = vi.fn(() => Promise.resolve(true));
    const tools = createRuntimeCodingFileTools({ root, approve });
    expect(tools.map((tool) => tool.manifest.id)).toEqual([
      "harness.fs.apply_patch",
      "harness.fs.mkdir",
      "harness.fs.write",
      "harness.fs.rename",
      "harness.fs.delete",
    ]);
    await tools[0]!.invoke(request, context());
    expect(bridge.mock.calls[0]![0]).toEqual({
      operation: "write",
      root,
      path: "script.sh",
      expectedContent: "alpha\nbeta\n",
      content: "alpha\ngamma\n",
    });
    await tools[2]!.invoke({ path: "new.ts", expectedContent: null, content: "new" }, context());
    await tools[3]!.invoke(
      { path: "old.ts", to: "renamed.ts", expectedContent: "exact" },
      context(),
    );
    await tools[4]!.invoke({ path: "delete.ts", expectedContent: "exact" }, context());
    expect(bridge.mock.calls[2]![0]).toMatchObject({
      operation: "rename",
      path: "old.ts",
      to: "renamed.ts",
      expectedContent: "exact",
    });
    expect(bridge.mock.calls[3]![0]).toMatchObject({
      operation: "delete",
      path: "delete.ts",
      expectedContent: "exact",
    });
    expect(approve).toHaveBeenCalledTimes(4);
    expect(approve.mock.calls.length).toBe(4);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    bridge.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
it("Windows mutations reject missing expected state and never execute denied consent (mock bridge)", async () => {
  const windows = await import("./runtime-windows-coding.js");
  const bridge = vi.spyOn(windows, "executeWindowsCodingOperation").mockResolvedValue({});
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const root = await fixture();
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const approve = vi.fn(() => Promise.resolve(false));
    const tools = createRuntimeCodingFileTools({ root, approve });
    await expect(tools[2]!.invoke({ path: "new", content: "x" }, context())).rejects.toThrow(
      "rejected",
    );
    await expect(tools[3]!.invoke({ path: "old", to: "new" }, context())).rejects.toThrow(
      "rejected",
    );
    expect(approve).not.toHaveBeenCalled();
    await expect(
      tools[2]!.invoke({ path: "new", expectedContent: null, content: "x" }, context()),
    ).rejects.toThrow("rejected");
    expect(bridge).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    bridge.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
