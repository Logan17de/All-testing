/**
 * Start the runtime daemon and the web UI together. Development is the default;
 * --production serves an existing build without compiling or enabling HMR.
 *
 * Deliberately dependency-free rather than pulling in a process-runner package:
 * a "start the app" script that itself needs an install step is a worse
 * starting point for someone trying the harness for the first time.
 *
 * Both servers are started directly by this Node process, not through npm. On
 * Windows npm runs its scripts through `cmd.exe`, and a server started by cmd is
 * not tied to anything: when this script was stopped, the servers kept running,
 * held their ports, and the next `npm start` failed. A server Node starts itself
 * ends with it, and a normal shutdown still stops each whole process tree.
 *
 * `npm run restart` first stops a harness that is already running on the same
 * ports — only one that answers as this harness; anything else is reported. It is
 * its own script because npm claims `--restart` for itself, so a flag written
 * after `--` never reaches this file.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  listeningProcessId,
  portInUse,
  stopProcessId,
  stopProcessTree,
  treeSpawnOptions,
} from "./process-tree.mjs";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The runtime has always run from its own folder, so its data and config stay there.
const runtimeRoot = join(harnessRoot, "apps", "runtime");
const webRoot = join(harnessRoot, "apps", "web");
const isWindows = process.platform === "win32";
const restart = process.argv.includes("--restart");
const production = process.argv.includes("--production");
const usage =
  "Usage: node scripts/start-harness.mjs [--production | --dev] [--restart]\n" +
  "  Default / --dev: build the runtime and start the live development UI.\n" +
  "  --production: serve the existing runtime and UI builds. Run `npm run build` first.";
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(usage);
  process.exit(0);
}
if (
  process.argv.slice(2).some((arg) => !["--production", "--dev", "--restart"].includes(arg)) ||
  (production && process.argv.includes("--dev"))
) {
  console.error(usage);
  process.exit(1);
}

/** Honour the npm that launched us, including portable installations. */
function npmCliPath() {
  const nodeDirectory = dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDirectory, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function nextBinPath() {
  try {
    const requireFromWeb = createRequire(join(webRoot, "package.json"));
    return join(dirname(requireFromWeb.resolve("next/package.json")), "dist", "bin", "next");
  } catch {
    return undefined;
  }
}

function portFrom(value) {
  if (value === undefined || value.trim().length === 0) return undefined;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

/** The runtime's port, read the way the runtime reads it: environment, then config file. */
function runtimePort() {
  const fromEnvironment = portFrom(process.env.ZET_RUNTIME_PORT);
  if (fromEnvironment !== undefined) return fromEnvironment;
  try {
    const config = JSON.parse(readFileSync(join(runtimeRoot, "harness.config.json"), "utf8"));
    const port = config?.runtime?.port;
    if (Number.isSafeInteger(port) && port >= 1 && port <= 65_535) return port;
  } catch {
    // No config file is a working harness.
  }
  return 3211;
}

const npmCli = npmCliPath();
const nextBin = nextBinPath();
if ((!production && npmCli === undefined) || nextBin === undefined) {
  console.error(
    (!production && npmCli === undefined
      ? "Could not locate npm next to this Node installation.\n"
      : "Could not find Next.js; run `npm ci` in the harness folder first.\n") +
      "Start the two processes manually instead:\n" +
      "  npm run start --workspace @zet-harness/runtime\n" +
      `  npm run ${production ? "start" : "dev"} --workspace @zet-harness/web`,
  );
  process.exit(1);
}

// Check before --restart can stop an existing harness. The config owns distDir,
// including review builds, so never accept an unrelated .next/BUILD_ID.
if (production) {
  process.env.NODE_ENV = "production";
  let distDir;
  try {
    const { default: config } = await import(pathToFileURL(join(webRoot, "next.config.mjs")).href);
    distDir = config.distDir ?? ".next";
    if (typeof distDir !== "string") throw new Error("Invalid Next.js build directory.");
  } catch {
    console.error("Could not read the UI build configuration; nothing was started.");
    process.exit(1);
  }
  const artifacts = [join(runtimeRoot, "dist", "main.js"), join(webRoot, distDir, "BUILD_ID")];
  if (artifacts.some((path) => !existsSync(path))) {
    console.error(
      "Production build is missing; nothing was started or stopped.\n" +
        "Run `npm run build`, then `npm start -- --production`.\n" +
        "For live development, use `npm start` or `npm start -- --dev`.",
    );
    process.exit(1);
  }
}

const ports = { runtime: runtimePort(), web: portFrom(process.env.PORT) ?? 3000 };

async function answersAs(url, recognise, timeoutMs) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return recognise(await response.text());
  } catch {
    return false;
  }
}

const services = [
  {
    label: "runtime",
    port: ports.runtime,
    variable: "ZET_RUNTIME_PORT",
    ours: (port) =>
      answersAs(
        `http://127.0.0.1:${String(port)}/api/health`,
        (text) => text.includes('"service":"zet-harness-runtime"'),
        2_000,
      ),
  },
  {
    label: "web UI",
    port: ports.web,
    variable: "PORT",
    ours: (port) =>
      // A development server may compile the page on first request, so allow for it.
      answersAs(
        `http://127.0.0.1:${String(port)}/`,
        (text) => text.includes("Zet Harness"),
        15_000,
      ),
  },
];

