import { resolve } from "node:path";

import { RuntimeDaemon } from "./runtime-daemon.js";
import { DEFAULT_PLUGINS_DIRECTORY } from "./runtime-plugins.js";

const configuredPort = process.env.ZET_RUNTIME_PORT;
const runtimePort = configuredPort === undefined ? undefined : Number(configuredPort);
const runtimeDatabasePath = process.env.ZET_RUNTIME_DB_PATH;
// Plugins always load from a directory: a missing directory or plugins.json simply
// enables nothing, so a fresh install starts with the built-in nodes only.
const pluginsDirectory = process.env.ZET_RUNTIME_PLUGINS_DIR ?? DEFAULT_PLUGINS_DIRECTORY;

const daemon = new RuntimeDaemon({
  ...(runtimePort === undefined ? {} : { api: { port: runtimePort } }),
  ...(runtimeDatabasePath === undefined ? {} : { database: { path: runtimeDatabasePath } }),
  plugins: { directory: resolve(pluginsDirectory) },
});

let stopRequested = false;

const requestStop = (signal: "SIGINT" | "SIGTERM"): void => {
  if (stopRequested) {
    return;
  }

  stopRequested = true;
  console.log(`ZET_RUNTIME_STOPPING signal=${signal}`);
  void daemon.stop().catch((error: unknown) => {
    console.error("ZET_RUNTIME_STOP_FAILED", error);
    process.exitCode = 1;
  });
};

const onSigint = (): void => requestStop("SIGINT");
const onSigterm = (): void => requestStop("SIGTERM");

await daemon.start();

process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

const snapshot = daemon.snapshot();
if (snapshot.api.port === null) {
  throw new TypeError("Runtime API reported ready without a bound TCP port.");
}
if (snapshot.database.state !== "open") {
  throw new TypeError("Runtime reported ready without an open SQLite database.");
}

console.log(
  `ZET_RUNTIME_READY service=zet-harness-runtime host=${snapshot.api.host} port=${String(snapshot.api.port)} pid=${String(process.pid)}`,
);

try {
  await daemon.waitUntilStopped();
} finally {
  await daemon.stop();
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}

console.log("ZET_RUNTIME_STOPPED service=zet-harness-runtime");
