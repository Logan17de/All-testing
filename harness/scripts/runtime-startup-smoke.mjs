import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeEntry = resolve(root, "apps/runtime/dist/main.js");
const startupTimeoutMs = 5_000;
const shutdownTimeoutMs = 3_000;
const livenessProbeMs = 50;

let output = "";

const runtime = spawn(process.execPath, [runtimeEntry], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});

for (const stream of [runtime.stdout, runtime.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-12_000);
  });
}

async function stopRuntime() {
  if (runtime.exitCode !== null || runtime.signalCode !== null) {
    return;
  }

  runtime.kill("SIGTERM");
  await Promise.race([once(runtime, "exit"), sleep(shutdownTimeoutMs)]);

  if (runtime.exitCode === null && runtime.signalCode === null) {
    runtime.kill("SIGKILL");
    await once(runtime, "exit");
  }
}

async function waitForReady() {
  const deadline = Date.now() + startupTimeoutMs;

  while (Date.now() < deadline) {
    if (runtime.exitCode !== null || runtime.signalCode !== null) {
      throw new Error(
        `Runtime exited before becoming ready (code ${String(runtime.exitCode)}, signal ${String(runtime.signalCode)}).\n${output}`,
      );
    }

    if (output.includes("ZET_RUNTIME_READY service=zet-harness-runtime")) {
      return;
    }

    await sleep(20);
  }

  throw new Error(`Zet Harness runtime did not become ready within ${startupTimeoutMs}ms.\n${output}`);
}

try {
  await waitForReady();
  await sleep(livenessProbeMs);

  if (runtime.exitCode !== null || runtime.signalCode !== null) {
    throw new Error(`Runtime did not remain alive after readiness.\n${output}`);
  }

  console.log("RUNTIME_STARTUP_OK service=zet-harness-runtime");
} finally {
  await stopRuntime();
}
