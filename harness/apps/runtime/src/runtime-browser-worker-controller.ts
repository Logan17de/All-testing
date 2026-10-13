import { isIP } from "node:net";
import { BrowserDomainPolicy, type BrowserPinnedAddress } from "./runtime-browser-policy.js";
import {
  checkedBrowserAction,
  type BrowserAction,
  type RuntimeBrowserDriver,
} from "./runtime-browser-session.js";
import { createPlaywrightBrowserDriver, type BrowserEngine } from "./runtime-browser-driver.js";

/** Only fixed browser actions; no executable, script, cookie, file, process, or policy parameters. */
export function createBrowserWorkerController(
  engine: BrowserEngine,
  send: (value: unknown) => void,
) {
  const controller = new AbortController();
  let driver: RuntimeBrowserDriver | undefined;
  let busy = false;
  let lastId = 0;
  async function close() {
    controller.abort();
    await driver?.close();
    driver = undefined;
  }
  return {
    close,
    async receive(value: unknown) {
      let id = 0;
      try {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        const message = value as Record<string, unknown>;
        id = message["id"] as number;
        if (!Number.isSafeInteger(id) || id !== lastId + 1) throw new Error();
        lastId = id;
        if (message["kind"] === "close") {
          if (Object.keys(message).sort().join(",") !== "id,kind") throw new Error();
          await close();
          send({ id, ok: true, value: null });
          return "closed" as const;
        }
        if (
          Object.keys(message).sort().join(",") !== "data,id,kind" ||
          busy ||
          controller.signal.aborted
        )
          throw new Error();
        busy = true;
        if (message["kind"] === "init") {
          if (driver) throw new Error();
          const data = message["data"] as { pins?: unknown };
          if (
            !data ||
            typeof data !== "object" ||
            Object.keys(data).join(",") !== "pins" ||
            !Array.isArray(data.pins) ||
            !data.pins.length ||
            data.pins.length > 64
          )
            throw new Error();
          const pins = data.pins as BrowserPinnedAddress[];
          for (const pin of pins)
            if (
              !pin ||
              Object.keys(pin).sort().join(",") !== "address,family,hostname" ||
              typeof pin.hostname !== "string" ||
              typeof pin.address !== "string" ||
              isIP(pin.address) !== pin.family
            )
              throw new Error();
          const policy = new BrowserDomainPolicy({
            domains: [...new Set(pins.map((pin) => pin.hostname))],
            resolve: (name) =>
              Promise.resolve(
                pins
                  .filter((pin) => pin.hostname === name)
                  .map(({ address, family }) => ({ address, family })),
              ),
          });
          await policy.pin(); // Validate public pinned addresses without making a second DNS request.
          driver = await createPlaywrightBrowserDriver({
            engine,
            onStartupFailure: (code) => send({ kind: "diagnostic", code }),
            onStartupPhase: (stage) => send({ kind: "phase", stage }),
            scope: policy,
            pins,
            signal: controller.signal,
          });
          if (controller.signal.aborted) {
            await driver.close();
            throw new Error();
          }
          send({ id, ok: true, value: null });
        } else if (message["kind"] === "action") {
          if (!driver) throw new Error();
          const action = checkedBrowserAction(message["data"] as BrowserAction);
          send({ kind: "phase", stage: "action" });
          const result = await driver.execute(action, controller.signal);
          if (typeof result === "string" && Buffer.byteLength(result) > 65536) throw new Error();
          if (controller.signal.aborted) throw new Error();
          send({ id, ok: true, value: result });
        } else throw new Error();
        return "open" as const;
      } catch {
        await close().catch(() => undefined);
        send({ id, ok: false, value: null });
        return "closed" as const;
      } finally {
        busy = false;
      }
    },
  };
}
