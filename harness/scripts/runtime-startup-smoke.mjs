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
const readyPattern = /ZET_RUNTIME_READY service=zet-harness-runtime host=([^\s]+) port=(\d+)/;

let output = "";

const runtime = spawn(process.execPath, [runtimeEntry], {
  cwd: root,
  env: {
    ...process.env,
    ZET_RUNTIME_PORT: "0",
  },
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

    const ready = readyPattern.exec(output);
    if (ready !== null) {
      return { host: ready[1], port: Number(ready[2]) };
    }

    await sleep(20);
  }

  throw new Error(
    `Zet Harness runtime did not become ready within ${startupTimeoutMs}ms.\n${output}`,
  );
}

try {
  const { host, port } = await waitForReady();
  const baseUrl = `http://${host}:${String(port)}`;
  const healthUrl = `${baseUrl}/api/health`;
  const response = await fetch(healthUrl, { cache: "no-store" });
  const health = await response.json();

  if (!response.ok || health.status !== "ok" || health.service !== "zet-harness-runtime") {
    throw new Error(`Runtime health probe failed at ${healthUrl}.\n${output}`);
  }

  const eventResponse = await fetch(`${baseUrl}/api/events`);
  if (
    !eventResponse.ok ||
    eventResponse.headers.get("content-type") !== "text/event-stream; charset=utf-8"
  ) {
    throw new Error(`Runtime SSE handshake failed at ${baseUrl}/api/events.\n${output}`);
  }

  const eventReader = eventResponse.body?.getReader();
  if (eventReader === undefined) {
    throw new Error(`Runtime SSE response had no body.\n${output}`);
  }

  const firstEventChunk = await eventReader.read();
  const firstEventText =
    firstEventChunk.value === undefined ? "" : new TextDecoder().decode(firstEventChunk.value);
  await eventReader.cancel();

  if (!firstEventText.includes(": connected")) {
    throw new Error(`Runtime SSE stream did not send its connection prelude.\n${output}`);
  }

  await sleep(livenessProbeMs);

  if (runtime.exitCode !== null || runtime.signalCode !== null) {
    throw new Error(`Runtime did not remain alive after readiness.\n${output}`);
  }

  console.log(`RUNTIME_STARTUP_OK ${healthUrl} sse=ok`);
} finally {
  await stopRuntime();
}
