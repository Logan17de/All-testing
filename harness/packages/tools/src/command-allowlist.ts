/**
 * Declarative allowlist for externally executed commands.
 *
 * The policy is data, not code, so a host can load it from configuration and
 * so it can be inspected and tested without executing anything.
 */

export type CommandDenialCode =
  | "command-not-allowed"
  | "invalid-command"
  | "subcommand-required"
  | "subcommand-not-allowed"
  | "option-not-allowed"
  | "option-value-missing"
  | "invalid-argument"
  | "too-many-arguments"
  | "operand-not-allowed";

const DENIAL_MARKER: unique symbol = Symbol("zet-harness.command-denial");

export class CommandDenialError extends Error {
  readonly code: CommandDenialCode;

  constructor(code: CommandDenialCode, message: string) {
    super(message);
    this.name = "CommandDenialError";
    this.code = code;
    Object.defineProperty(this, DENIAL_MARKER, { value: true, enumerable: false });
  }
}

export function isCommandDenialError(value: unknown): value is CommandDenialError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[DENIAL_MARKER] === true
  );
}

export interface AllowedCommandSpec {
  /** Executable name with no path separators, for example `git`. */
  readonly command: string;
  /** When present, the first argument must be one of these. */
  readonly subcommands?: readonly string[];
  /** Exact option tokens permitted, for example `--porcelain`. */
  readonly allowedOptions?: readonly string[];
  /** Options that consume the following argument as their value. */
  readonly optionsWithValues?: readonly string[];
  /**
   * Permit path operands.
   *
   * Operands are contained against the workspace root by the supplied
   * resolver; a command that needs no file arguments should leave this false.
   */
  readonly allowPathOperands?: boolean;
  readonly maxArguments?: number;
  /**
   * Declares that nothing this spec permits changes external state.
   *
   * Defaults to false. `shell.run` derives its manifest effect class from the
   * whole allowlist, so one non-read-only entry makes the tool an external
   * write for scheduling and recovery purposes.
   */
  readonly readOnly?: boolean;
}

const DEFAULT_MAX_ARGUMENTS = 32;
const MAX_ARGUMENT_LENGTH = 4_096;

/**
 * Characters permitted in an option's value.
 *
 * Deliberately narrow. An option value is never handed to a shell, but keeping
 * it to this set means a value cannot impersonate another option or smuggle
 * newlines into a command that parses its own input.
 */
const SAFE_OPTION_VALUE = /^[\w.,:@=+/\\-]{1,256}$/u;

export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ValidateCommandOptions {
  /**
   * Contain a path operand against the workspace root.
   *
   * Required when a spec sets `allowPathOperands`. It must throw when the path
   * escapes the root; returning a value is treated as acceptance.
   */
  readonly resolveOperand?: (value: string) => string;
}

function isOptionToken(value: string): boolean {
  return value.startsWith("-") && value !== "-" && value !== "--";
}

/**
 * Validate one command invocation against the allowlist.
 *
 * The policy is default-deny at every level: an unknown command, an unlisted
 * subcommand, and an unlisted option are all refused. Strict option allowlisting
 * is not defensive excess — several common tools accept options that execute
 * arbitrary programs (`git -c core.sshCommand=...`, `--upload-pack=...`) or
 * write to arbitrary paths, so permitting unknown options would hand back
 * everything the allowlist was meant to withhold.
 */
