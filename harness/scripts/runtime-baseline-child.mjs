import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

const databasePath = process.argv[2];
if (databasePath === undefined || databasePath.length === 0) {
  throw new TypeError("Runtime baseline child requires a database path argument.");
}

const startedAt = performance.now();
const { RuntimeDaemon } = await import("../apps/runtime/dist/runtime-daemon.js");
const daemon = new RuntimeDaemon({
  api: { host: "127.0.0.1", port: 0 },
  database: { path: databasePath },
});

try {
  await daemon.start();
  const startupMs = performance.now() - startedAt;
  await sleep(50);
  const idleRssBytes = process.memoryUsage().rss;

  console.log(
    `ZET_RUNTIME_BASELINE_SAMPLE ${JSON.stringify({
      startupMs,
      idleRssBytes,
    })}`,
  );
} finally {
  await daemon.stop();
}
