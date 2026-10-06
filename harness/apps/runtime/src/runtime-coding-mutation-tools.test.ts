/* eslint-disable @typescript-eslint/require-await -- asynchronous consent callback fixtures */
import {
  chmod,
  stat,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdapterInvocationContext, JsonObject } from "@zet-harness/plugin-api";
import { createRuntimeMutationTools } from "./runtime-coding-mutation-tools.js";
import { runSandboxedProcess, runSandboxedProjectCommand } from "./runtime-process-sandbox.js";
vi.mock(import("./runtime-process-sandbox.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  runSandboxedProcess: vi.fn(),
  runSandboxedProjectCommand: vi.fn(),
}));
let root: string;
beforeEach(async () => {
  vi.mocked(runSandboxedProcess).mockReset();
  vi.mocked(runSandboxedProjectCommand).mockReset();
  root = await mkdtemp(join(tmpdir(), "zet-mutations-"));
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
it("denial or approval failure never creates a file", async () => {
  for (const approve of [
    async () => false,
    async (): Promise<boolean> => {
      throw new Error("approval unavailable");
    },
  ]) {
    const [write] = createRuntimeMutationTools({ root, approve });
    await expect(write!.invoke({ path: "file.ts", content: "text" }, context())).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  }
});
it("writes only the approved immutable snapshot", async () => {
  const input = { path: "file.ts", content: "approved" };
  const approve = vi.fn(async (request: { tool: string; args: JsonObject }) => {
    expect(Object.isFrozen(request.args)).toBe(true);
    input.path = ".env";
    input.content = "changed";
    return true;
  });
  const [write] = createRuntimeMutationTools({ root, approve });
  if (process.platform !== "linux") {
    await expect(write!.invoke(input, context())).rejects.toThrow();
    expect(approve).not.toHaveBeenCalled();
    return;
  }
  expect((await write!.invoke(input, context())).value).toEqual({
    path: "file.ts",
    writtenBytes: 8,
  });
  expect(await readFile(join(root, "file.ts"), "utf8")).toBe("approved");
  expect(await readdir(root)).toEqual(["file.ts"]);
}, 75_000);
it("rejects unsafe input before asking for approval", async () => {
  const approve = vi.fn(async () => true);
  const [write, exec] = createRuntimeMutationTools({ root, approve });
  for (const path of [
    "../escape",
    ".env",
    ".git/config",
    "secret.key",
    "src/../file",
    "a:b",
    "a\\b",
  ]) {
    await expect(write!.invoke({ path, content: "text" }, context())).rejects.toThrow();
  }
  await expect(
    write!.invoke({ path: "large", content: "x".repeat(65537) }, context()),
  ).rejects.toThrow();
  for (const command of ["bash", "node -e", "git commit", "npm test"])
    await expect(exec!.invoke({ command }, context())).rejects.toThrow();
  expect(approve).not.toHaveBeenCalled();
});
it("refuses symlink and hardlink destinations and linked parents", async () => {
  if (process.platform !== "linux") return;
  await writeFile(join(root, "source"), "original");
  await link(join(root, "source"), join(root, "hard"));
  await symlink(join(root, "source"), join(root, "alias"));
  await mkdir(join(root, "dir"));
  await symlink(join(root, "dir"), join(root, "dir-alias"));
  const [write] = createRuntimeMutationTools({ root, approve: async () => true });
  for (const path of ["hard", "alias", "dir-alias/file"])
    await expect(write!.invoke({ path, content: "changed" }, context())).rejects.toThrow();
  expect(await readFile(join(root, "source"), "utf8")).toBe("original");
  expect(await readdir(join(root, "dir"))).toEqual([]);
});
it("aborts after approval before creating any output", async () => {
  const controller = new AbortController();
  const [write] = createRuntimeMutationTools({
    root,
    approve: async () => {
      controller.abort();
      return true;
    },
  });
  await expect(
    write!.invoke({ path: "file", content: "text" }, context(controller.signal)),
  ).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
});
it("dispatches a fixed node version diagnostic through mocked OS sandbox after approval", async () => {
  const approve = vi.fn(async () => true);
  const [, exec] = createRuntimeMutationTools({ root, approve });
  if (process.platform !== "linux" && process.platform !== "win32") {
    await expect(exec!.invoke({ command: "node-version" }, context())).rejects.toThrow();
    return;
  }
  vi.mocked(runSandboxedProcess).mockResolvedValue({
    outcome: "exited",
    exitCode: 0,
    signal: null,
    stdout: `${process.version}\n`,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
  });
  const result = (await exec!.invoke({ command: "node-version" }, context())).value;
  expect(result).toMatchObject({ outcome: "exited", exitCode: 0, stdout: `${process.version}\n` });
  expect(approve).toHaveBeenCalledTimes(1);
});

it("preserves executable bits without setid on replacement", async () => {
  if (process.platform !== "linux") return;
  await writeFile(join(root, "script.sh"), "before");
  await chmod(join(root, "script.sh"), 0o755);
  const [write] = createRuntimeMutationTools({ root, approve: async () => true });
  await write!.invoke({ path: "script.sh", content: "after" }, context());
  expect((await stat(join(root, "script.sh"))).mode & 0o7777).toBe(0o755);
  expect(await readFile(join(root, "script.sh"), "utf8")).toBe("after");
});

it("sandbox failure fails closed without host process fallback", async () => {
  if (process.platform !== "linux") return;
  vi.mocked(runSandboxedProcess).mockRejectedValue(new Error("sandbox unavailable"));
  const [, exec] = createRuntimeMutationTools({ root, approve: async () => true });
  await expect(exec!.invoke({ command: "node-version" }, context())).rejects.toThrow("rejected");
  expect(runSandboxedProcess).toHaveBeenCalledTimes(1);
});
it.runIf(process.platform === "linux")(
  "executes only the approved fixed project command in a private copy",
  async () => {
    const approvals: JsonObject[] = [];
    const tools = createRuntimeMutationTools({
      root,
      approve: async (request) => {
        approvals.push(request.args);
        return true;
      },
    });
    const tool = tools.find((entry) => entry.manifest.id === "harness.shell.run")!;
    vi.mocked(runSandboxedProjectCommand).mockResolvedValue({
      outcome: "exited",
      exitCode: 1,
      signal: null,
      stdout: "fixture failing test",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
    });
    const result = await tool.invoke({ command: "project-test" }, context());
    expect(approvals).toEqual([{ command: "project-test" }]);
    expect(vi.mocked(runSandboxedProjectCommand).mock.calls[0]?.[0]).toMatchObject({
      cwd: root,
      command: "project-test",
    });
    expect(result.value).toMatchObject({
      exitCode: 1,
      executionWorkspace: "temporary-copy",
      sourceWorkspaceModified: false,
    });
    await expect(
      tool.invoke({ command: "project-test", argv: ["--danger"] }, context()),
    ).rejects.toThrow();
    expect(runSandboxedProcess).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform !== "linux")(
  "rejects private custom DB and missing sidecar writes before consent",
  async () => {
    const database = join(root, "chat.sqlite");
    await writeFile(database, "private fixture");
    const approve = vi.fn(async () => true);
    const [write] = createRuntimeMutationTools({
      root,
      approve,
      privatePaths: [database, `${database}-wal`, `${database}-shm`],
    });
    for (const name of ["chat.sqlite", "chat.sqlite-wal", "chat.sqlite-shm"]) {
      await expect(write!.invoke({ path: name, content: "bad" }, context())).rejects.toThrow(
        "rejected",
      );
    }
    expect(approve).not.toHaveBeenCalled();
    expect(await readFile(database, "utf8")).toBe("private fixture");
  },
);

it.skipIf(process.platform !== "linux")(
  "cancellation during final private guard never publishes a write",
  async () => {
    const guards = await import("./runtime-workspace-read-tools.js");
    const controller = new AbortController();
    let calls = 0;
    const spy = vi.spyOn(guards, "createWorkspacePrivateGuard").mockReturnValue({
      paths: [],
      assertAllowed: () => {
        if (++calls === 3) controller.abort();
        return Promise.resolve();
      },
    });
    try {
      const [write] = createRuntimeMutationTools({ root, approve: () => Promise.resolve(true) });
      await expect(
        write!.invoke({ path: "new-file", content: "text" }, context(controller.signal)),
      ).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  },
);

it.runIf(process.platform === "win32")(
  "legacy Linux write adapter fails closed on Windows before approval",
  async () => {
    const approve = vi.fn(async () => true);
    const [write] = createRuntimeMutationTools({ root, approve });
    await expect(write!.invoke({ path: "file.ts", content: "text" }, context())).rejects.toThrow(
      "rejected",
    );
    expect(approve).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  },
);
