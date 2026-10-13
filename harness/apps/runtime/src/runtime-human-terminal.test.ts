import { describe, expect, it, vi } from "vitest";
import { realpath } from "node:fs/promises";
import type { HumanTerminalGrant } from "./runtime-terminal-service.js";
const fixture = vi.hoisted(() => ({
  shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  callbacks: undefined as
    undefined | { onMessage: (value: unknown) => void; onExit: (code: number | null) => void },
  send: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock("./runtime-terminal-job-launcher.js", () => ({
  fixedHumanTerminalShell: () => Promise.resolve(fixture.shell),
  launchTerminalJob: vi.fn(
    (options: { onMessage: (value: unknown) => void; onExit: (code: number | null) => void }) => {
      fixture.callbacks = options;
      fixture.send.mockImplementation((message: Record<string, unknown>) => {
        if (message.kind === "launch")
          options.onMessage({ kind: "ready", cols: message.cols, rows: message.rows, pid: 123 });
        else options.onMessage({ kind: "ack", requestId: message.requestId });
        return Promise.resolve();
      });
      fixture.terminate.mockImplementation(() => {
        options.onExit(0);
        return Promise.resolve();
      });
      queueMicrotask(() => {
        options.onMessage({ kind: "native-ready", windowsIdentity: "FIXTURE\\inherited" });
        options.onMessage({ kind: "worker-ready" });
      });
      return Promise.resolve({ send: fixture.send, terminate: fixture.terminate });
    },
  ),
}));
import { createHumanConPtyAdapter } from "./runtime-human-terminal.js";
import { launchTerminalJob } from "./runtime-terminal-job-launcher.js";
describe("real human adapter protocol with fake launcher (no native execution)", () => {
  async function request() {
    const cwd = await realpath(process.cwd());
    const identity = { ownerKey: "owner", conversationId: "chat" };
    const grant: HumanTerminalGrant = {
      ...identity,
      cwd,
      shell: fixture.shell,
      windowsIdentity: "FIXTURE\\inherited",
      nonce: "n".repeat(43),
      expiresAt: Date.now() + 60000,
    };
    return {
      identity,
      grant,
      cwd,
      cols: 80,
      rows: 24,
      signal: new AbortController().signal,
      output: vi.fn(),
      exit: vi.fn(),
    };
  }
  it("rejects mismatched grant before any launcher invocation", async () => {
    const adapter = await createHumanConPtyAdapter({
      windowsIdentity: "FIXTURE\\inherited",
      shell: fixture.shell,
    });
    const r = await request();
    await expect(
      adapter.launch({ ...r, identity: { ...r.identity, ownerKey: "agent" } }),
    ).rejects.toMatchObject({ code: "TERMINAL_GRANT_REQUIRED" });
    expect(launchTerminalJob).not.toHaveBeenCalled();
  });
  it("sends fixed launch then nonce-scoped operations and preserves combined PTY stream", async () => {
    const adapter = await createHumanConPtyAdapter({
      windowsIdentity: "FIXTURE\\inherited",
      shell: fixture.shell,
    });
    const r = await request();
    const process = await adapter.launch(r);
    expect(fixture.send.mock.calls[0]?.[0]).toMatchObject({
      kind: "launch",
      shell: fixture.shell,
      cwd: r.cwd,
      nonce: r.grant.nonce,
      cols: 80,
      rows: 24,
    });
    fixture.callbacks?.onMessage({ kind: "output", text: "combined terminal output" });
    expect(r.output).toHaveBeenCalledWith("terminal", "combined terminal output");
    await process.input("marker\r");
    await process.resize(100, 30);
    await process.interrupt();
    expect(fixture.terminate).not.toHaveBeenCalled();
    const operations = fixture.send.mock.calls
      .slice(1)
      .map(([value]) => value as Record<string, unknown>);
    expect(operations.map((v) => v.requestId)).toEqual([1, 2, 3]);
    expect(operations.every((v) => v.nonce === r.grant.nonce)).toBe(true);
    await process.close();
    expect(fixture.terminate).toHaveBeenCalled();
  });
  it("terminates transport on malformed worker metadata without forwarding output", async () => {
    const adapter = await createHumanConPtyAdapter({
      windowsIdentity: "FIXTURE\\inherited",
      shell: fixture.shell,
    });
    const r = await request();
    const process = await adapter.launch(r);
    fixture.callbacks?.onMessage({ kind: "output", text: "bad", authorityOverride: true });
    expect(fixture.terminate).toHaveBeenCalled();
    expect(r.output).not.toHaveBeenCalled();
    await process.close();
  });
});
