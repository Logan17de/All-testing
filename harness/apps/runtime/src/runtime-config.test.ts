import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HARNESS_CONFIG_FILENAME,
  readHarnessConfig,
  resolveRuntimeSettings,
  validateHarnessConfig,
} from "./runtime-config.js";
import {
  DEFAULT_SETUP_ANSWERS,
  SETUP_QUESTIONS,
  collectSetupAnswers,
  configFrom,
  parseSetupArguments,
  runSetup,
  type SetupOptions,
  type SetupQuestion,
} from "./setup-cli.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zet-config-"));
  roots.push(root);
  return root;
}

/** The options of a command line that was meant to be a setup. */
function setupOptions(argv: readonly string[], root: string): SetupOptions {
  const command = parseSetupArguments(argv, root);
  if (command.kind !== "setup") throw new Error(`Expected a setup command: ${argv.join(" ")}`);
  return command.options;
}

/** Answers a person would type, in the order the wizard asks. */
function answering(replies: readonly string[]): {
  readonly ask: (question: SetupQuestion) => Promise<string>;
  readonly asked: string[];
} {
  const asked: string[] = [];
  let index = 0;
  return {
    asked,
    ask: (question) => {
      asked.push(question.key);
      const reply = replies[index] ?? "";
      index += 1;
      return Promise.resolve(reply);
    },
  };
}

describe("reading a harness config (11.2)", () => {
  it("keeps what it understands and says what it ignored", () => {
    const { config, defects } = validateHarnessConfig({
      runtime: { port: 4000, databasePath: "data/db.sqlite", pluginsDirectory: "plugins" },
      plugins: { install: { npm: true, git: false } },
    });
    expect(config).toEqual({
      runtime: { port: 4000, databasePath: "data/db.sqlite", pluginsDirectory: "plugins" },
      plugins: { install: { npm: true, git: false } },
    });
    expect(defects).toEqual([]);

    const odd = validateHarnessConfig({
      runtime: { port: 70_000, databasePath: 5 },
      plugins: { install: { npm: "yes" } },
    });
    expect(odd.config).toEqual({});
    expect(odd.defects).toHaveLength(3);
    expect(odd.defects[0]).toContain("runtime.port");

    expect(validateHarnessConfig(["not", "an", "object"]).defects[0]).toContain(
      HARNESS_CONFIG_FILENAME,
    );
  });

  it("treats a missing file as no configuration, and a broken one as none plus a defect", async () => {
    const root = await workspace();
    const missing = await readHarnessConfig(join(root, HARNESS_CONFIG_FILENAME));
    expect(missing).toMatchObject({ present: false, config: {}, defects: [] });

    await writeFile(join(root, HARNESS_CONFIG_FILENAME), "{ not json", "utf8");
    const broken = await readHarnessConfig(join(root, HARNESS_CONFIG_FILENAME));
    expect(broken.present).toBe(true);
    expect(broken.config).toEqual({});
    expect(broken.defects[0]).toContain("not valid JSON");
  });
});

describe("settling where settings come from (11.2)", () => {
  it("prefers the environment, then the file, then the default", () => {
    const config = {
      runtime: { port: 4000, databasePath: "from-file.sqlite" },
      plugins: { install: { npm: true } },
    };
    const settings = resolveRuntimeSettings(
      config,
      { ZET_RUNTIME_PORT: "5000", ZET_RUNTIME_ALLOW_GIT_INSTALL: "true" },
      "/harness",
    );

    expect(settings.port).toBe(5000);
    expect(settings.sources["port"]).toBe("environment");
    expect(settings.databasePath).toContain("from-file.sqlite");
    expect(settings.sources["databasePath"]).toBe("file");
    expect(settings.sources["pluginsDirectory"]).toBe("default");
    // The file allowed npm; the environment allowed git for this run only.
    expect(settings.install).toEqual({ npm: true, git: true });
    expect(settings.sources["install.git"]).toBe("environment");
  });

  it("lets the environment ask for any free port", () => {
    const settings = resolveRuntimeSettings(
      { runtime: { port: 4000 } },
      { ZET_RUNTIME_PORT: "0" },
      "/harness",
    );
    expect(settings.port).toBe(0);
    expect(settings.sources["port"]).toBe("environment");
  });

  it("makes every path absolute, and ignores an environment value it cannot read", () => {
    const settings = resolveRuntimeSettings({}, { ZET_RUNTIME_PORT: "not-a-port" }, "/harness");
    expect(settings.port).toBe(3211);
    expect(settings.sources["port"]).toBe("default");
    expect(isAbsolute(settings.databasePath)).toBe(true);
    expect(isAbsolute(settings.pluginsDirectory)).toBe(true);
    // Installing plugins is off until something says otherwise.
    expect(settings.install).toEqual({ npm: false, git: false });
  });
});

