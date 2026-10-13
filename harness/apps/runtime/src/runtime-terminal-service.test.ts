/* eslint-disable @typescript-eslint/require-await -- Fake adapters implement the production async contract without process I/O. */
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeTerminalService,
  type SandboxedTerminalAdapter,
} from "./runtime-terminal-service.js";
const alice = { ownerKey: "alice", conversationId: "chat-a" };
const capabilities = {
  interactive: true,
  input: true,
  resize: true,
  interrupt: true,
  mode: "sandbox-pty" as const,
};
/** Explicit fake adapter: these tests prove protocol/lifecycle, not real PTY execution. */
function fixture() {
  let emit: Parameters<SandboxedTerminalAdapter["launch"]>[0]["output"] = () => {};
  let exit: Parameters<SandboxedTerminalAdapter["launch"]>[0]["exit"] = () => {};
  const process = {
    input: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const launch = vi.fn(async (request: Parameters<SandboxedTerminalAdapter["launch"]>[0]) => {
    emit = request.output;
    exit = request.exit;
    return process;
  });
  let now = 0;
  const validateCwd = vi.fn(async () => "D:\\approved-fixture");
  const service = new RuntimeTerminalService({
    adapter: { launch, capabilities },
    validateCwd,
    now: () => now,
  });
  return {
    service,
    process,
    launch,
    validateCwd,
    emit: (stream: "stdout" | "stderr", text: string) => emit(stream, text),
    exit: (code: number) => exit(code),
    advance: () => {
      now = 30_001;
    },
  };
}
describe("terminal lifecycle (explicit fake PTY adapter)", () => {
  it("stop retains bounded output while close removes the session", async () => {
    const f = fixture();
    const s = await f.service.create(alice, "fixture");
    f.emit("stdout", "retained");
    await f.service.stop(alice, s.id);
    expect(f.service.list(alice).sessions[0]).toMatchObject({
      status: "exited",
      chunks: [{ text: "retained" }],
    });
    await expect(f.service.input(alice, s.id, "x")).rejects.toMatchObject({
      code: "TERMINAL_NOT_RUNNING",
    });
    await f.service.close(alice, s.id);
    expect(f.process.close).toHaveBeenCalledTimes(1);
    expect(f.service.list(alice).sessions).toEqual([]);
  });
  it("revokes pending launch without returning phantom session and permits a later launch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(async () => {});
    const service = new RuntimeTerminalService({
      validateCwd: async () => "fixture",
      adapter: {
        capabilities,
        launch: async () => {
          await gate;
          return {
            close,
            input: async () => {},
            resize: async () => {},
            interrupt: async () => {},
          };
        },
      },
    });
    const pending = service.create(alice, "fixture");
    await Promise.resolve();
    await service.revokeAll();
    release();
    await expect(pending).rejects.toMatchObject({ code: "TERMINAL_LAUNCH_FAILED" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(service.list(alice).sessions).toEqual([]);
    expect(service.capability().launch).toBe(true);
    await service.create(alice, "fixture");
    await service.dispose();
  });
  it("dispose during cwd validation cannot start a process", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launch = vi.fn(async () => ({
      close: async () => {},
      input: async () => {},
      resize: async () => {},
      interrupt: async () => {},
    }));
    const service = new RuntimeTerminalService({
      adapter: { launch, capabilities },
      validateCwd: async () => {
        await gate;
        return "fixture";
      },
    });
    const pending = service.create(alice, "fixture");
    await service.dispose();
    release();
    await expect(pending).rejects.toMatchObject({ code: "TERMINAL_UNAVAILABLE" });
    expect(launch).not.toHaveBeenCalled();
  });
  it("production default fails closed without spawning or inventing sessions", async () => {
    const service = new RuntimeTerminalService();
    expect(service.list(alice)).toMatchObject({
      capability: { launch: false, interactive: false },
      sessions: [],
    });
    await expect(service.create(alice, "D:\\fixture")).rejects.toMatchObject({
      code: "TERMINAL_UNAVAILABLE",
    });
    expect(service.list(alice).sessions).toEqual([]);
  });
  it("validates cwd before launch and enforces owner plus chat isolation", async () => {
    const f = fixture();
    const s = await f.service.create(alice, "requested");
    expect(f.launch.mock.calls[0]?.[0].cwd).toBe("D:\\approved-fixture");
    expect(f.service.list({ ...alice, ownerKey: "bob" }).sessions).toEqual([]);
    await expect(
      f.service.input({ ...alice, conversationId: "chat-b" }, s.id, "x"),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(f.service.close({ ...alice, ownerKey: "bob" }, s.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(f.process.input).not.toHaveBeenCalled();
    expect(f.process.close).not.toHaveBeenCalled();
  });
  it("streams bounded ordered stdout/stderr and resumes existing session", async () => {
    const f = fixture();
    const s = await f.service.create(alice, "fixture");
    f.emit("stdout", "first");
    f.emit("stderr", "second");
    expect(f.service.list(alice, 1).sessions[0]?.chunks).toEqual([
      { sequence: 2, stream: "stderr", text: "second" },
    ]);
    for (let i = 0; i < 500; i++) f.emit("stdout", "x".repeat(1000));
    const view = f.service.list(alice).sessions[0]!;
    expect(view.id).toBe(s.id);
    expect(view.truncated).toBe(true);
    expect(view.chunks.reduce((n, c) => n + c.text.length, 0)).toBeLessThanOrEqual(65536);
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it("routes real lifecycle operations through adapter and rejects post-exit input", async () => {
    const f = fixture();
    const s = await f.service.create(alice, "fixture");
    await f.service.input(alice, s.id, "hello\r");
    await f.service.resize(alice, s.id, 100, 30);
    await f.service.interrupt(alice, s.id);
    expect(f.process.input).toHaveBeenCalledWith("hello\r");
    expect(f.process.resize).toHaveBeenCalledWith(100, 30);
    expect(f.process.interrupt).toHaveBeenCalledTimes(1);
    f.exit(7);
    expect(f.service.list(alice).sessions[0]).toMatchObject({
      status: "exited",
      exitCode: 7,
      cols: 100,
      rows: 30,
    });
    await expect(f.service.input(alice, s.id, "x")).rejects.toMatchObject({
      code: "TERMINAL_NOT_RUNNING",
    });
    await f.service.close(alice, s.id);
    expect(f.process.close).toHaveBeenCalledTimes(1);
    expect(f.service.list(alice).sessions).toEqual([]);
  });
  it("expires disconnected lease and shuts down all owned sessions", async () => {
    const f = fixture();
    await f.service.create(alice, "fixture");
    f.advance();
    await f.service.expireLeases();
    expect(f.process.close).toHaveBeenCalledTimes(1);
    await f.service.create(alice, "fixture");
    await f.service.dispose();
    expect(f.process.close).toHaveBeenCalledTimes(2);
    await expect(f.service.create(alice, "fixture")).rejects.toMatchObject({
      code: "TERMINAL_UNAVAILABLE",
    });
  });
  it("refuses invalid sizes and oversized input without calling adapter", async () => {
    const f = fixture();
    await expect(f.service.create(alice, "fixture", 0, 24)).rejects.toMatchObject({
      code: "TERMINAL_INVALID",
    });
    expect(f.launch).not.toHaveBeenCalled();
    const s = await f.service.create(alice, "fixture");
    await expect(f.service.input(alice, s.id, "x".repeat(4097))).rejects.toMatchObject({
      code: "TERMINAL_INVALID",
    });
    expect(f.process.input).not.toHaveBeenCalled();
  });
});
