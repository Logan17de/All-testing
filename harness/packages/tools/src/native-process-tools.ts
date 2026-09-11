import type {
  AdapterInvocationContext,
  HarnessPlugin,
  JsonObject,
  JsonValue,
  NodeBehavior,
  PluginContext,
  ToolAdapter,
  ToolResult,
} from "@zet-harness/plugin-api";
import { PLUGIN_API_VERSION } from "@zet-harness/plugin-api";

import type { AllowedCommandSpec } from "./command-allowlist.js";
import { validateCommandInvocation } from "./command-allowlist.js";
import { NativeToolError } from "./native-fs-tools.js";
import type { ProcessRunLimits, ProcessRunResult } from "./process-runner.js";
import { createMinimalEnvironment, runBoundedProcess } from "./process-runner.js";
import type { WorkspacePathResolver } from "./workspace-path.js";
import { createWorkspacePathResolver } from "./workspace-path.js";

/** Capability demanded by any tool that starts an external process. */
export const PROCESS_EXEC_CAPABILITY = "process:exec";
/** Capability demanded by the git read-only tools. */
export const GIT_READ_CAPABILITY = "git:read";
/** Capability demanded by `git.commit`. Granting git:read never implies it. */
export const GIT_COMMIT_CAPABILITY = "git:commit";

const MAX_COMMIT_MESSAGE_LENGTH = 4_096;

export type ProcessToolLimits = ProcessRunLimits;

export interface ShellToolOptions {
  readonly root: string;
  /**
   * Commands this tool may run.
   *
   * Empty by default: every invocation is refused until a host supplies a
   * policy. Installing a tool and authorizing what it may do stay separate.
   */
  readonly allowlist?: readonly AllowedCommandSpec[];
  readonly limits?: ProcessToolLimits;
  /** Extra environment variables for child processes. */
  readonly environment?: Readonly<Record<string, string>>;
}

function describeOutcome(result: ProcessRunResult): JsonObject {
  return {
    outcome: result.outcome,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    durationMs: result.durationMs,
  };
}

