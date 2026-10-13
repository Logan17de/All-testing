/* eslint-disable @typescript-eslint/require-await -- Explicit fake host adapter for grant policy tests; no native execution. */
import { describe, expect, it, vi } from "vitest";
import { RuntimeTerminalService, type HumanTerminalGrant } from "./runtime-terminal-service.js";
const identity = { ownerKey: "human-owner", conversationId: "human-chat" };
describe("human host terminal grants (fake adapter, no Windows launch)", () => {
  function setup() {
    let now = 100;
    let grant: HumanTerminalGrant | undefined;
    const authority = {
      windowsIdentity: "TEST\\actual-token",
      shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    };
    const process = {
      close: vi.fn(async () => {}),
      input: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
    };
    const launch = vi.fn(async () => process);
    const service = new RuntimeTerminalService({
      adapter: {
        authority,
        capabilities: {
          interactive: true,
          input: true,
          resize: true,
          interrupt: true,
          mode: "human-host-pty",
        },
        launch,
      },
      now: () => now,
      validateCwd: async () => "D:\\fixture",
      humanGrant: () => grant,
    });
    const approve = () => {
      grant = {
        ...identity,
        ...authority,
        cwd: "D:\\fixture",
        nonce: "a".repeat(43),
        expiresAt: 1000,
      };
    };
    return {
      service,
      process,
      launch,
      approve,
      revoke: () => {
        grant = undefined;
      },
      expire: () => {
        now = 1001;
      },
      wrongIdentity: () => {
        if (grant) grant = { ...grant, windowsIdentity: "TEST\\different-user" };
      },
    };
  }
  it("gates host capability and launch by exact current owner/chat grant", async () => {
    const f = setup();
    expect(f.service.list(identity).capability).toMatchObject({
      mode: "human-host-pty",
      launch: false,
      requiresGrant: true,
      authorityIdentity: "TEST\\actual-token",
    });
    await expect(f.service.create(identity, "fixture")).rejects.toMatchObject({
      code: "TERMINAL_GRANT_REQUIRED",
    });
    expect(f.launch).not.toHaveBeenCalled();
    f.approve();
    expect(f.service.list(identity).capability.launch).toBe(true);
    expect(f.service.list({ ...identity, ownerKey: "agent" }).capability.launch).toBe(false);
    const session = await f.service.create(identity, "fixture");
    expect(session).toMatchObject({
      identity: "TEST\\actual-token",
      shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });
    await f.service.dispose();
  });
  it.each(["revoke", "expire", "wrongIdentity"] as const)(
    "kills before denying input when grant %s",
    async (action) => {
      const f = setup();
      f.approve();
      const s = await f.service.create(identity, "fixture");
      f[action]();
      await expect(f.service.input(identity, s.id, "marker\r")).rejects.toMatchObject({
        code: "TERMINAL_GRANT_REVOKED",
      });
      expect(f.process.close).toHaveBeenCalledTimes(1);
      expect(f.process.input).not.toHaveBeenCalled();
      expect(f.service.list(identity).sessions).toEqual([]);
    },
  );
  it("expires grant even if browser renews its lease", async () => {
    const f = setup();
    f.approve();
    await f.service.create(identity, "fixture");
    f.expire();
    f.service.list(identity);
    await f.service.expireLeases();
    expect(f.process.close).toHaveBeenCalledTimes(1);
    expect(f.service.list(identity).sessions).toEqual([]);
  });
});

it.each([false, true])(
  "idle lease revokes only expired owner before teardown (failure=%s)",
  async (failClose) => {
    let now = 100;
    const other = { ownerKey: "other", conversationId: "other-chat" };
    const authority = { windowsIdentity: "TEST\\actual", shell: "fixed-shell" };
    const grants = new Map<string, HumanTerminalGrant>();
    for (const scope of [identity, other])
      grants.set(scope.ownerKey, {
        ...scope,
        ...authority,
        cwd: "D:\\fixture",
        nonce: scope.ownerKey.repeat(8),
        expiresAt: 100_000,
      });
    const close = vi.fn(async () => {
      expect(grants.has(identity.ownerKey)).toBe(false);
      if (failClose) throw new Error("teardown failed");
    });
    const service = new RuntimeTerminalService({
      now: () => now,
      validateCwd: async () => "D:\\fixture",
      humanGrant: (scope) => grants.get(scope.ownerKey),
      revokeHumanGrant: (scope) => {
        grants.delete(scope.ownerKey);
      },
      adapter: {
        authority,
        capabilities: {
          mode: "human-host-pty",
          interactive: true,
          input: true,
          resize: true,
          interrupt: true,
        },
        launch: async () => ({
          close,
          input: async () => {},
          resize: async () => {},
          interrupt: async () => {},
        }),
      },
    });
    await service.create(identity, "fixture");
    now = 30_101;
    if (failClose) await expect(service.expireLeases()).rejects.toThrow("teardown failed");
    else await service.expireLeases();
    expect(close).toHaveBeenCalledTimes(1);
    expect(service.capability(identity).launch).toBe(false);
    expect(service.capability(other).launch).toBe(true);
    await expect(service.create(identity, "fixture")).rejects.toMatchObject({
      code: "TERMINAL_GRANT_REQUIRED",
    });
  },
);
