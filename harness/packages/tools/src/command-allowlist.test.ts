import { describe, expect, it } from "vitest";

import {
  READ_ONLY_COMMAND_PRESETS,
  READ_ONLY_GIT_COMMAND,
  CommandDenialError,
  isCommandDenialError,
  validateCommandInvocation,
  type AllowedCommandSpec,
} from "./command-allowlist.js";

const ECHO: AllowedCommandSpec = Object.freeze({
  command: "echoish",
  allowedOptions: Object.freeze(["--quiet"]),
  optionsWithValues: Object.freeze(["--count"]),
  allowPathOperands: false,
  maxArguments: 8,
});

const acceptOperand = (value: string): string => value;

function denial(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    if (isCommandDenialError(error)) return error.code;
    throw error;
  }
  throw new Error("Expected the invocation to be refused.");
}

describe("command identity", () => {
  it("refuses a command that is not on the list", () => {
    expect(denial(() => validateCommandInvocation([ECHO], { command: "curl", args: [] }))).toBe(
      "command-not-allowed",
    );
  });

  it("refuses an empty allowlist outright", () => {
    expect(denial(() => validateCommandInvocation([], { command: "git", args: ["status"] }))).toBe(
      "command-not-allowed",
    );
  });

  it("refuses a command given as a path", () => {
    expect(
      denial(() => validateCommandInvocation([ECHO], { command: "/usr/bin/echoish", args: [] })),
    ).toBe("invalid-command");
  });

  it("refuses a command containing traversal", () => {
    expect(
      denial(() => validateCommandInvocation([ECHO], { command: "..echoish", args: [] })),
    ).toBe("invalid-command");
  });

  it("refuses a command containing a NUL byte", () => {
    expect(
      denial(() => validateCommandInvocation([ECHO], { command: "echoish\0", args: [] })),
    ).toBe("invalid-command");
  });

  it("refuses an empty command", () => {
    expect(denial(() => validateCommandInvocation([ECHO], { command: "", args: [] }))).toBe(
      "invalid-command",
    );
  });

  it("accepts a listed command with no arguments", () => {
    const result = validateCommandInvocation([ECHO], { command: "echoish", args: [] });
    expect(result.args).toEqual([]);
  });
});

describe("option handling", () => {
  it("accepts a listed option", () => {
    const result = validateCommandInvocation([ECHO], { command: "echoish", args: ["--quiet"] });
    expect(result.args).toEqual(["--quiet"]);
  });

  it("refuses an unlisted option", () => {
    expect(
      denial(() => validateCommandInvocation([ECHO], { command: "echoish", args: ["--evil"] })),
    ).toBe("option-not-allowed");
  });

  it("refuses an unlisted short option", () => {
    expect(
      denial(() => validateCommandInvocation([ECHO], { command: "echoish", args: ["-x"] })),
    ).toBe("option-not-allowed");
  });

  it("accepts a value option written separately", () => {
    const result = validateCommandInvocation([ECHO], {
      command: "echoish",
      args: ["--count", "5"],
    });
    expect(result.args).toEqual(["--count", "5"]);
  });

  it("accepts a value option written inline", () => {
    const result = validateCommandInvocation([ECHO], { command: "echoish", args: ["--count=5"] });
    expect(result.args).toEqual(["--count=5"]);
  });

  it("refuses a value option with no value", () => {
    expect(
      denial(() => validateCommandInvocation([ECHO], { command: "echoish", args: ["--count"] })),
    ).toBe("option-value-missing");
  });

  it("refuses a value containing a newline", () => {
    expect(
      denial(() =>
        validateCommandInvocation([ECHO], { command: "echoish", args: ["--count", "5\nrm -rf /"] }),
      ),
    ).toBe("invalid-argument");
  });

  it("refuses a value with shell metacharacters", () => {
    expect(
      denial(() =>
        validateCommandInvocation([ECHO], { command: "echoish", args: ["--count=$(whoami)"] }),
      ),
    ).toBe("invalid-argument");
  });

  it("refuses attaching a value to an option that takes none", () => {
    expect(
      denial(() => validateCommandInvocation([ECHO], { command: "echoish", args: ["--quiet=x"] })),
    ).toBe("option-not-allowed");
  });

  it("does not let a value option's value be consumed as an option", () => {
    // `--quiet` here is the value of --count, not a second option.
    const result = validateCommandInvocation([ECHO], {
      command: "echoish",
      args: ["--count", "--quiet"],
    });
    expect(result.args).toEqual(["--count", "--quiet"]);
  });
});

