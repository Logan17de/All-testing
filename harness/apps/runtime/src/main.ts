import { RuntimeDaemon } from "./runtime-daemon.js";

const configuredPort = process.env.ZET_RUNTIME_PORT;
const runtimePort = configuredPort === undefined ? undefined : Number(configuredPort);
const runtimeDatabasePath = process.env.ZET_RUNTIME_DB_PATH;

const daemon = new RuntimeDaemon({
  ...(runtimePort === undefined ? {} : { api: { port: runtimePort } }),
  ...(runtimeDatabasePath === undefined ? {} : { database: { path: runtimeDatabasePath } }),
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