function readStringArray(input: JsonObject, key: string): readonly string[] {
  const value = input[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new NativeToolError("invalid-input", `'${key}' must be an array of strings.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new NativeToolError("invalid-input", `'${key}' must contain only strings.`);
    }
    return entry;
  });
}

function requireStringField(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new NativeToolError("invalid-input", `'${key}' must be a non-empty string.`);
  }
  return value;
}

const PROCESS_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["outcome", "exitCode", "stdout", "stderr"],
  properties: {
    outcome: {
      type: "string",
      enum: ["exited", "timed-out", "cancelled", "output-limit", "spawn-failed"],
    },
    exitCode: { type: ["integer", "null"] },
    signal: { type: ["string", "null"] },
    stdout: { type: "string" },
    stderr: { type: "string" },
    stdoutTruncated: { type: "boolean" },
    stderrTruncated: { type: "boolean" },
    durationMs: { type: "integer" },
  },
});

function processBehavior(readOnly: boolean, capabilities: readonly string[]): NodeBehavior {
  return Object.freeze({
    primitiveFamily: "effect" as const,
    determinism: "nondeterministic" as const,
    effect: readOnly ? ("external-read" as const) : ("external-write" as const),
    // A command that can change external state cannot promise a safe repeat,
    // so recovery is deliberately manual rather than an automatic rerun.
    idempotency: readOnly ? ("idempotent" as const) : ("unknown" as const),
    recovery: readOnly ? ("rerun" as const) : ("manual" as const),
    executionMode: "in-process" as const,
    requiredCapabilities: Object.freeze([...capabilities]),
  });
}

/**
 * Bounded external command execution.
 *
 * Despite the `shell.run` name from the plan, **no shell is involved**. The
 * executable is spawned directly with an argument vector, so argument content
 * cannot become a second command no matter what it contains. What a caller may
 * run is decided entirely by the host allowlist.
 */
export function createShellTool(options: ShellToolOptions): ToolAdapter {
  const allowlist = Object.freeze([...(options.allowlist ?? [])]);
  const resolver: WorkspacePathResolver = createWorkspacePathResolver({ root: options.root });
  const environment = createMinimalEnvironment(options.environment ?? {});
  const readOnly = allowlist.length > 0 && allowlist.every((spec) => spec.readOnly === true);

  return Object.freeze({
    manifest: Object.freeze({
      id: "harness.shell.run",
      version: "1",
      title: "Run an allowed command",
      description:
        "Run one host-allowed executable with an argument vector. No shell is used and no shell syntax is interpreted.",
      inputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: { type: "string", description: "Executable name, without a path." },
          args: { type: "array", items: { type: "string" } },
        },
      }),
      outputSchema: PROCESS_OUTPUT_SCHEMA,
      behavior: processBehavior(readOnly, [PROCESS_EXEC_CAPABILITY]),
    }),
    async invoke(input: JsonObject, context: AdapterInvocationContext): Promise<ToolResult> {
      context.signal.throwIfAborted();

      const command = requireStringField(input, "command");
      const args = readStringArray(input, "args");

      // Validation happens before anything is spawned; a refusal never starts
      // a process. Path operands go through the same workspace containment as
      // every other path the harness accepts.
      const invocation = validateCommandInvocation(
        allowlist,
        { command, args },
        { resolveOperand: (value) => resolver.resolveLexical(value) },
      );

      const result = await runBoundedProcess({
        command: invocation.command,
        args: invocation.args,
        cwd: resolver.root,
        env: environment,
        signal: context.signal,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      });

      return Object.freeze({ value: describeOutcome(result) });
    },
  });
}

export interface GitCommitApprovalRequest {
  readonly message: string;
  readonly runId: string;
  readonly logicalEffectId: string;
}

export interface GitToolOptions {
  readonly root: string;
  readonly limits?: ProcessToolLimits;
  readonly environment?: Readonly<Record<string, string>>;
  /** Executable name or absolute path. Defaults to `git` on PATH. */
  readonly gitExecutable?: string;
  /**
   * Enables `git.commit`.
   *
   * The callback must be wired to the durable human-approval boundary. A host
   * that returns true from privileged code has not created a second permission
   * broker — it has removed the gate. Omit this to ship without the tool.
   */
  readonly approveCommit?: (request: GitCommitApprovalRequest) => Promise<boolean>;
  /** Commit identity. Without it git falls back to its own configuration. */
  readonly author?: { readonly name: string; readonly email: string };
}

export interface GitTools {
  readonly status: ToolAdapter;
  readonly diff: ToolAdapter;
  readonly commit?: ToolAdapter;
  readonly adapters: readonly ToolAdapter[];
}

const SAFE_IDENTITY = /^[^\r\n\0<>]{1,128}$/u;

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * The NUL-delimited form is used because the default output quotes and escapes
 * unusual filenames, which would have to be un-escaped correctly to be safe.
 */
function parsePorcelainStatus(raw: string): JsonValue[] {
  const entries: JsonValue[] = [];
  const records = raw.split("\0");

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;

    const indexStatus = record.slice(0, 1);
    const worktreeStatus = record.slice(1, 2);
    const path = record.slice(3);

    // A rename or copy is followed by its source path as a separate record.
    let origin: string | undefined;
    if (indexStatus === "R" || indexStatus === "C") {
      origin = records[index + 1];
      index += 1;
    }

    entries.push({
      path,
      indexStatus,
      worktreeStatus,
      ...(origin === undefined ? {} : { originPath: origin }),
    });
  }

  return entries;
}

export function createGitTools(options: GitToolOptions): GitTools {
  const resolver: WorkspacePathResolver = createWorkspacePathResolver({ root: options.root });
  const environment = createMinimalEnvironment({
    // Keep git non-interactive: a credential or editor prompt would otherwise
    // block until the run's time budget expires.
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    ...options.environment,
  });
  const executable = options.gitExecutable ?? "git";

  const runGit = async (
    args: readonly string[],
    context: AdapterInvocationContext,
  ): Promise<ProcessRunResult> => {
    context.signal.throwIfAborted();
    return await runBoundedProcess({
      command: executable,
      args,
      cwd: resolver.root,
      env: environment,
      signal: context.signal,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
  };

  const statusAdapter: ToolAdapter = Object.freeze({
    manifest: Object.freeze({
      id: "harness.git.status",
      version: "1",
      title: "Git status",
      description: "Report the working tree status of the project repository.",
      inputSchema: Object.freeze({ type: "object", additionalProperties: false, properties: {} }),
      outputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["clean", "entries"],
        properties: {
          clean: { type: "boolean" },
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "indexStatus", "worktreeStatus"],
              properties: {
                path: { type: "string" },
                indexStatus: { type: "string" },
                worktreeStatus: { type: "string" },
                originPath: { type: "string" },
              },
            },
          },
        },
      }),
      behavior: processBehavior(true, [PROCESS_EXEC_CAPABILITY, GIT_READ_CAPABILITY]),
    }),
    async invoke(_input: JsonObject, context: AdapterInvocationContext): Promise<ToolResult> {
      const result = await runGit(["status", "--porcelain=v1", "-z"], context);
      if (result.outcome !== "exited" || result.exitCode !== 0) {
        throw new NativeToolError("io-error", `git status failed: ${result.outcome}`);
      }
      const entries = parsePorcelainStatus(result.stdout);
      return Object.freeze({
        value: Object.freeze({ clean: entries.length === 0, entries: Object.freeze(entries) }),
      });
    },
  });

  const diffAdapter: ToolAdapter = Object.freeze({
    manifest: Object.freeze({
      id: "harness.git.diff",
      version: "1",
      title: "Git diff",
      description: "Show the unified diff of the project repository.",
      inputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        properties: {
          staged: { type: "boolean", description: "Diff the index instead of the working tree." },
          path: { type: "string", description: "Limit the diff to one workspace path." },
        },
      }),
      outputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["patch", "truncated"],
        properties: {
          patch: { type: "string" },
          truncated: { type: "boolean" },
        },
      }),
      behavior: processBehavior(true, [PROCESS_EXEC_CAPABILITY, GIT_READ_CAPABILITY]),
    }),
    async invoke(input: JsonObject, context: AdapterInvocationContext): Promise<ToolResult> {
      const staged = input["staged"];
      if (staged !== undefined && staged !== null && typeof staged !== "boolean") {
        throw new NativeToolError("invalid-input", "'staged' must be a boolean.");
      }

      const args = ["diff", "--no-color"];
      if (staged === true) args.push("--cached");

      const path = input["path"];
      if (path !== undefined && path !== null) {
        if (typeof path !== "string") {
          throw new NativeToolError("invalid-input", "'path' must be a string.");
        }
        // Contained like any other path, then passed after `--` so a path that
        // begins with a dash cannot be read as an option.
        const resolved = await resolver.resolve(path);
        args.push("--", resolved.relativePath);
      }

      const result = await runGit(args, context);
      if (result.outcome !== "exited" || result.exitCode !== 0) {
        throw new NativeToolError("io-error", `git diff failed: ${result.outcome}`);
      }
      return Object.freeze({
        value: Object.freeze({ patch: result.stdout, truncated: result.stdoutTruncated }),
      });
    },
  });

  const approveCommit = options.approveCommit;
  const commitAdapter: ToolAdapter | undefined =
    approveCommit === undefined
      ? undefined
      : Object.freeze({
          manifest: Object.freeze({
            id: "harness.git.commit",
            version: "1",
            title: "Commit staged changes",
            description:
              "Commit the already-staged changes. Requires a human approval decision before it runs.",
            inputSchema: Object.freeze({
              type: "object",
              additionalProperties: false,
              required: ["message"],
              properties: {
                message: { type: "string", minLength: 1, maxLength: MAX_COMMIT_MESSAGE_LENGTH },
              },
            }),
            outputSchema: Object.freeze({
              type: "object",
              additionalProperties: false,
              required: ["committed", "commitSha"],
              properties: {
                committed: { type: "boolean" },
                commitSha: { type: ["string", "null"] },
              },
            }),
            behavior: processBehavior(false, [PROCESS_EXEC_CAPABILITY, GIT_COMMIT_CAPABILITY]),
          }),
          async invoke(input: JsonObject, context: AdapterInvocationContext): Promise<ToolResult> {
            const message = requireStringField(input, "message");
            if (message.length > MAX_COMMIT_MESSAGE_LENGTH) {
              throw new NativeToolError(
                "invalid-input",
                "Commit message exceeds the length limit.",
              );
            }

            // The gate runs before the effect, and a refusal is a normal
            // outcome rather than an error: a human declining is not a fault.
            const approved = await approveCommit({
              message,
              runId: context.runId,
              logicalEffectId: context.logicalEffectId,
            });
            if (!approved) {
              return Object.freeze({
                value: Object.freeze({ committed: false, commitSha: null }),
              });
            }

            context.signal.throwIfAborted();

            const args = ["commit", "-m", message];
            if (options.author !== undefined) {
              const { name, email } = options.author;
              if (!SAFE_IDENTITY.test(name) || !SAFE_IDENTITY.test(email)) {
                throw new NativeToolError(
                  "invalid-input",
                  "Configured commit identity is invalid.",
                );
              }
              // Host configuration, never model input: the argument vector is
              // built here and the values are checked for separators first.
              args.unshift("-c", `user.name=${name}`, "-c", `user.email=${email}`);
            }

            const result = await runGit(args, context);
            if (result.outcome !== "exited" || result.exitCode !== 0) {
              throw new NativeToolError("io-error", `git commit failed: ${result.outcome}`);
            }

            const head = await runGit(["rev-parse", "HEAD"], context);
            const commitSha =
              head.outcome === "exited" && head.exitCode === 0 ? head.stdout.trim() : null;

            return Object.freeze({ value: Object.freeze({ committed: true, commitSha }) });
          },
        });

  const adapters =
    commitAdapter === undefined
      ? Object.freeze([statusAdapter, diffAdapter])
      : Object.freeze([statusAdapter, diffAdapter, commitAdapter]);

  return Object.freeze(
    commitAdapter === undefined
      ? { status: statusAdapter, diff: diffAdapter, adapters }
      : { status: statusAdapter, diff: diffAdapter, commit: commitAdapter, adapters },
  );
}

export interface NativeProcessPluginOptions extends GitToolOptions {
  /** Also register `shell.run` with this allowlist. */
  readonly shell?: Omit<ShellToolOptions, "root">;
}

/** First-party plugin registering the git tools and, optionally, `shell.run`. */
export function createNativeProcessPlugin(options: NativeProcessPluginOptions): HarnessPlugin {
  const git = createGitTools(options);
  const shell =
    options.shell === undefined
      ? undefined
      : createShellTool({ root: options.root, ...options.shell });

  const adapters = shell === undefined ? git.adapters : [...git.adapters, shell];
  const capabilities = [
    { id: PROCESS_EXEC_CAPABILITY },
    { id: GIT_READ_CAPABILITY },
    ...(git.commit === undefined ? [] : [{ id: GIT_COMMIT_CAPABILITY }]),
  ];

  return Object.freeze({
    manifest: Object.freeze({
      id: "harness.tools.native-process",
      name: "Native process tools",
      version: "1",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: Object.freeze(capabilities),
    }),
    activate(context: PluginContext) {
      for (const adapter of adapters) {
        context.tools.register(adapter);
      }
    },
  });
}
