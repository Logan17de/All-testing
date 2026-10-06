import { pathToFileURL } from "node:url";

const usage = `Review-only Windows sandbox proposal (no setup or execution).
Usage: npm run windows:sandbox-plan -- --source C:\\Projects\\example --private-state C:\\ZetState\\runtime.db --work-area C:\\ZetScratch
Repeat --private-state for each private state path. Paths are lexical candidates;
native identity, access, network and setup acceptance remain mandatory.
No credentials, administrator commands or apply mode are accepted.`;

export function parseWindowsSandboxPlanArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const input = { backend: "dedicated-user", privateStatePaths: [] };
  const names = { "--source": "sourceRoot", "--work-area": "disposableWorkArea" };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (typeof value !== "string" || value.startsWith("--"))
      throw new Error("A sandbox proposal requires explicit path arguments.");
    if (key === "--private-state") {
      input.privateStatePaths.push(value);
    } else if (Object.hasOwn(names, key) && !Object.hasOwn(input, names[key])) {
      input[names[key]] = value;
    } else {
      throw new Error("Unknown or duplicate sandbox proposal option.");
    }
  }
  if (!input.sourceRoot || !input.disposableWorkArea || !input.privateStatePaths.length)
    throw new Error("Source, private state and disposable work area are required.");
  return input;
}

export async function runWindowsSandboxPlan(args) {
  const input = parseWindowsSandboxPlanArguments(args);
  if (input.help) return usage;
  const { createWindowsSandboxPreparationPlan } =
    await import("../apps/runtime/dist/runtime-windows-sandbox-plan.js");
  return JSON.stringify(createWindowsSandboxPreparationPlan(input), null, 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(await runWindowsSandboxPlan(process.argv.slice(2)));
  } catch {
    console.error("Windows sandbox proposal refused. Check --help and build the runtime first.");
    process.exitCode = 1;
  }
}
