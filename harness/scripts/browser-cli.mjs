#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseAgentCommand } from "./agent-cli.mjs";

const HELP = `Zet scoped native browser
Usage: npm run browser -- <status|arm|execute|approve|deny|stop> [options]
Options: --runtime http://127.0.0.1:3211 --task TEXT --domains example.com,example.org --consent yes
         --generation N --input JSON --id APPROVAL_ID
Arm requires explicit task/domain consent. Input actions wait for separate approve/deny in another terminal.
Fresh browser context; no user profile, screenshot transmission, or model execution.`;

export function parseBrowserCommand(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  const allowed = new Set(["runtime", "task", "domains", "consent", "generation", "input", "id"]);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.startsWith("--") ? rest[i].slice(2) : "";
    const value = rest[i + 1];
    if (!allowed.has(key) || key in options || !value || value.startsWith("--"))
      throw new Error("Unknown, repeated or missing option.");
    options[key] = value;
  }
  const origin = parseAgentCommand([
    "status",
    ...(options.runtime ? ["--runtime", options.runtime] : []),
  ]).origin;
  const generation = () => {
    if (!/^\d+$/u.test(options.generation ?? ""))
      throw new Error("--generation must be an integer.");
    const value = Number(options.generation);
    if (!Number.isSafeInteger(value)) throw new Error("Invalid generation.");
    return value;
  };
  let body;
  if (command === "arm") {
    if (options.consent !== "yes" || !options.task || !options.domains)
      throw new Error("Arm requires --task, --domains and explicit --consent yes.");
    body = {
      action: "arm",
      params: {
        task: options.task,
        domains: options.domains.split(","),
        minutes: 2,
        maxActions: 30,
        confirm: true,
      },
    };
  } else if (command === "execute") {
    if (!options.input) throw new Error("--input JSON is required.");
    const input = JSON.parse(options.input);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid input.");
    body = { action: "execute", params: { generation: generation(), input } };
  } else if (command === "approve" || command === "deny") {
    if (!options.id) throw new Error("--id is required.");
    body = {
      action: "approval/respond",
      params: {
        id: options.id,
        generation: generation(),
        decision: command === "approve" ? "approved" : "rejected",
      },
    };
  } else if (command === "stop") body = { action: "stop", params: {} };
  else if (!["help", "status"].includes(command)) throw new Error("Unknown command.");
  return { command, origin, body };
}

export async function runBrowserCommand(argv, request = fetch) {
  const parsed = parseBrowserCommand(argv);
  if (parsed.command === "help") return HELP;
  const headers = {};
  if (parsed.body) {
    const sessionResponse = await request(`${parsed.origin}/api/session`, {
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
      redirect: "error",
    });
    const session = await sessionResponse.json();
    if (!sessionResponse.ok || typeof session.csrfToken !== "string")
      throw new Error("Could not establish a local runtime session.");
    headers["content-type"] = "application/json";
    headers["x-zet-csrf"] = session.csrfToken;
  }
  const response = await request(`${parsed.origin}/api/browser`, {
    method: parsed.body ? "POST" : "GET",
    headers,
    ...(parsed.body ? { body: JSON.stringify(parsed.body) } : {}),
    signal: AbortSignal.timeout(45_000),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Browser request refused (${response.status}).`);
  const payload = await response.json();
  return JSON.stringify(
    payload && typeof payload === "object" && "result" in payload ? payload.result : payload,
    null,
    2,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(await runBrowserCommand(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Browser request failed.");
    process.exitCode = 1;
  }
}
