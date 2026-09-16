/**
 * Set a harness up.
 *
 * A first run works with no configuration at all, so this is a convenience, not a
 * gate: it asks a handful of questions, shows what it will write, and writes one
 * `harness.config.json`. Answering nothing accepts the defaults.
 *
 * Installing plugins from npm or Git is off unless someone turns it on here, and the
 * wizard says plainly what that allows, because it is the one answer that lets the
 * harness fetch and run code it did not have before.
 */
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  DEFAULT_DATABASE_PATH,
  DEFAULT_PLUGINS_PATH,
  DEFAULT_RUNTIME_PORT,
  HARNESS_CONFIG_FILENAME,
  readHarnessConfig,
  type HarnessConfigFile,
} from "./runtime-config.js";

export interface SetupAnswers {
  readonly port: number;
  readonly databasePath: string;
  readonly pluginsDirectory: string;
  readonly allowNpmInstall: boolean;
  readonly allowGitInstall: boolean;
}

export interface SetupQuestion {
  readonly key: keyof SetupAnswers;
  readonly prompt: string;
  readonly kind: "number" | "path" | "yes-no";
  readonly fallback: string;
  /** Said once, before the question, when the answer deserves a word of warning. */
  readonly note?: string;
}

export const SETUP_QUESTIONS: readonly SetupQuestion[] = Object.freeze([
  Object.freeze({
    key: "port",
    prompt: "Which port should the runtime listen on?",
    kind: "number",
    fallback: String(DEFAULT_RUNTIME_PORT),
  }),
  Object.freeze({
    key: "databasePath",
    prompt: "Where should the database live?",
    kind: "path",
    fallback: DEFAULT_DATABASE_PATH,
  }),
  Object.freeze({
    key: "pluginsDirectory",
    prompt: "Which folder holds plugins?",
    kind: "path",
    fallback: DEFAULT_PLUGINS_PATH,
  }),
  Object.freeze({
    key: "allowNpmInstall",
    prompt: "Allow installing plugins from npm?",
    kind: "yes-no",
    fallback: "no",
    note: "This lets the harness download and keep code it did not have before. An installed plugin is still disabled until you enable it.",
  }),
  Object.freeze({
    key: "allowGitInstall",
    prompt: "Allow installing plugins from a Git repository?",
    kind: "yes-no",
    fallback: "no",
  }),
] as const);

export const DEFAULT_SETUP_ANSWERS: SetupAnswers = Object.freeze({
  port: DEFAULT_RUNTIME_PORT,
  databasePath: DEFAULT_DATABASE_PATH,
  pluginsDirectory: DEFAULT_PLUGINS_PATH,
  allowNpmInstall: false,
  allowGitInstall: false,
});

export interface SetupOptions {
  /** Harness root; the config file is written here. */
  readonly root: string;
  /** Answer everything from flags and defaults, asking nothing. */
  readonly interactive: boolean;
  /** Overwrite a config file that is already there. */
  readonly force: boolean;
  /** Answers given on the command line, which are never asked about again. */
  readonly given: Partial<SetupAnswers>;
  readonly json: boolean;
}

export type SetupCommand =
  | { readonly kind: "setup"; readonly options: SetupOptions }
  | { readonly kind: "help"; readonly reason?: string };

export const SETUP_CLI_USAGE = `Set up a harness.

  setup [--yes] [--force] [--json]
        [--port <number>] [--database <path>] [--plugins <path>]
        [--allow-npm-install] [--allow-git-install]

Writes ${HARNESS_CONFIG_FILENAME} in the harness folder. A harness runs without it,
and an environment variable always wins over what the file says.

  --yes    accept the defaults and anything given as a flag, asking nothing
  --force  replace a configuration that is already there
`;

function optionOf(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

/** Read the command line. Nothing here touches the disk or asks anything. */
export function parseSetupArguments(argv: readonly string[], root: string): SetupCommand {
  if (argv.includes("--help") || argv[0] === "help") return { kind: "help" };
  const given: {
    port?: number;
    databasePath?: string;
    pluginsDirectory?: string;
    allowNpmInstall?: boolean;
    allowGitInstall?: boolean;
  } = {};

  const port = optionOf(argv, "port");
  if (port !== undefined) {
    const parsed = Number(port);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
      return { kind: "help", reason: "--port must be a whole number between 1 and 65535." };
    }
    given.port = parsed;
  }
  const database = optionOf(argv, "database");
  if (database !== undefined) given.databasePath = database;
  const plugins = optionOf(argv, "plugins");
  if (plugins !== undefined) given.pluginsDirectory = plugins;
  if (argv.includes("--allow-npm-install")) given.allowNpmInstall = true;
  if (argv.includes("--allow-git-install")) given.allowGitInstall = true;

  return {
    kind: "setup",
    options: {
      root,
      interactive: !argv.includes("--yes"),
      force: argv.includes("--force"),
      given,
      json: argv.includes("--json"),
    },
  };
}

