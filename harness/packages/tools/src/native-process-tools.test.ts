import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AdapterInvocationContext,
  JsonObject,
  ToolAdapter,
  ToolResult,
} from "@zet-harness/plugin-api";

import { READ_ONLY_GIT_COMMAND, isCommandDenialError } from "./command-allowlist.js";
import { isNativeToolError } from "./native-fs-tools.js";
import {
  GIT_COMMIT_CAPABILITY,
  GIT_READ_CAPABILITY,
  PROCESS_EXEC_CAPABILITY,
  createGitTools,
  createNativeProcessPlugin,
  createShellTool,
} from "./native-process-tools.js";
import { createMinimalEnvironment, runBoundedProcess } from "./process-runner.js";
import { isWorkspacePathError } from "./workspace-path.js";

function invocationContext(signal?: AbortSignal): AdapterInvocationContext {
  return {
    runId: "run-1",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "effect-1",
    signal: signal ?? new AbortController().signal,
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => 0,
    },
  };
}

function asRecord(result: ToolResult): Record<string, unknown> {
  return result.value as Record<string, unknown>;
}

async function failureCode(adapter: ToolAdapter, input: JsonObject): Promise<string> {
  try {
    await adapter.invoke(input, invocationContext());
  } catch (error: unknown) {
    if (isCommandDenialError(error)) return error.code;
    if (isNativeToolError(error)) return error.code;
    if (isWorkspacePathError(error)) return error.code;
    throw error;
  }
  throw new Error("Expected the invocation to be refused.");
}

let root: string;
let gitAvailable = false;

