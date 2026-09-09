import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runtimeReportPath = resolve(root, "tmp/baseline/runtime.json");
const checkerPath = resolve(root, "scripts/check-lightweight-baseline.ts");
const runtimePrefix = "ZET_BASELINE_RUNTIME ";

interface CommandResult {
  stdout: string;
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let stdout = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout });
        return;
      }
      rejectPromise(
        new Error(
          `Command ${JSON.stringify(command)} failed with code ${String(code)} signal ${String(signal)}.`,
        ),
      );
    });
  });
}

async function main(): Promise<void> {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined || npmCli.length === 0) {
    throw new Error("npm_execpath is required to run the cross-platform baseline command.");
  }

  const baseline = await runCommand(process.execPath, [npmCli, "run", "baseline"]);
  const runtimeLine = baseline.stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith(runtimePrefix));
  if (runtimeLine === undefined) {
    throw new Error("The lightweight baseline did not emit ZET_BASELINE_RUNTIME output.");
  }

  const runtime = JSON.parse(runtimeLine.slice(runtimePrefix.length)) as unknown;
  mkdirSync(dirname(runtimeReportPath), { recursive: true });
  writeFileSync(runtimeReportPath, `${JSON.stringify(runtime, null, 2)}\n`);

  await runCommand(process.execPath, ["--experimental-strip-types", checkerPath]);
}

await main();