/**
 * What is already on our ports, and whether it is this harness.
 *
 * Starting anyway would half-start: one server would come up and the other would
 * fail with a message about ports or "another next dev server". Saying so first,
 * with the process to stop, is the more useful answer.
 */
async function checkPorts() {
  const busy = [];
  for (const service of services) {
    if (!(await portInUse(service.port))) continue;
    busy.push({
      ...service,
      pid: await listeningProcessId(service.port),
      isHarness: await service.ours(service.port),
    });
  }
  if (busy.length === 0) return;

  if (restart && busy.every((entry) => entry.isHarness && entry.pid !== undefined)) {
    console.log("Stopping the Zet Harness that is already running on these ports...");
    await Promise.all(busy.map((entry) => stopProcessId(entry.pid, { force: true })));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const stillBusy = await Promise.all(busy.map((entry) => portInUse(entry.port)));
      if (stillBusy.every((taken) => !taken)) return;
      await new Promise((settle) => setTimeout(settle, 250));
    }
    console.error("The earlier harness did not stop in time; nothing was started.");
    process.exit(1);
  }

  console.error("The harness cannot start, because its ports are already in use:\n");
  for (const entry of busy) {
    const holder = entry.pid === undefined ? "another program" : `process ${String(entry.pid)}`;
    console.error(
      `  port ${String(entry.port)} (${entry.label}) is held by ${holder}, ` +
        (entry.isHarness
          ? "which is a Zet Harness: another `npm start` is still running, or left it behind."
          : `which is not this harness. Stop it, or set ${entry.variable} to use another port.`),
    );
  }
  const leftovers = busy.filter((entry) => entry.isHarness);
  if (leftovers.length > 0) {
    console.error("\nStop the earlier harness and start again in one step:\n  npm run restart");
    const pids = leftovers.flatMap((entry) => (entry.pid === undefined ? [] : [entry.pid]));
    if (pids.length > 0) {
      console.error(
        "\nor stop it yourself:\n" +
          pids
            .map((pid) =>
              isWindows ? `  taskkill /PID ${String(pid)} /T /F` : `  kill ${String(pid)}`,
            )
            .join("\n"),
      );
    }
  }
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function forward(label, child) {
  const prefix = (line) => `[${label}] ${line}`;
  const pipe = (stream, sink) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        sink(prefix(buffer.slice(0, index).replace(/\r$/u, "")));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
  };
  pipe(child.stdout, (line) => console.log(line));
  pipe(child.stderr, (line) => console.error(line));
}

function start(label, args, options) {
  const child = spawn(process.execPath, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    ...treeSpawnOptions(),
  });
  forward(label, child);
  children.push(child);
  child.on("error", (error) => {
    console.error(`[${label}] could not start: ${error.message}`);
    void shutdown(1, false);
  });
  return child;
}

/** Stop the app if one half ends: a half-started system that looks healthy is worse. */
function stopWith(label, child) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${label}] exited (code ${String(code)}, signal ${String(signal)})`);
    void shutdown(code ?? 1, false);
  });
}

const running = () =>
  children.filter((child) => child.exitCode === null && child.signalCode === null);

function settle(timeoutMs) {
  return new Promise((done) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (running().length === 0 || Date.now() > deadline) done();
      else setTimeout(poll, 100);
    };
    poll();
  });
}

async function shutdown(exitCode, interrupted) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (isWindows) {
    // Ctrl+C reaches every process in this console, so the servers are already
    // stopping cleanly; give them a moment, then stop whatever is left.
    if (interrupted) await settle(3_000);
    await Promise.all(running().map((child) => stopProcessTree(child, { force: true })));
  } else {
    // Each server runs in its own process group, which the terminal's Ctrl+C
    // does not reach, so ask each group to stop and then insist.
    await Promise.all(running().map((child) => stopProcessTree(child)));
    await settle(3_000);
    await Promise.all(running().map((child) => stopProcessTree(child, { force: true })));
  }
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    void shutdown(0, true);
  });
}

await checkPorts();

console.log(
  `Starting Zet Harness in ${production ? "production" : "development"} mode. Press Ctrl+C to stop.`,
);

const runtimeUrl = `http://127.0.0.1:${String(ports.runtime)}`;
const web = start(
  "web",
  [nextBin, production ? "start" : "dev", "-H", "127.0.0.1", "-p", String(ports.web)],
  {
    cwd: webRoot,
    env: {
      ...process.env,
      NODE_ENV: production ? "production" : "development",
      NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED ?? "1",
      // The UI finds the runtime on whatever port the runtime was given.
      HARNESS_RUNTIME_URL: process.env.HARNESS_RUNTIME_URL ?? runtimeUrl,
    },
  },
);
stopWith("web", web);

function startRuntime() {
  const runtime = start("runtime", [join("dist", "main.js")], { cwd: runtimeRoot });
  stopWith("runtime", runtime);
  console.log(`Runtime: ${runtimeUrl}   Web UI: http://127.0.0.1:${String(ports.web)}`);
}

if (production) {
  startRuntime();
} else {
  // In development the UI compiles on demand while the runtime builds.
  const build = start("runtime", [npmCli, "run", "build", "--workspace", "@zet-harness/runtime"], {
    cwd: harnessRoot,
  });
  build.on("exit", (code) => {
    if (shuttingDown) return;
    if (code !== 0) {
      console.error(`[runtime] build failed (code ${String(code)})`);
      void shutdown(code ?? 1, false);
      return;
    }
    startRuntime();
  });
}
