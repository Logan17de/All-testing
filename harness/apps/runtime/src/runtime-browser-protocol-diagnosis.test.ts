import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import assert from "node:assert";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
it("reproduces installed Playwright stale-response assertion after pending callbacks cleared without launching browser", async () => {
  const source = await readFile("node_modules/playwright-core/lib/coreBundle.js", "utf8");
  const start = source.indexOf("CRSession = class _CRSession extends SdkObject");
  const end = source.indexOf("\n    CDPSession =", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  class Sdk extends EventEmitter {
    constructor() {
      super();
    }
  }
  class ProtocolError extends Error {
    [key: string]: unknown;
    setMessage(value: string) {
      this.message = value;
    }
  }
  const Session = runInNewContext(source.slice(start, end) + ";CRSession;", {
    SdkObject: Sdk,
    assert,
    ProtocolError,
    Promise,
  }) as new (
    connection: unknown,
    parent: unknown,
    id: string,
  ) => {
    send(method: string, params: unknown): Promise<unknown>;
    _markAsCrashed(): void;
    _onMessage(value: unknown): void;
  };
  const session = new Session(
    { _rawSend: () => 1, _closed: false, _sessions: new Map() },
    null,
    "fixture",
  );
  const pending = session.send("Browser.getVersion", {});
  const rejected = expect(pending).rejects.toThrow("Page crashed");
  session._markAsCrashed();
  await rejected;
  expect(() => session._onMessage({ id: 1, result: {} })).toThrow();
});
