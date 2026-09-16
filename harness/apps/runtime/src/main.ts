import { join } from "node:path";

import { RuntimeDaemon } from "./runtime-daemon.js";
import {
  HARNESS_CONFIG_FILENAME,
  readHarnessConfig,
  resolveRuntimeSettings,
} from "./runtime-config.js";

// Settings come from the environment first, then harness.config.json, then defaults.
// A harness with no config file is a working harness.
const root = process.cwd();
const file = await readHarnessConfig(join(root, HARNESS_CONFIG_FILENAME));
for (const defect of file.defects) console.warn(`ZET_RUNTIME_CONFIG_DEFECT ${defect}`);
const settings = resolveRuntimeSettings(file.config, process.env, root);

const daemon = new RuntimeDaemon({
  api: { port: settings.port },
  database: { path: settings.databasePath },
  // Plugins always load from a directory: a missing directory or plugins.json simply
  // enables nothing, so a fresh install starts with the built-in nodes only.
  plugins: {
    directory: settings.pluginsDirectory,
    ...(settings.install.npm || settings.install.git ? { install: settings.install } : {}),
  },
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
