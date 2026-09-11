/**
 * Start the runtime daemon and the web UI together.
 *
 * Deliberately dependency-free rather than pulling in a process-runner package:
 * a "start the app" script that itself needs an install step is a worse
 * starting point for someone trying the harness for the first time.
 *
 * Windows notes: npm resolves to `npm.cmd`, which cannot be spawned without a
 * shell, so the child is started through the current Node binary running npm's
 * own JavaScript entry point instead. That keeps `shell: false` everywhere.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** npm's CLI entry, resolved from the Node installation running this script. */
function npmCliPath() {
  const nodeDirectory = dirname(process.execPath);
  const candidates = [
    join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDirectory, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const npmCli = npmCliPath();
if (npmCli === undefined) {
  console.error(
    "Could not locate npm next to this Node installation.\n" +
      "Start the two processes manually instead:\n" +
      "  npm run start --workspace @zet-harness/runtime\n" +
      "  npm run dev   --workspace @zet-harness/web",
  );
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function start(label, args) {
  const child = spawn(process.execPath, [npmCli, ...args], {
    cwd: harnessRoot,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });

  const prefix = (line) => `[${label}] ${line}`;
  const forward = (stream, sink) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        sink(prefix(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
  };
  forward(child.stdout, (line) => console.log(line));
  forward(child.stderr, (line) => console.error(line));

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(prefix(`exited (code ${String(code)}, signal ${String(signal)})`));
    // If either half dies the app is not running, so stop the other rather
    // than leaving a half-started system that looks healthy.
    shutdown(code ?? 1);
  });

  children.push(child);
  return child;
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  setTimeout(() => {
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    process.exit(exitCode);
  }, 2_000).unref();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    shutdown(0);
  });
}

console.log("Starting the Zet Harness runtime and web UI. Press Ctrl+C to stop.");
start("runtime", ["run", "start", "--workspace", "@zet-harness/runtime"]);
start("web", ["run", "dev", "--workspace", "@zet-harness/web"]);