/** The file the answers describe. */
export function configFrom(answers: SetupAnswers): HarnessConfigFile {
  return {
    runtime: {
      port: answers.port,
      databasePath: answers.databasePath,
      pluginsDirectory: answers.pluginsDirectory,
    },
    plugins: { install: { npm: answers.allowNpmInstall, git: answers.allowGitInstall } },
  };
}

/** How a question is answered: by flag, by a person, or by the default. */
export type SetupAsk = (question: SetupQuestion) => Promise<string>;

function answerOf(question: SetupQuestion, raw: string): number | string | boolean {
  const value = raw.trim();
  if (question.kind === "yes-no") {
    if (value.length === 0) return question.fallback === "yes";
    return ["y", "yes", "true", "1"].includes(value.toLowerCase());
  }
  if (question.kind === "number") {
    const parsed = Number(value.length === 0 ? question.fallback : value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65_535
      ? parsed
      : Number(question.fallback);
  }
  return value.length === 0 ? question.fallback : value;
}

/** Collect the answers, asking only what the command line did not settle. */
export async function collectSetupAnswers(
  options: SetupOptions,
  ask: SetupAsk,
): Promise<SetupAnswers> {
  const answers: Record<string, unknown> = { ...DEFAULT_SETUP_ANSWERS, ...options.given };
  if (!options.interactive) return Object.freeze(answers) as unknown as SetupAnswers;
  for (const question of SETUP_QUESTIONS) {
    if (options.given[question.key] !== undefined) continue;
    answers[question.key] = answerOf(question, await ask(question));
  }
  return Object.freeze(answers) as unknown as SetupAnswers;
}

export interface SetupResult {
  readonly text: string;
  readonly data: Record<string, unknown>;
  readonly ok: boolean;
}

/** Write the configuration, unless one is already there and nobody said to replace it. */
export async function runSetup(options: SetupOptions, ask: SetupAsk): Promise<SetupResult> {
  const configPath = join(options.root, HARNESS_CONFIG_FILENAME);
  const existing = await readHarnessConfig(configPath);
  if (existing.present && !options.force) {
    return {
      ok: false,
      text: `${configPath} already exists. Run with --force to replace it.`,
      data: { ok: false, path: configPath, reason: "already-configured" },
    };
  }

  const answers = await collectSetupAnswers(options, ask);
  const config = configFrom(answers);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const absolute = (value: string): string =>
    isAbsolute(value) ? value : resolve(options.root, value);
  const installs = [
    answers.allowNpmInstall ? "npm" : undefined,
    answers.allowGitInstall ? "git" : undefined,
  ].filter((entry): entry is string => entry !== undefined);

  return {
    ok: true,
    text: [
      `Wrote ${configPath}`,
      `  runtime port:     ${String(answers.port)}`,
      `  database:         ${absolute(answers.databasePath)}`,
      `  plugins folder:   ${absolute(answers.pluginsDirectory)}`,
      `  plugin installs:  ${installs.length === 0 ? "off" : installs.join(" and ")}`,
      "",
      "An environment variable still wins over this file, and a plugin is enabled only",
      "in the plugins config, never by installing it.",
      "",
      "Start the harness with: npm start",
    ].join("\n"),
    data: { ok: true, path: configPath, config },
  };
}

/** Ask a person, when there is a person to ask. */
async function ttyAsk(question: SetupQuestion): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (question.note !== undefined) console.log(`  ${question.note}`);
    return await rl.question(`${question.prompt} [${question.fallback}] `);
  } finally {
    rl.close();
  }
}

/** The command line itself: parse, ask, write, and set an exit code. */
export async function main(argv: readonly string[], root: string): Promise<number> {
  const command = parseSetupArguments(argv, root);
  if (command.kind === "help") {
    console.log(
      command.reason === undefined ? SETUP_CLI_USAGE : `${command.reason}\n\n${SETUP_CLI_USAGE}`,
    );
    return command.reason === undefined ? 0 : 2;
  }
  // Without a terminal there is nobody to ask, so the defaults answer for themselves.
  const options: SetupOptions = process.stdin.isTTY
    ? command.options
    : { ...command.options, interactive: false };
  try {
    const result = await runSetup(options, ttyAsk);
    console.log(options.json ? JSON.stringify(result.data, null, 2) : result.text);
    return result.ok ? 0 : 1;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
