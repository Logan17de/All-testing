import { mkdtemp, mkdir, rm, writeFile, readFile, rename, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { runBoundedProcess } from "@zet-harness/tools";
import { runSandboxedProcess } from "./runtime-process-sandbox.js";
import type { AdapterInvocationContext } from "@zet-harness/plugin-api";
import {
  buildManagedWorktreeCommand,
  classifyManagedWorktreeArgs,
  createRuntimeWorktreeTools,
  verifyManagedWorktreeOwnership,
  type RuntimeWorktreeToolOptions,
  validateManagedWorktreeCheckout,
} from "./runtime-coding-worktrees.js";
let directory: string, root: string, journalPath: string, commit: string;
async function git(args: readonly string[]) {
  return runBoundedProcess({
    command: "git",
    args,
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zet-managed-worktree-"));
  root = join(directory, "repo");
  await mkdir(root);
  root = await realpath(root);
  const state = join(directory, "private-state");
  await mkdir(state, { mode: 0o700 });
  journalPath = join(await realpath(state), "worktrees.json");
  expect((await git(["init", "--initial-branch=fixture"])).exitCode).toBe(0);
  await writeFile(join(root, "source.txt"), "fixture source\n");
  expect((await git(["add", "source.txt"])).exitCode).toBe(0);
  expect(
    (
      await git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.org",
        "commit",
        "-m",
        "fixture",
      ])
    ).exitCode,
  ).toBe(0);
  commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function context(signal = new AbortController().signal): AdapterInvocationContext {
  return {
    runId: "fixture",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "fixture",
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
// Sandbox MOCK: real temporary Git effects prove command/journal behavior,
// not production namespaces, mounts, credential masking or kernel approval.
const sandbox: RuntimeWorktreeToolOptions["sandbox"] = async (request, scope) => {
  const checked = await verifyManagedWorktreeOwnership(root, journalPath, scope.pendingCreation);
  expect(checked.root).toEqual(scope.root);
  expect(checked.container).toEqual(scope.container);
  return git(request.args);
};
function tools(overrides: Partial<RuntimeWorktreeToolOptions> = {}) {
  return createRuntimeWorktreeTools({
    root,
    journalPath,
    sandbox,
    approve: () => Promise.resolve(true),
    ...overrides,
  });
}
function find(operation: string, all = tools()) {
  return all.find((tool) => tool.manifest.id === "harness.git.worktree." + operation)!;
}
async function create(all = tools()) {
  return find("create", all).invoke({ name: "task", commit }, context());
}

it("classifies only fixed commands and rejects revisions, paths, options and force flags", () => {
  expect(
    classifyManagedWorktreeArgs(buildManagedWorktreeCommand("create", { name: "task", commit })),
  ).toBe("write");
  expect(classifyManagedWorktreeArgs(buildManagedWorktreeCommand("remove", { name: "task" }))).toBe(
    "write",
  );
  expect(classifyManagedWorktreeArgs(buildManagedWorktreeCommand("list", {}))).toBe("read");
  expect(classifyManagedWorktreeArgs(["worktree", "remove", "--force", "other"])).toBeUndefined();
  for (const name of ["../outside", "-f", "task/other", "task;git", "TASK", "a".repeat(49)])
    expect(() => buildManagedWorktreeCommand("create", { name, commit })).toThrow();
  for (const revision of ["HEAD", "main", "--detach", "a".repeat(39), "A".repeat(40)])
    expect(() =>
      buildManagedWorktreeCommand("create", { name: "task", commit: revision }),
    ).toThrow();
  expect(() => buildManagedWorktreeCommand("remove", { name: "task", force: true })).toThrow();
});
it.runIf(process.platform === "linux")(
  "creates checked-out detached tree, lists owned entries and removes clean tree through sandbox mock",
  async () => {
    const approve = vi.fn(() => Promise.resolve(true));
    const all = tools({ approve });
    const value = await create(all);
    expect(value.value).toEqual({
      worktrees: [{ name: "task", commit, path: ".zet-worktrees/task" }],
    });
    expect(await readFile(join(root, ".zet-worktrees/task/source.txt"), "utf8")).toBe(
      "fixture source\n",
    );
    expect((await find("list", all).invoke({}, context())).value).toEqual(value.value);
    expect((await verifyManagedWorktreeOwnership(root, journalPath)).records[0]?.phase).toBe(
      "owned",
    );
    expect((await find("remove", all).invoke({ name: "task" }, context())).value).toEqual({
      worktrees: [],
    });
    await expect(lstat(join(root, ".zet-worktrees/task"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(approve).toHaveBeenCalledTimes(3);
  },
);
it("never deletes a preexisting container or tree without ownership proof", async () => {
  await mkdir(join(root, ".zet-worktrees"));
  await mkdir(join(root, ".zet-worktrees/task"));
  await writeFile(join(root, ".zet-worktrees/task/keep.txt"), "keep");
  const execute = vi.fn(sandbox);
  await expect(create(tools({ sandbox: execute }))).rejects.toThrow("refused");
  await expect(
    find("remove", tools({ sandbox: execute })).invoke({ name: "task" }, context()),
  ).rejects.toThrow("refused");
  expect(execute).not.toHaveBeenCalled();
  expect(await readFile(join(root, ".zet-worktrees/task/keep.txt"), "utf8")).toBe("keep");
});
it.runIf(process.platform === "linux")(
  "refuses dirty removal without force and preserves the owned tree",
  async () => {
    await create();
    await writeFile(join(root, ".zet-worktrees/task/source.txt"), "user change\n");
    await expect(find("remove").invoke({ name: "task" }, context())).rejects.toThrow("refused");
    expect(await readFile(join(root, ".zet-worktrees/task/source.txt"), "utf8")).toBe(
      "user change\n",
    );
    expect((await verifyManagedWorktreeOwnership(root, journalPath)).records).toHaveLength(1);
  },
);
it("denied approval and pre-cancellation execute nothing and create no container", async () => {
  const execute = vi.fn(sandbox);
  await expect(
    create(tools({ sandbox: execute, approve: () => Promise.resolve(false) })),
  ).rejects.toThrow("refused");
  const controller = new AbortController();
  controller.abort(new Error("fixture cancelled"));
  await expect(
    find("create", tools({ sandbox: execute })).invoke(
      { name: "task", commit },
      context(controller.signal),
    ),
  ).rejects.toThrow("fixture cancelled");
  expect(execute).not.toHaveBeenCalled();
  await expect(lstat(join(root, ".zet-worktrees"))).rejects.toMatchObject({ code: "ENOENT" });
});
it.runIf(process.platform === "linux")(
  "refuses container substitution during approval before sandbox execution",
  async () => {
    await create();
    const execute = vi.fn(sandbox);
    const all = tools({
      sandbox: execute,
      approve: async () => {
        await rename(join(root, ".zet-worktrees"), join(root, "original-container"));
        await mkdir(join(root, ".zet-worktrees"));
        return true;
      },
    });
    await expect(find("remove", all).invoke({ name: "task" }, context())).rejects.toThrow(
      "refused",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(join(root, "original-container/task/source.txt"), "utf8")).toBe(
      "fixture source\n",
    );
  },
);
it("refuses Git metadata substitution during first-create approval", async () => {
  const execute = vi.fn(sandbox);
  const all = tools({
    sandbox: execute,
    approve: async () => {
      await rename(join(root, ".git"), join(root, "original-metadata"));
      await mkdir(join(root, ".git"));
      return true;
    },
  });
  await expect(create(all)).rejects.toThrow("refused");
  expect(execute).not.toHaveBeenCalled();
});
it("quarantines uncertain failed create and never executes fallback cleanup", async () => {
  const execute = vi.fn<RuntimeWorktreeToolOptions["sandbox"]>((request, scope) =>
    classifyManagedWorktreeArgs(request.args) === "read"
      ? sandbox(request, scope)
      : Promise.reject(new Error("private sandbox diagnostic")),
  );
  await expect(create(tools({ sandbox: execute }))).rejects.toThrow("refused");
  expect(execute).toHaveBeenCalledTimes(2);
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    records: { phase: string }[];
  };
  expect(journal.records[0]?.phase).toBe("creating");
  await expect(find("remove").invoke({ name: "task" }, context())).rejects.toThrow("recovery");
});
it.runIf(process.platform === "linux")(
  "rejects unknown entries and altered worktree pointers before execution",
  async () => {
    await create();
    await mkdir(join(root, ".zet-worktrees/unowned"));
    const execute = vi.fn(sandbox);
    await expect(find("list", tools({ sandbox: execute })).invoke({}, context())).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    await rm(join(root, ".zet-worktrees/unowned"), { recursive: true });
    await writeFile(join(root, ".zet-worktrees/task/.git"), "gitdir: /outside/metadata\n");
    await expect(
      find("remove", tools({ sandbox: execute })).invoke({ name: "task" }, context()),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  },
);
it("rejects workspace-visible state and concurrent journal locks", async () => {
  await expect(create(tools({ journalPath: join(root, "journal.json") }))).rejects.toThrow();
  await writeFile(journalPath + ".lock", "preexisting lock", { mode: 0o600 });
  await expect(create()).rejects.toThrow();
  expect(await readFile(journalPath + ".lock", "utf8")).toBe("preexisting lock");
});
it("rejects unrelated Git worktree admin entries without deletion", async () => {
  const unrelated = join(directory, "unrelated");
  expect((await git(["worktree", "add", "--detach", unrelated, commit])).exitCode).toBe(0);
  const execute = vi.fn(sandbox);
  await expect(create(tools({ sandbox: execute }))).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  expect(await readFile(join(unrelated, "source.txt"), "utf8")).toBe("fixture source\n");
});

it("bounds checkout modes, credential paths, blob size and malformed/truncated output", async () => {
  const actual = await git(buildManagedWorktreeCommand("inspect", { commit }));
  expect(() => validateManagedWorktreeCheckout(actual)).not.toThrow();
  expect(classifyManagedWorktreeArgs(buildManagedWorktreeCommand("inspect", { commit }))).toBe(
    "read",
  );
  for (const stdout of [
    "120000 blob " + commit + " 3\tsymlink\0",
    "160000 commit " + commit + " -\tsubmodule\0",
    "100644 blob " + commit + " 3\t.env\0",
    "100644 blob " + commit + " 8388609\tlarge.txt\0",
    "100644 blob " + commit + " 3\t../outside\0",
    "100644 blob " + commit + " 3\tsource.txt",
  ])
    expect(() => validateManagedWorktreeCheckout({ ...actual, stdout })).toThrow();
  expect(() => validateManagedWorktreeCheckout({ ...actual, stdoutTruncated: true })).toThrow();
});
it("preflight refusal creates no reservation and never executes worktree add", async () => {
  const execute = vi.fn<RuntimeWorktreeToolOptions["sandbox"]>(async (request, scope) => {
    const result = await sandbox(request, scope);
    return { ...result, stdout: "120000 blob " + commit + " 3\tsymlink\0" };
  });
  await expect(create(tools({ sandbox: execute }))).rejects.toThrow();
  expect(execute).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(journalPath, "utf8")) as unknown).toMatchObject({ records: [] });
});

it.runIf(process.platform === "win32")(
  "refuses managed worktree production sandbox on Windows without any runner fallback",
  async () => {
    const runner = vi.fn<typeof runBoundedProcess>();
    const identity = { path: root, dev: "1", ino: "1" };
    await expect(
      runSandboxedProcess(
        {
          command: "git",
          args: buildManagedWorktreeCommand("create", { name: "task", commit }),
          cwd: root,
          env: {},
        },
        runner,
        "win32",
        {
          root: identity,
          git: { ...identity, path: join(root, ".git") },
          container: { ...identity, path: join(root, ".zet-worktrees") },
          journalPath,
          records: [],
          pendingCreation: { name: "task", commit },
        },
      ),
    ).rejects.toThrow("refused");
    expect(runner).not.toHaveBeenCalled();
    await expect(lstat(join(root, ".zet-worktrees"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);