describe("operands", () => {
  it("refuses a file argument when the command takes none", () => {
    expect(
      denial(() => validateCommandInvocation([ECHO], { command: "echoish", args: ["file.txt"] })),
    ).toBe("operand-not-allowed");
  });

  it("accepts a contained operand when the command allows them", () => {
    const result = validateCommandInvocation(
      [READ_ONLY_GIT_COMMAND],
      { command: "git", args: ["diff", "src/index.ts"] },
      { resolveOperand: acceptOperand },
    );
    expect(result.args).toEqual(["diff", "src/index.ts"]);
  });

  it("propagates a containment refusal from the resolver", () => {
    expect(() =>
      validateCommandInvocation(
        [READ_ONLY_GIT_COMMAND],
        { command: "git", args: ["diff", "../../etc/passwd"] },
        {
          resolveOperand: () => {
            throw new CommandDenialError("operand-not-allowed", "escapes root");
          },
        },
      ),
    ).toThrow(CommandDenialError);
  });

  it("refuses operands when no resolver is supplied", () => {
    expect(
      denial(() =>
        validateCommandInvocation([READ_ONLY_GIT_COMMAND], {
          command: "git",
          args: ["diff", "src/index.ts"],
        }),
      ),
    ).toBe("operand-not-allowed");
  });

  it("treats everything after -- as an operand", () => {
    const result = validateCommandInvocation(
      [READ_ONLY_GIT_COMMAND],
      { command: "git", args: ["diff", "--", "src/index.ts"] },
      { resolveOperand: acceptOperand },
    );
    expect(result.args).toEqual(["diff", "--", "src/index.ts"]);
  });

  it("still contains an operand that looks like an option after --", () => {
    let seen: string | undefined;
    validateCommandInvocation(
      [READ_ONLY_GIT_COMMAND],
      { command: "git", args: ["diff", "--", "--not-an-option"] },
      {
        resolveOperand: (value) => {
          seen = value;
          return value;
        },
      },
    );
    expect(seen).toBe("--not-an-option");
  });
});

describe("argument hygiene", () => {
  it("refuses a non-string argument", () => {
    expect(
      denial(() =>
        validateCommandInvocation([ECHO], {
          command: "echoish",
          args: [5 as unknown as string],
        }),
      ),
    ).toBe("invalid-argument");
  });

  it("refuses an argument containing a NUL byte", () => {
    expect(
      denial(() => validateCommandInvocation([ECHO], { command: "echoish", args: ["a\0b"] })),
    ).toBe("invalid-argument");
  });

  it("refuses more arguments than the spec permits", () => {
    expect(
      denial(() =>
        validateCommandInvocation([ECHO], {
          command: "echoish",
          args: Array.from({ length: 20 }, () => "--quiet"),
        }),
      ),
    ).toBe("too-many-arguments");
  });

  it("refuses an over-long argument", () => {
    expect(
      denial(() =>
        validateCommandInvocation([ECHO], { command: "echoish", args: ["x".repeat(5000)] }),
      ),
    ).toBe("invalid-argument");
  });
});

describe("subcommands", () => {
  it("requires a subcommand when the spec defines them", () => {
    expect(
      denial(() =>
        validateCommandInvocation([READ_ONLY_GIT_COMMAND], { command: "git", args: [] }),
      ),
    ).toBe("subcommand-required");
  });

  it("refuses an unlisted subcommand", () => {
    expect(
      denial(() =>
        validateCommandInvocation([READ_ONLY_GIT_COMMAND], { command: "git", args: ["push"] }),
      ),
    ).toBe("subcommand-not-allowed");
  });

  it("accepts a listed subcommand", () => {
    const result = validateCommandInvocation([READ_ONLY_GIT_COMMAND], {
      command: "git",
      args: ["status", "--porcelain"],
    });
    expect(result.args).toEqual(["status", "--porcelain"]);
  });
});

describe("known-dangerous git options stay refused", () => {
  // Each of these turns a read-only git invocation into arbitrary execution or
  // an arbitrary write, which is exactly what the allowlist exists to stop.
  it.each([
    ["-c", ["-c", "core.sshCommand=touch /tmp/pwned", "status"]],
    ["--upload-pack", ["log", "--upload-pack=touch /tmp/pwned"]],
    ["--exec", ["log", "--exec=sh"]],
    ["--output", ["diff", "--output=/etc/cron.d/pwned"]],
    ["--git-dir", ["--git-dir=/elsewhere", "status"]],
    ["--ext-diff", ["diff", "--ext-diff"]],
  ])("refuses %s", (_label, args) => {
    expect(
      denial(() =>
        validateCommandInvocation(
          [READ_ONLY_GIT_COMMAND],
          { command: "git", args },
          { resolveOperand: acceptOperand },
        ),
      ),
    ).toMatch(/option-not-allowed|subcommand-not-allowed/u);
  });

  it("refuses every write subcommand", () => {
    for (const subcommand of ["push", "commit", "reset", "checkout", "clean", "fetch", "clone"]) {
      expect(
        denial(() =>
          validateCommandInvocation([READ_ONLY_GIT_COMMAND], {
            command: "git",
            args: [subcommand],
          }),
        ),
      ).toBe("subcommand-not-allowed");
    }
  });
});

describe("presets", () => {
  it("ships git as the only read-only preset", () => {
    expect(READ_ONLY_COMMAND_PRESETS.map((spec) => spec.command)).toEqual(["git"]);
  });

  it("keeps the preset frozen", () => {
    expect(Object.isFrozen(READ_ONLY_GIT_COMMAND)).toBe(true);
  });
});

describe("error provenance", () => {
  it("recognizes a genuine denial", () => {
    expect(isCommandDenialError(new CommandDenialError("command-not-allowed", "x"))).toBe(true);
  });

  it("does not recognize a forged prototype", () => {
    expect(isCommandDenialError(Object.create(CommandDenialError.prototype) as unknown)).toBe(
      false,
    );
  });
});
