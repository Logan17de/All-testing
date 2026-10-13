import { chromium } from "playwright-core";
import { StringDecoder } from "node:string_decoder";
import { createBrowserWorkerController } from "./runtime-browser-worker-controller.js";
import { browserExecutableMetadata } from "./runtime-browser-worker-metadata.js";
const send = (value: unknown) => {
  process.stdout.write(JSON.stringify(value) + "\n");
};
const controller = createBrowserWorkerController(chromium, send);
const decoder = new StringDecoder("utf8");
let pending = "";
process.stdin.on("data", (chunk: Buffer) => {
  pending += decoder.write(chunk);
  if (Buffer.byteLength(pending) > 131072) {
    void controller.close().finally(() => process.exit(1));
    return;
  }
  let index: number;
  while ((index = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      void controller.close().finally(() => process.exit(1));
      return;
    }
    const preflight =
      value && typeof value === "object" && (value as { kind?: unknown }).kind === "init"
        ? browserExecutableMetadata(chromium.executablePath()).then((metadata) =>
            send({ kind: "environment", ...metadata }),
          )
        : Promise.resolve();
    void preflight
      .then(() => controller.receive(value))
      .then(
        (state) => {
          if (state === "closed") process.stdout.write("", () => process.exit(0));
        },
        () => process.exit(1),
      );
  }
});
process.stdin.on("end", () => {
  void controller.close().finally(() => process.exit(0));
});
