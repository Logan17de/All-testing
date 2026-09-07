import { RuntimeDaemon } from "./runtime-daemon.js";

const daemon = new RuntimeDaemon();

const requestStop = (signal: "SIGINT" | "SIGTERM"): void => {
  if (daemon.stop()) {
    console.log(`ZET_RUNTIME_STOPPING signal=${signal}`);
  }
};

const onSigint = (): void => requestStop("SIGINT");
const onSigterm = (): void => requestStop("SIGTERM");

process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

daemon.start();
console.log(`ZET_RUNTIME_READY service=zet-harness-runtime pid=${String(process.pid)}`);

try {
  await daemon.waitUntilStopped();
} finally {
  daemon.stop();
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}

console.log("ZET_RUNTIME_STOPPED service=zet-harness-runtime");