export function validateCommandInvocation(
  allowlist: readonly AllowedCommandSpec[],
  invocation: CommandInvocation,
  options: ValidateCommandOptions = {},
): CommandInvocation {
  const { command, args } = invocation;

  if (typeof command !== "string" || command.length === 0) {
    throw new CommandDenialError("invalid-command", "Command must be a non-empty string.");
  }
  if (/[\\/]/u.test(command) || command.includes("..")) {
    // A path would let the caller choose an executable rather than name one.
    throw new CommandDenialError("invalid-command", "Command must not contain a path.");
  }
  if (command.includes("\0")) {
    throw new CommandDenialError("invalid-command", "Command must not contain a NUL byte.");
  }

  const folded = process.platform === "win32" ? command.toLowerCase() : command;
  const spec = allowlist.find(
    (entry) =>
      (process.platform === "win32" ? entry.command.toLowerCase() : entry.command) === folded,
  );
  if (spec === undefined) {
    throw new CommandDenialError("command-not-allowed", `Command '${command}' is not allowed.`);
  }

  if (!Array.isArray(args)) {
    throw new CommandDenialError("invalid-argument", "Arguments must be an array.");
  }

  // `Array.isArray` widens a readonly array to `any[]`, which would silently
  // disable type checking for everything below. Re-type as unknown and prove
  // each entry is a string instead.
  const rawArgs: readonly unknown[] = args;

  const maxArguments = spec.maxArguments ?? DEFAULT_MAX_ARGUMENTS;
  if (rawArgs.length > maxArguments) {
    throw new CommandDenialError(
      "too-many-arguments",
      `At most ${String(maxArguments)} arguments are allowed.`,
    );
  }

  const checkedArgs: string[] = [];
  for (const arg of rawArgs) {
    if (typeof arg !== "string") {
      throw new CommandDenialError("invalid-argument", "Every argument must be a string.");
    }
    if (arg.includes("\0")) {
      throw new CommandDenialError("invalid-argument", "Arguments must not contain a NUL byte.");
    }
    if (arg.length > MAX_ARGUMENT_LENGTH) {
      throw new CommandDenialError("invalid-argument", "Argument exceeds the length limit.");
    }
    checkedArgs.push(arg);
  }

  const allowedOptions = new Set(spec.allowedOptions ?? []);
  const optionsWithValues = new Set(spec.optionsWithValues ?? []);
  const validated: string[] = [];
  let index = 0;

  if (spec.subcommands !== undefined) {
    const first = checkedArgs[0];
    if (first === undefined) {
      throw new CommandDenialError(
        "subcommand-required",
        `Command '${command}' requires a subcommand.`,
      );
    }
    if (!spec.subcommands.includes(first)) {
      throw new CommandDenialError(
        "subcommand-not-allowed",
        `Subcommand '${first}' is not allowed for '${command}'.`,
      );
    }
    validated.push(first);
    index = 1;
  }

  let operandsOnly = false;

  for (; index < checkedArgs.length; index += 1) {
    const arg = checkedArgs[index];
    if (arg === undefined) continue;

    if (arg === "--") {
      // Everything after the separator is an operand, never an option.
      operandsOnly = true;
      validated.push(arg);
      continue;
    }

    if (!operandsOnly && isOptionToken(arg)) {
      // `--opt=value` is validated as the option `--opt` plus its value.
      const separator = arg.indexOf("=");
      const name = separator === -1 ? arg : arg.slice(0, separator);
      const inlineValue = separator === -1 ? undefined : arg.slice(separator + 1);

      if (!allowedOptions.has(name) && !optionsWithValues.has(name)) {
        throw new CommandDenialError(
          "option-not-allowed",
          `Option '${name}' is not allowed for '${command}'.`,
        );
      }

      if (inlineValue !== undefined) {
        if (!optionsWithValues.has(name)) {
          throw new CommandDenialError(
            "option-not-allowed",
            `Option '${name}' does not take a value.`,
          );
        }
        if (!SAFE_OPTION_VALUE.test(inlineValue)) {
          throw new CommandDenialError("invalid-argument", `Value for '${name}' is not permitted.`);
        }
        validated.push(arg);
        continue;
      }

      validated.push(arg);

      if (optionsWithValues.has(name)) {
        const value = checkedArgs[index + 1];
        if (value === undefined) {
          throw new CommandDenialError(
            "option-value-missing",
            `Option '${name}' requires a value.`,
          );
        }
        if (!SAFE_OPTION_VALUE.test(value)) {
          throw new CommandDenialError("invalid-argument", `Value for '${name}' is not permitted.`);
        }
        validated.push(value);
        index += 1;
      }
      continue;
    }

    if (spec.allowPathOperands !== true) {
      throw new CommandDenialError(
        "operand-not-allowed",
        `Command '${command}' does not accept file arguments.`,
      );
    }
    if (options.resolveOperand === undefined) {
      throw new CommandDenialError(
        "operand-not-allowed",
        "No workspace resolver was supplied for path operands.",
      );
    }

    // Containment is delegated so operands obey exactly the same rules as
    // every other path the harness accepts. A throw here is a refusal.
    options.resolveOperand(arg);
    validated.push(arg);
  }

  return Object.freeze({ command, args: Object.freeze(validated) });
}

/**
 * Read-only presets a host may opt into.
 *
 * These are **not** enabled by default. `shell.run` denies everything until a
 * host supplies an allowlist, because installing a tool and authorizing what it
 * may do are separate decisions.
 */
export const READ_ONLY_GIT_COMMAND: AllowedCommandSpec = Object.freeze({
  command: "git",
  subcommands: Object.freeze([
    "status",
    "diff",
    "log",
    "show",
    "rev-parse",
    "ls-files",
    "branch",
    "blame",
    "describe",
  ]),
  allowedOptions: Object.freeze([
    "--porcelain",
    "--short",
    "--stat",
    "--numstat",
    "--name-only",
    "--name-status",
    "--oneline",
    "--no-color",
    "--cached",
    "--staged",
    "--abbrev-ref",
    "--show-toplevel",
    "--is-inside-work-tree",
    "--list",
    "-s",
  ]),
  optionsWithValues: Object.freeze(["-n", "--max-count"]),
  allowPathOperands: true,
  maxArguments: 16,
  readOnly: true,
});

export const READ_ONLY_COMMAND_PRESETS: readonly AllowedCommandSpec[] = Object.freeze([
  READ_ONLY_GIT_COMMAND,
]);
