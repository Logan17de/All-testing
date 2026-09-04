import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webPackage = resolve(root, "apps/web/package.json");
const requireFromWeb = createRequire(webPackage);
const nextPackage = requireFromWeb.resolve("next/package.json");
const nextBin = resolve(dirname(nextPackage), "dist/bin/next");

const host = "127.0.0.1";
const port = Number(process.env.HARNESS_SMOKE_PORT ?? 3210);
const healthUrl = `http://${host}:${port}/api/health`;
const startupTimeoutMs = 45_000;
const pollIntervalMs = 250;

let output = "";

const server = spawn(
  process.execPath,
  [nextBin, "dev", "apps/web", "-H", host, "-p", String(port)],
  {
    cwd: root,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-12_000);
  });
}

async function stopServer() {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }

  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), sleep(3_000)]);

  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await once(server, "exit");
  }
}

async function waitForHealth() {
  const deadline = Date.now() + startupTimeoutMs;

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(
        `Next.js exited before becoming healthy (code ${server.exitCode}).\n${output}`,
      );
    }

    try {
      const response = await fetch(healthUrl, { cache: "no-store" });

      if (response.ok) {
        const body = await response.json();

        if (body.status === "ok" && body.service === "zet-harness") {
          return;
        }
      }
    } catch {
      // The server is still starting. Keep polling until the deadline.
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Zet Harness did not become healthy within ${startupTimeoutMs}ms.\n${output}`,
  );
}

try {
  await waitForHealth();
  console.log(`STARTUP_OK ${healthUrl}`);
} finally {
  await stopServer();
}
