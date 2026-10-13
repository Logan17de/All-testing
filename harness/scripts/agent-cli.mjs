#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const HELP = `Zet native coding agent\nUsage: npm run agent -- <status|models|sessions|start|read|exec|cancel|archive|restore> [options]\nOptions: --runtime http://127.0.0.1:3211 --session ID --turn ID --model ID --prompt TEXT --title TEXT --cwd WORKSPACE_RELATIVE_DIRECTORY\nInstruction selection (exec only): --skill-mode full|catalog --skills NAME,NAME\nPer-turn opt-ins (exec only): --consent yes|no --subagents yes|no --browser yes|no --desktop yes|no --search yes|no\nAll opt-ins default to no. --consent yes allows mutation requests, never automatic approval; review exact pending requests in the UI. Browser and desktop require independently armed scopes; desktop screenshot transmission requires separate exact-destination consent; search requires configured authentication.\nSelect the workspace and configure inference in the local UI first.\nTool execution stays in the harness; this CLI never launches a provider CLI or grants approvals.`;

export function parseAgentCommand(argv) {
  const [command = "help", ...rest] = argv;
  const allowed = new Set([
    "runtime",
    "session",
    "turn",
    "model",
    "prompt",
    "title",
    "consent",
    "subagents",
    "browser",
    "desktop",
    "search",
    "cwd",
    "skill-mode",
    "skills",
  ]);
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const key = flag?.startsWith("--") ? flag.slice(2) : "";
    const value = rest[i + 1];
    if (
      !allowed.has(key) ||
      key in options ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    )
      throw new Error("Unknown, repeated or missing option.");
    options[key] = value;
  }
  if ("cwd" in options && command !== "exec")
    throw new Error("--cwd is an exec-only workspace-relative directory.");
  if (
    ("skill-mode" in options &&
      (command !== "exec" || !["full", "catalog"].includes(options["skill-mode"]))) ||
    ("skills" in options && command !== "exec")
  )
    throw new Error("Skill selection is an exec-only option; skill mode must be full or catalog.");
  const skillNames = options.skills?.split(",");
  if (
    skillNames &&
    (skillNames.length > 20 ||
      new Set(skillNames).size !== skillNames.length ||
      skillNames.some((name) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(name)))
  )
    throw new Error("Select at most 20 unique workspace skill names.");
  const optIns = ["consent", "subagents", "browser", "desktop", "search"];
  for (const key of optIns) {
    if (key in options && (command !== "exec" || !["yes", "no"].includes(options[key])))
      throw new Error(`--${key} is an exec-only option accepting exactly yes or no.`);
  }
  const url = new URL(options.runtime ?? "http://127.0.0.1:3211");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Runtime must be a plain loopback HTTP origin.");
  const requireOption = (key) => {
    if (!options[key]) throw new Error(`--${key} is required.`);
    return options[key];
  };
  const actions = {
    models: () => ({ action: "model/list", params: {} }),
    sessions: () => ({ action: "session/list", params: {} }),
    start: () => ({
      action: "session/start",
      params: options.title ? { title: options.title } : {},
    }),
    read: () => ({ action: "session/read", params: { sessionId: requireOption("session") } }),
    exec: () => ({
      action: "turn/start",
      params: {
        sessionId: requireOption("session"),
        modelId: requireOption("model"),
        text: requireOption("prompt"),
        ...(options.cwd ? { workingDirectory: options.cwd } : {}),
        ...(options["skill-mode"] ? { skillMode: options["skill-mode"] } : {}),
        ...(skillNames ? { skillNames } : {}),
        mutationConsent: options.consent === "yes",
        subagentsEnabled: options.subagents === "yes",
        browserEnabled: options.browser === "yes",
        desktopEnabled: options.desktop === "yes",
        searchEnabled: options.search === "yes",
      },
    }),
    cancel: () => ({
      action: "turn/interrupt",
      params: { sessionId: requireOption("session"), turnId: requireOption("turn") },
    }),
    archive: () => ({ action: "session/archive", params: { sessionId: requireOption("session") } }),
    restore: () => ({ action: "session/restore", params: { sessionId: requireOption("session") } }),
  };
  if (!["help", "status"].includes(command) && !(command in actions))
    throw new Error("Unknown command.");
  return { command, origin: url.origin, body: actions[command]?.() };
}

export async function runAgentCommand(argv, request = fetch) {
  const parsed = parseAgentCommand(argv);
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
  const response = await request(`${parsed.origin}/api/agent`, {
    method: parsed.body ? "POST" : "GET",
    headers,
    ...(parsed.body ? { body: JSON.stringify(parsed.body) } : {}),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
    redirect: "error",
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(
      `Native runtime request rejected (${response.status}); no fallback was executed.`,
    );
  return JSON.stringify(
    payload && typeof payload === "object" && "result" in payload ? payload.result : payload,
    null,
    2,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(await runAgentCommand(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Native runtime request failed.");
    process.exitCode = 1;
  }
}