/** Create a real repository so git behaviour is proven, not simulated. */
async function initRepository(directory: string): Promise<boolean> {
  const env = createMinimalEnvironment({ GIT_TERMINAL_PROMPT: "0" });
  const init = await runBoundedProcess({
    command: "git",
    args: ["init", "--quiet"],
    cwd: directory,
    env,
    limits: { timeoutMs: 20_000 },
  });
  if (init.outcome !== "exited" || init.exitCode !== 0) return false;

  for (const args of [
    ["config", "user.name", "Zet Test"],
    ["config", "user.email", "zet@example.invalid"],
    ["config", "commit.gpgsign", "false"],
  ]) {
    await runBoundedProcess({
      command: "git",
      args,
      cwd: directory,
      env,
      limits: { timeoutMs: 20_000 },
    });
  }
  return true;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zet-git-"));
  await writeFile(join(root, "README.md"), "# project\n", "utf8");
  gitAvailable = await initRepository(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("shell.run policy", () => {
  it("refuses every command when no allowlist is configured", async () => {
    const shell = createShellTool({ root });
    expect(await failureCode(shell, { command: "git", args: ["status"] })).toBe(
      "command-not-allowed",
    );
  });

  it("declares process:exec demand", () => {
    const shell = createShellTool({ root });
    expect(shell.manifest.behavior.requiredCapabilities).toEqual([PROCESS_EXEC_CAPABILITY]);
  });

  it("classifies an all-read-only allowlist as an external read", () => {
    const shell = createShellTool({ root, allowlist: [READ_ONLY_GIT_COMMAND] });
    expect(shell.manifest.behavior.effect).toBe("external-read");
    expect(shell.manifest.behavior.recovery).toBe("rerun");
  });

  it("classifies an allowlist containing a writer as an external write with manual recovery", () => {
    const shell = createShellTool({
      root,
      allowlist: [{ command: "git", subcommands: ["status"] }],
    });
    expect(shell.manifest.behavior.effect).toBe("external-write");
    expect(shell.manifest.behavior.idempotency).toBe("unknown");
    expect(shell.manifest.behavior.recovery).toBe("manual");
  });

  it("treats an empty allowlist as a write, since it permits nothing to reason about", () => {
    const shell = createShellTool({ root });
    expect(shell.manifest.behavior.effect).toBe("external-write");
  });

  it("refuses an unlisted option before starting a process", async () => {
    const shell = createShellTool({ root, allowlist: [READ_ONLY_GIT_COMMAND] });
    expect(await failureCode(shell, { command: "git", args: ["status", "--output=/tmp/x"] })).toBe(
      "option-not-allowed",
    );
  });

  it("refuses a path operand outside the workspace", async () => {
    const shell = createShellTool({ root, allowlist: [READ_ONLY_GIT_COMMAND] });
    expect(await failureCode(shell, { command: "git", args: ["diff", "../../etc/passwd"] })).toBe(
      "escapes-root",
    );
  });

  it("requires a command", async () => {
    const shell = createShellTool({ root, allowlist: [READ_ONLY_GIT_COMMAND] });
    expect(await failureCode(shell, {})).toBe("invalid-input");
  });

  it("refuses non-string arguments", async () => {
    const shell = createShellTool({ root, allowlist: [READ_ONLY_GIT_COMMAND] });
    expect(await failureCode(shell, { command: "git", args: [1] })).toBe("invalid-input");
  });

  it("runs an allowed command and reports its outcome", async () => {
    if (!gitAvailable) return;
    const shell = createShellTool({
      root,
      allowlist: [READ_ONLY_GIT_COMMAND],
      limits: { timeoutMs: 20_000 },
    });
    const value = asRecord(
      await shell.invoke({ command: "git", args: ["status", "--porcelain"] }, invocationContext()),
    );
    expect(value["outcome"]).toBe("exited");
    expect(value["exitCode"]).toBe(0);
    expect(String(value["stdout"])).toContain("README.md");
  });
});

describe("git.status", () => {
  it("declares git:read demand and read-only behaviour", () => {
    const { status } = createGitTools({ root });
    expect(status.manifest.behavior.requiredCapabilities).toEqual([
      PROCESS_EXEC_CAPABILITY,
      GIT_READ_CAPABILITY,
    ]);
    expect(status.manifest.behavior.effect).toBe("external-read");
  });

  it("reports an untracked file", async () => {
    if (!gitAvailable) return;
    const { status } = createGitTools({ root, limits: { timeoutMs: 20_000 } });
    const value = asRecord(await status.invoke({}, invocationContext()));
    expect(value["clean"]).toBe(false);
    const entries = value["entries"] as { path: string }[];
    expect(entries.map((entry) => entry.path)).toContain("README.md");
  });

  it("reports a clean tree after everything is committed", async () => {
    if (!gitAvailable) return;
    const env = createMinimalEnvironment({ GIT_TERMINAL_PROMPT: "0" });
    await runBoundedProcess({ command: "git", args: ["add", "-A"], cwd: root, env });
    await runBoundedProcess({
      command: "git",
      args: ["commit", "-m", "initial"],
      cwd: root,
      env,
      limits: { timeoutMs: 20_000 },
    });
    const { status } = createGitTools({ root, limits: { timeoutMs: 20_000 } });
    const value = asRecord(await status.invoke({}, invocationContext()));
    expect(value["clean"]).toBe(true);
    expect(value["entries"]).toEqual([]);
  });

  it("handles a filename containing a space without quoting artifacts", async () => {
    if (!gitAvailable) return;
    await writeFile(join(root, "a file with spaces.txt"), "x", "utf8");
    const { status } = createGitTools({ root, limits: { timeoutMs: 20_000 } });
    const value = asRecord(await status.invoke({}, invocationContext()));
    const entries = value["entries"] as { path: string }[];
    expect(entries.map((entry) => entry.path)).toContain("a file with spaces.txt");
  });

  it("fails closed when git is unavailable", async () => {
    const { status } = createGitTools({
      root,
      gitExecutable: join(root, "no-such-git"),
      limits: { timeoutMs: 20_000 },
    });
    expect(await failureCode(status, {})).toBe("io-error");
  });
});

describe("git.diff", () => {
  it("returns an empty patch for an untracked-only tree", async () => {
    if (!gitAvailable) return;
    const { diff } = createGitTools({ root, limits: { timeoutMs: 20_000 } });
    const value = asRecord(await diff.invoke({}, invocationContext()));
    expect(value["patch"]).toBe("");
  });

  it("shows a modification to a tracked file", async () => {
    if (!gitAvailable) return;
    const env = createMinimalEnvironment({ GIT_TERMINAL_PROMPT: "0" });
    await runBoundedProcess({ command: "git", args: ["add", "-A"], cwd: root, env });
    await runBoundedProcess({
      command: "git",
      args: ["commit", "-m", "initial"],
      cwd: root,
      env,
      limits: { timeoutMs: 20_000 },
    });
    await writeFile(join(root, "README.md"), "# project\nchanged\n", "utf8");

    const { diff } = createGitTools({ root, limits: { timeoutMs: 20_000 } });
    const value = asRecord(await diff.invoke({}, invocationContext()));
    expect(String(value["patch"])).toContain("changed");
  });

  it("refuses a path outside the workspace", async () => {
    const { diff } = createGitTools({ root, limits: { timeoutMs: 20_000 } });
    expect(await failureCode(diff, { path: "../../etc/passwd" })).toBe("escapes-root");
  });

  it("refuses a non-boolean staged flag", async () => {
    const { diff } = createGitTools({ root, limits: { timeoutMs: 20_000 } });
    expect(await failureCode(diff, { staged: "yes" })).toBe("invalid-input");
  });
});

describe("git.commit approval gate", () => {
  it("is absent unless an approval callback is supplied", () => {
    const tools = createGitTools({ root });
    expect(tools.commit).toBeUndefined();
    expect(tools.adapters).toHaveLength(2);
  });

  it("declares git:commit demand separately from git:read", () => {
    const tools = createGitTools({ root, approveCommit: () => Promise.resolve(true) });
    expect(tools.commit?.manifest.behavior.requiredCapabilities).toEqual([
      PROCESS_EXEC_CAPABILITY,
      GIT_COMMIT_CAPABILITY,
    ]);
  });

  it("declares an external write with manual recovery", () => {
    const tools = createGitTools({ root, approveCommit: () => Promise.resolve(true) });
    expect(tools.commit?.manifest.behavior.effect).toBe("external-write");
    expect(tools.commit?.manifest.behavior.recovery).toBe("manual");
  });

  it("does not commit when approval is refused", async () => {
    if (!gitAvailable) return;
    const env = createMinimalEnvironment({ GIT_TERMINAL_PROMPT: "0" });
    await runBoundedProcess({ command: "git", args: ["add", "-A"], cwd: root, env });

    const tools = createGitTools({
      root,
      limits: { timeoutMs: 20_000 },
      approveCommit: () => Promise.resolve(false),
    });
    const value = asRecord(await tools.commit!.invoke({ message: "nope" }, invocationContext()));
    expect(value["committed"]).toBe(false);

    const log = await runBoundedProcess({
      command: "git",
      args: ["rev-list", "--count", "--all"],
      cwd: root,
      env,
      limits: { timeoutMs: 20_000 },
    });
    expect(log.stdout.trim()).toBe("0");
  });

  it("asks for approval before running the effect", async () => {
    if (!gitAvailable) return;
    const env = createMinimalEnvironment({ GIT_TERMINAL_PROMPT: "0" });
    await runBoundedProcess({ command: "git", args: ["add", "-A"], cwd: root, env });

    let askedWith: string | undefined;
    const tools = createGitTools({
      root,
      limits: { timeoutMs: 20_000 },
      approveCommit: (request) => {
        askedWith = request.message;
        return Promise.resolve(true);
      },
    });
    await tools.commit!.invoke({ message: "recorded message" }, invocationContext());
    expect(askedWith).toBe("recorded message");
  });

  it("commits and reports the resulting sha once approved", async () => {
    if (!gitAvailable) return;
    const env = createMinimalEnvironment({ GIT_TERMINAL_PROMPT: "0" });
    await runBoundedProcess({ command: "git", args: ["add", "-A"], cwd: root, env });

    const tools = createGitTools({
      root,
      limits: { timeoutMs: 20_000 },
      approveCommit: () => Promise.resolve(true),
    });
    const value = asRecord(
      await tools.commit!.invoke({ message: "approved commit" }, invocationContext()),
    );
    expect(value["committed"]).toBe(true);
    expect(String(value["commitSha"])).toMatch(/^[0-9a-f]{7,40}$/u);
  });

  it("requires a non-empty message", async () => {
    const tools = createGitTools({ root, approveCommit: () => Promise.resolve(true) });
    expect(await failureCode(tools.commit!, { message: "" })).toBe("invalid-input");
  });

  it("refuses a commit identity containing a newline", async () => {
    if (!gitAvailable) return;
    const tools = createGitTools({
      root,
      limits: { timeoutMs: 20_000 },
      approveCommit: () => Promise.resolve(true),
      author: { name: "Bad\nName", email: "a@b.invalid" },
    });
    expect(await failureCode(tools.commit!, { message: "x" })).toBe("invalid-input");
  });
});

describe("plugin registration", () => {
  it("registers the read-only git tools by default", async () => {
    const registered: ToolAdapter[] = [];
    const plugin = createNativeProcessPlugin({ root });
    await plugin.activate({
      nodes: { register: () => undefined },
      models: { register: () => undefined },
      tools: { register: (adapter: ToolAdapter) => registered.push(adapter) },
      onDispose: () => undefined,
    });
    expect(registered.map((adapter) => adapter.manifest.id)).toEqual([
      "harness.git.status",
      "harness.git.diff",
    ]);
  });

  it("adds shell.run only when a shell configuration is supplied", async () => {
    const registered: ToolAdapter[] = [];
    const plugin = createNativeProcessPlugin({
      root,
      shell: { allowlist: [READ_ONLY_GIT_COMMAND] },
    });
    await plugin.activate({
      nodes: { register: () => undefined },
      models: { register: () => undefined },
      tools: { register: (adapter: ToolAdapter) => registered.push(adapter) },
      onDispose: () => undefined,
    });
    expect(registered.map((adapter) => adapter.manifest.id)).toContain("harness.shell.run");
  });

  it("declares git:commit only when the commit tool exists", () => {
    const withoutCommit = createNativeProcessPlugin({ root });
    const withCommit = createNativeProcessPlugin({
      root,
      approveCommit: () => Promise.resolve(true),
    });
    expect(withoutCommit.manifest.capabilities?.map((entry) => entry.id)).not.toContain(
      GIT_COMMIT_CAPABILITY,
    );
    expect(withCommit.manifest.capabilities?.map((entry) => entry.id)).toContain(
      GIT_COMMIT_CAPABILITY,
    );
  });
});
