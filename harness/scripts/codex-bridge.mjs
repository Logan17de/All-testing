import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url));

export const HELP = `Zet / official Codex CLI bridge

npm run codex -- status
npm run codex -- login --confirm-persist-login [--device]
npm run codex -- chat --workspace /path/to/repo [--write] [--model MODEL] [--prompt TEXT]
npm run codex -- exec --workspace /path/to/repo [--write] [--model MODEL] [--prompt TEXT]
npm run codex -- resume --workspace /path/to/repo --session UUID [--write] [--model MODEL]

chat/resume keep Codex's interactive approvals. exec streams official JSONL events;
read the thread ID from thread.started to resume. Pipe a prompt to exec when --prompt
is omitted. Ctrl-C cancels the child. Read-only is the default; --write explicitly
grants workspace writes. No bypass-sandbox flags are accepted. Native Codex loads
its own instructions, skills and configured MCP servers. Its sessions/config/auth
stay with Codex, separate from Zet's SQLite graph runs. Provider access and tools
are subject to the installed CLI, account, platform and configuration.

Login may persist credentials in Codex's own credential store. Run login yourself,
only after choosing --confirm-persist-login, and complete the real consent flow.
This bridge never reads, copies or prints credential files. Claude/Grok subscription
OAuth is unavailable. Separately billed API integration awaits your decision.
`;

export function bridgeArgs(argv, cwd = process.cwd()) {
  const action = argv[0] ?? "help";
  if (action === "help") {
    if (argv.length > 1) throw new Error("help accepts no arguments");
    return null;
  }
  if (action === "status") {
    if (argv.length !== 1) throw new Error("status accepts no arguments");
    return ["login", "status"];
  }
  if (action === "login") {
    if (!argv.includes("--confirm-persist-login"))
      throw new Error("Login requires --confirm-persist-login and your own consent.");
    if (argv.slice(1).some((v) => !["--confirm-persist-login", "--device"].includes(v)))
      throw new Error("Unsupported login argument");
    return ["login", ...(argv.includes("--device") ? ["--device-auth"] : [])];
  }
  if (!["chat", "exec", "resume"].includes(action)) throw new Error("Unknown action; use help");
  const values = new Map();
  let write = false;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--write") {
      if (write) throw new Error("Duplicate --write");
      write = true;
    } else if (["--workspace", "--model", "--prompt", "--session"].includes(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith("--") || value.includes("\0") || values.has(flag))
        throw new Error(`Invalid ${flag}`);
      values.set(flag, value);
    } else throw new Error("Unsupported argument; use help");
  }
  const workspace = realpathSync(values.get("--workspace") ?? cwd);
  if (!statSync(workspace).isDirectory()) throw new Error("Workspace must be a directory");
  const session = values.get("--session");
  if (
    action === "resume" &&
    (!session || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session))
  )
    throw new Error("resume requires an explicit session UUID");
  if (action !== "resume" && session) throw new Error("--session is only valid for resume");
  const args = [
    "--sandbox",
    write ? "workspace-write" : "read-only",
    "--ask-for-approval",
    "on-request",
    "--cd",
    workspace,
    "--config",
    "sandbox_workspace_write.network_access=false",
  ];
  if (values.has("--model")) args.push("--model", values.get("--model"));
  if (action === "exec") args.push("exec", "--json");
  else {
    args.push("--no-daemon");
    if (action === "resume") args.push("resume", session);
  }
  const prompt = values.get("--prompt");
  // Separate prompts from options; neither shell syntax nor prompt options are interpreted.
  if (prompt !== undefined) args.push("--", prompt);
  else if (action === "exec") args.push("-");
  return args;
}

export async function runBridge(argv) {
  let args;
  try {
    args = bridgeArgs(argv);
  } catch {
    console.error(
      "Invalid Codex bridge request. Run npm run codex -- help for accepted arguments and login consent.",
    );
    return 2;
  }
  if (args === null) {
    console.log(HELP);
    return 0;
  }
  if (!existsSync(cli)) {
    console.error("Official Codex CLI is missing. Run npm ci.");
    return 2;
  }
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: "inherit", shell: false });
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = signals.map((signal) => {
      const handler = () => {
        child.kill(signal);
      };
      process.on(signal, handler);
      return handler;
    });
    const cleanup = () => signals.forEach((signal, i) => process.off(signal, handlers[i]));
    child.once("error", () => {
      cleanup();
      console.error("Official Codex CLI could not start.");
      resolve(2);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(code ?? { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[signal] ?? 1);
    });
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBridge(process.argv.slice(2));
}