describe("the setup wizard (11.2)", () => {
  it("asks for what the command line did not settle, and writes the answers", async () => {
    const root = await workspace();
    // The port is a flag, so the answers start at the first question that is left.
    const { ask, asked } = answering(["data/mine.sqlite", "", "y", "n"]);

    const result = await runSetup(setupOptions(["--port", "4100"], root), ask);

    expect(result.ok).toBe(true);
    // The port came from a flag, so it was never asked about.
    expect(asked).not.toContain("port");
    expect(asked).toEqual([
      "databasePath",
      "pluginsDirectory",
      "allowNpmInstall",
      "allowGitInstall",
    ]);
    const written = JSON.parse(
      await readFile(join(root, HARNESS_CONFIG_FILENAME), "utf8"),
    ) as Record<string, unknown>;
    expect(written).toEqual({
      runtime: { port: 4100, databasePath: "data/mine.sqlite", pluginsDirectory: "plugins" },
      plugins: { install: { npm: true, git: false } },
    });
    expect(result.text).toContain("plugin installs:  npm");
  });

  it("asks nothing when told to take the defaults", async () => {
    const root = await workspace();
    const { ask, asked } = answering([]);

    const result = await runSetup(setupOptions(["--yes"], root), ask);

    expect(asked).toEqual([]);
    expect(result.ok).toBe(true);
    expect(JSON.parse(await readFile(join(root, HARNESS_CONFIG_FILENAME), "utf8"))).toEqual(
      configFrom(DEFAULT_SETUP_ANSWERS),
    );
    // Installing plugins stays off unless someone says otherwise.
    expect(result.text).toContain("plugin installs:  off");
  });

  it("keeps a configuration that is already there unless told to replace it", async () => {
    const root = await workspace();
    const options = setupOptions(["--yes"], root);
    await runSetup(options, answering([]).ask);

    const again = await runSetup(options, answering([]).ask);
    expect(again.ok).toBe(false);
    expect(again.text).toContain("--force");

    const replaced = await runSetup(
      setupOptions(["--yes", "--force", "--port", "4242"], root),
      answering([]).ask,
    );
    expect(replaced.ok).toBe(true);
    const written = JSON.parse(await readFile(join(root, HARNESS_CONFIG_FILENAME), "utf8")) as {
      readonly runtime: { readonly port: number };
    };
    expect(written.runtime.port).toBe(4242);
  });

  it("explains itself, and refuses a port that is not one", async () => {
    const root = await workspace();
    expect(parseSetupArguments(["--help"], root)).toEqual({ kind: "help" });
    expect(parseSetupArguments(["--port", "-1"], root)).toMatchObject({
      kind: "help",
      reason: "--port must be a whole number between 1 and 65535.",
    });
    // Every question the wizard asks has a default, so nobody has to answer any of them.
    expect(SETUP_QUESTIONS.every((question) => question.fallback.length > 0)).toBe(true);
    expect(
      await collectSetupAnswers(
        { root, interactive: false, force: false, given: {}, json: false },
        answering([]).ask,
      ),
    ).toEqual(DEFAULT_SETUP_ANSWERS);
  });
});
