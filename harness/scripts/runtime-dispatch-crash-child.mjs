// Isolated test process: all paths are parent-created temporary fixtures.
import { appendFileSync } from "node:fs";
import { RuntimeDaemon } from "../apps/runtime/dist/runtime-daemon.js";

const [databasePath, callLogPath] = process.argv.slice(2);
if (!databasePath || !callLogPath || !process.send)
  throw new Error("Missing test fixture paths/IPC.");
const daemon = new RuntimeDaemon({
  api: { port: 0 },
  database: { path: databasePath },
  permissionAuthority: { evaluate: () => ({ decision: "allow" }) },
  execution: {
    execute(context) {
      appendFileSync(callLogPath, `${context.operation.type}\n`);
      return {
        outputs: { value: context.operation.type === "test.prepare" ? "saved" : "written" },
      };
    },
  },
});
process.on("message", (message) => {
  if (message === "settle") {
    void daemon
      .waitForRunIdle("run-1")
      .then((report) => process.send?.({ type: "settled", report }));
  }
  if (message === "stop") void daemon.stop().then(() => process.disconnect());
});
await daemon.start();
const report = await daemon.waitForRunIdle("run-1");
process.send({ type: "ready", report, port: daemon.snapshot().api.port });
