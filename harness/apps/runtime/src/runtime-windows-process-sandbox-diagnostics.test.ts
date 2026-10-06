import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
import { bridge } from "./runtime-windows-process-sandbox.js";

function nativeFailure(failure: string): void {
  spawnMock.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    child.stdin.on("finish", () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ failure })));
        child.emit("close", 0);
      });
    });
    return child;
  });
}

describe("Windows sandbox diagnostic boundary", () => {
  beforeEach(() => spawnMock.mockReset());

  it("preserves bounded numeric token diagnostics through parsing and catch", async () => {
    nativeFailure("project-source-token-mandatory-policy-1:5");
    await expect(bridge({ mode: "run", command: "project-test" })).rejects.toThrow(
      "Windows process sandbox refused (project-source-token-mandatory-policy-1:5); no host fallback.",
    );
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    "project-source-C:\\private\\credential.txt:5",
    `${"a".repeat(101)}:5`,
    "project-source-token-mandatory-policy-12345678901:5",
    "project-source:1234567890123",
  ])("discards unsafe or unbounded native failure strings (%#)", async (failure) => {
    nativeFailure(failure);
    await expect(bridge({ mode: "run", command: "project-test" })).rejects.toThrow(
      "Windows process sandbox failed; no host fallback.",
    );
  });
});
