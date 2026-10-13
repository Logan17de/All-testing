import { mkdtemp, mkdir, rm, writeFile, symlink, rename, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdapterInvocationContext, JsonObject } from "@zet-harness/plugin-api";
import { runBoundedProcess } from "@zet-harness/tools";
import { createRuntimeGitTools } from "./runtime-coding-git-tools.js";
import { buildGitCommand, classifySafeGitArgs } from "./runtime-git-command.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zet-git-fixture-"));
  const init = await runBoundedProcess({
    command: "git",
    args: ["init", "--initial-branch=fixture"],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  expect(init.exitCode).toBe(0);
  await writeFile(join(root, "source.txt"), "fixture source\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function context(signal = new AbortController().signal): AdapterInvocationContext {
  return {
    runId: "fixture",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "fixture-effect",
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
// Explicitly injected TEST runner: real temporary Git effects, NOT live OS sandbox acceptance.
const fixture: NonNullable<Parameters<typeof createRuntimeGitTools>[0]["sandbox"]> = async (
  request,
) => {
  const result = await runBoundedProcess({
    ...request,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.exitCode !== 0) throw new Error("fixture Git failed");
  return result;
};
function tools(approve: () => Promise<boolean> = () => Promise.resolve(true)) {
  return createRuntimeGitTools({ root, approve, sandbox: fixture });
}
function find(id: string, all = tools()) {
  return all.find((tool) => tool.manifest.id === `harness.git.${id}`)!;
}
it("classifies only exact safe argv, refuses flags/paths/author injection", () => {
  for (const operation of ["status", "log", "staged-paths"] as const)
    expect(classifySafeGitArgs(buildGitCommand(operation, {}))).toBe("read");
  expect(classifySafeGitArgs(buildGitCommand("add", { paths: ["source.txt"] }))).toBe("write");
  expect(
    classifySafeGitArgs(
      buildGitCommand("commit", {
        paths: ["source.txt"],
        message: "fixture",
        authorName: "Fixture User",
        authorEmail: "fixture@example.invalid",
      }),
    ),
  ).toBe("write");
  expect(classifySafeGitArgs(["push"])).toBeUndefined();
  expect(classifySafeGitArgs([...buildGitCommand("status", {}), "--ignored"])).toBeUndefined();
  for (const paths of [["../escape"], [".env"], [".git/config"], ["*.txt"], [":(top)source.txt"]])
    expect(() => buildGitCommand("add", { paths })).toThrow("refused");
  expect(() =>
    buildGitCommand("commit", {
      paths: ["source.txt"],
      message: "fixture",
      authorName: "bad\nidentity",
      authorEmail: "x@example.invalid",
    }),
  ).toThrow("refused");
});
it("actual temporary repo add/commit/diff/log via injected runner, not live sandbox", async () => {
  const all = tools();
  await find("add", all).invoke({ paths: ["source.txt"] }, context());
  await find("commit", all).invoke(
    {
      paths: ["source.txt"],
      message: "Fixture initial commit",
      authorName: "Fixture User",
      authorEmail: "fixture@example.invalid",
    },
    context(),
  );
  expect(((await find("log", all).invoke({}, context())).value as JsonObject).stdout).toContain(
    "Fixture initial commit",
  );
  await writeFile(join(root, "source.txt"), "fixture changed\n");
  expect(
    ((await find("diff", all).invoke({ paths: ["source.txt"] }, context())).value as JsonObject)
      .stdout,
  ).toContain("fixture changed");
  expect(((await find("status", all).invoke({}, context())).value as JsonObject).stdout).toContain(
    "source.txt",
  );
});
it("denial never executes mutation, read-only catalog omits writes", async () => {
  const all = tools(() => Promise.resolve(false));
  await expect(find("add", all).invoke({ paths: ["source.txt"] }, context())).rejects.toThrow(
    "rejected",
  );
  expect(((await find("status", all).invoke({}, context())).value as JsonObject).stdout).toContain(
    "?? source.txt",
  );
  expect(createRuntimeGitTools({ root }).map((tool) => tool.manifest.id)).toEqual([
    "harness.git.status",
    "harness.git.diff",
    "harness.git.log",
  ]);
});
it("commit refuses unrelated staged entries and credential paths", async () => {
  await writeFile(join(root, "other.txt"), "fixture other");
  await find("add").invoke({ paths: ["source.txt", "other.txt"] }, context());
  await expect(
    find("commit").invoke(
      {
        paths: ["source.txt"],
        message: "fixture",
        authorName: "Fixture",
        authorEmail: "fixture@example.invalid",
      },
      context(),
    ),
  ).rejects.toThrow("rejected");
  await expect(find("diff").invoke({ paths: [".env"] }, context())).rejects.toThrow("refused");
});
it("freezes approved execution arguments against caller/approval mutation", async () => {
  const input: JsonObject = { paths: ["source.txt"] };
  const all = createRuntimeGitTools({
    root,
    sandbox: fixture,
    approve: (request) => {
      (input as Record<string, unknown>).paths = ["other.txt"];
      (request.args as Record<string, unknown>).paths = ["other.txt"];
      return Promise.resolve(true);
    },
  });
  await find("add", all).invoke(input, context());
  expect(((await find("status", all).invoke({}, context())).value as JsonObject).stdout).toContain(
    "A  source.txt",
  );
});
it("rejects linked metadata, worktree indirection, and linked source", async () => {
  await mkdir(join(root, ".git", "worktrees"));
  await expect(find("status").invoke({}, context())).rejects.toThrow("rejected");
  await rm(join(root, ".git", "worktrees"), { recursive: true });
  if (process.platform !== "win32") {
    await symlink("source.txt", join(root, "alias"));
    await expect(find("add").invoke({ paths: ["alias"] }, context())).rejects.toThrow("rejected");
  }
});
it("cancellation and sandbox denial never try an alternate executor", async () => {
  let calls = 0;
  const all = createRuntimeGitTools({
    root,
    approve: () => Promise.resolve(true),
    sandbox: () => {
      calls++;
      return Promise.reject(new Error("sandbox unavailable"));
    },
  });
  await expect(find("add", all).invoke({ paths: ["source.txt"] }, context())).rejects.toThrow(
    "rejected",
  );
  expect(calls).toBe(1);
  const controller = new AbortController();
  controller.abort();
  await expect(
    find("add", all).invoke({ paths: ["source.txt"] }, context(controller.signal)),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

it("disables repository hooks and external diff programs in injected Git fixture", async () => {
  await writeFile(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 42\n", {
    mode: 0o700,
  });
  await find("add").invoke({ paths: ["source.txt"] }, context());
  await find("commit").invoke(
    {
      paths: ["source.txt"],
      message: "Hook-disabled fixture",
      authorName: "Fixture User",
      authorEmail: "fixture@example.invalid",
    },
    context(),
  );
  expect(((await find("log").invoke({}, context())).value as JsonObject).stdout).toContain(
    "Hook-disabled fixture",
  );
  expect(buildGitCommand("diff", { paths: ["source.txt"] })).toContain("--no-ext-diff");
  expect(buildGitCommand("diff", { paths: ["source.txt"] })).toContain("--no-textconv");
});
it("refuses truncated staged-path proof before commit even when visible names match", async () => {
  let commitCalls = 0;
  const all = createRuntimeGitTools({
    root,
    approve: () => Promise.resolve(true),
    sandbox: (request) => {
      if (request.args.includes("commit")) commitCalls++;
      return Promise.resolve({
        outcome: "exited",
        exitCode: 0,
        signal: null,
        stdout: "source.txt\0",
        stderr: "",
        stdoutTruncated: true,
        stderrTruncated: false,
        durationMs: 1,
      });
    },
  });
  await expect(
    find("commit", all).invoke(
      {
        paths: ["source.txt"],
        message: "fixture",
        authorName: "Fixture",
        authorEmail: "fixture@example.invalid",
      },
      context(),
    ),
  ).rejects.toThrow("rejected");
  expect(commitCalls).toBe(0);
});
it.runIf(process.platform !== "win32")(
  "refuses canonical root substitution while human approval is pending",
  async () => {
    const alias = `${root}-alias`;
    const replacement = await mkdtemp(join(tmpdir(), "zet-git-replacement-"));
    try {
      await mkdir(join(replacement, ".git"));
      await writeFile(join(replacement, "source.txt"), "replacement fixture");
      await symlink(root, alias);
      let calls = 0;
      const all = createRuntimeGitTools({
        root: alias,
        approve: async () => {
          await rm(alias);
          await symlink(replacement, alias);
          return true;
        },
        sandbox: () => {
          calls++;
          return Promise.reject(new Error("must not execute"));
        },
      });
      await expect(find("add", all).invoke({ paths: ["source.txt"] }, context())).rejects.toThrow(
        "rejected",
      );
      expect(calls).toBe(0);
    } finally {
      await rm(alias, { force: true });
      await rm(replacement, { recursive: true, force: true });
    }
  },
);

it("private database selections reject cached diffs/add/commit before approval or sandbox", async () => {
  const database = join(root, "chat.sqlite");
  await writeFile(database, "private fixture");
  await fixture({
    command: "git",
    args: buildGitCommand("add", { paths: ["chat.sqlite"] }),
    cwd: root,
    env: {},
  });
  await writeFile(database, "replacement fixture");
  const approve = vi.fn(() => Promise.resolve(true));
  const sandbox = vi.fn(fixture);
  const all = createRuntimeGitTools({
    root,
    approve,
    sandbox,
    privatePaths: [database, `${database}-wal`, `${database}-shm`],
  });
  for (const operation of ["diff", "add", "commit"]) {
    const input: JsonObject = {
      paths: ["chat.sqlite"],
      ...(operation === "diff"
        ? { staged: true }
        : operation === "commit"
          ? { message: "fixture", authorName: "Fixture", authorEmail: "fixture@example.invalid" }
          : {}),
    };
    await expect(find(operation, all).invoke(input, context())).rejects.toThrow("rejected");
  }
  for (const path of ["chat.sqlite-wal", "chat.sqlite-shm"]) {
    await expect(
      find("diff", all).invoke({ paths: [path], staged: true }, context()),
    ).rejects.toThrow("rejected");
  }
  expect(approve).not.toHaveBeenCalled();
  expect(sandbox).not.toHaveBeenCalled();
  expect(await readFile(database, "utf8")).toBe("replacement fixture");
});
it("private original inode aliases cannot be selected after rename", async () => {
  const database = join(root, "chat.sqlite");
  await writeFile(database, "private fixture");
  const approve = vi.fn(() => Promise.resolve(true));
  const sandbox = vi.fn(fixture);
  const all = createRuntimeGitTools({ root, approve, sandbox, privatePaths: [database] });
  await expect(find("diff", all).invoke({ paths: ["chat.sqlite"] }, context())).rejects.toThrow(
    "rejected",
  );
  await rename(database, join(root, "renamed.sqlite"));
  await expect(find("add", all).invoke({ paths: ["renamed.sqlite"] }, context())).rejects.toThrow(
    "rejected",
  );
  expect(approve).not.toHaveBeenCalled();
  expect(sandbox).not.toHaveBeenCalled();
});
it("private DB introduced at an approved source path is denied before dispatch", async () => {
  const database = join(root, "chat.sqlite");
  await writeFile(database, "private fixture");
  const sandbox = vi.fn(fixture);
  const all = createRuntimeGitTools({
    root,
    sandbox,
    privatePaths: [database],
    approve: async () => {
      await rm(join(root, "source.txt"));
      await rename(database, join(root, "source.txt"));
      return true;
    },
  });
  await expect(find("add", all).invoke({ paths: ["source.txt"] }, context())).rejects.toThrow(
    "rejected",
  );
  expect(sandbox).not.toHaveBeenCalled();
});
