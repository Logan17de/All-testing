import { expect, it, vi } from "vitest";
import { RuntimeHttpServer } from "./runtime-http-server.js";
import { RuntimeTerminalService } from "./runtime-terminal-service.js";
import { RuntimeTerminalAuthority } from "./runtime-terminal-authority.js";
import { resolve } from "node:path";

it("protects terminal output and mutations by owner/chat, rejects cwd injection and revokes changed folders (mock adapter)", async () => {
  const conversationId = "01a110b8-292d-73a8-a47d-16da3b861b38";
  const close = vi.fn(() => Promise.resolve());
  const input = vi.fn(() => Promise.resolve());
  const root = "isolated-canonical-test-root";
  let trusted = true;
  const service = new RuntimeTerminalService({
    validateCwd: (_identity, value) => Promise.resolve(value),
    adapter: {
      capabilities: {
        interactive: true,
        input: true,
        resize: true,
        interrupt: true,
        mode: "sandbox-pty",
      },
      launch: ({ output }) => {
        output("stdout", "owned fixture output");
        return Promise.resolve({
          input,
          close,
          resize: () => Promise.resolve(),
          interrupt: () => Promise.resolve(),
        });
      },
    },
  });
  const server = new RuntimeHttpServer({ port: 0 }, undefined, undefined, {
    terminal: {
      service,
      conversationRoot: () => {
        if (!trusted) throw new Error("private-trust-detail");
        return Promise.resolve(root);
      },
    },
  });
  await server.start();
  try {
    const base = `http://127.0.0.1:${server.snapshot().port}`;
    const { csrfToken } = (await (await fetch(`${base}/api/session`)).json()) as {
      csrfToken: string;
    };
    const owner = "a".repeat(43);
    const headers = {
      "content-type": "application/json",
      "x-zet-csrf": csrfToken,
      "x-zet-terminal-owner": owner,
    };
    const post = (value: object, ownerKey = owner) =>
      fetch(`${base}/api/terminal`, {
        method: "POST",
        headers: { ...headers, "x-zet-terminal-owner": ownerKey },
        body: JSON.stringify(value),
      });
    expect((await fetch(`${base}/api/terminal?conversationId=${conversationId}`)).status).toBe(403);
    expect((await post({ action: "create", conversationId, cwd: "caller-path" })).status).toBe(400);
    const created = (await (await post({ action: "create", conversationId })).json()) as {
      result: { id: string; cwd: string };
    };
    expect(created.result.cwd).toBe(root);
    const terminalId = created.result.id;
    expect(
      (await post({ action: "input", conversationId, terminalId, text: "fixture" }, "b".repeat(43)))
        .status,
    ).toBe(404);
    const other = (await (
      await fetch(`${base}/api/terminal?conversationId=${conversationId}`, {
        headers: { ...headers, "x-zet-terminal-owner": "b".repeat(43) },
      })
    ).json()) as { sessions: unknown[] };
    expect(other.sessions).toEqual([]);
    expect(
      (
        await post({
          action: "input",
          conversationId: "01a110b8-291d-737f-a0a1-c9298a4f3e2f",
          terminalId,
          text: "fixture",
        })
      ).status,
    ).toBe(404);
    expect(
      (await post({ action: "input", conversationId, terminalId, text: "fixture" })).status,
    ).toBe(200);
    expect(input).toHaveBeenCalledOnce();
    trusted = false;
    const revoked = await post({ action: "input", conversationId, terminalId, text: "forbidden" });
    expect(revoked.status).toBe(409);
    expect(await revoked.text()).not.toContain("private-trust-detail");
    expect(close).toHaveBeenCalledOnce();
    expect(input).toHaveBeenCalledOnce();
    expect(service.list({ ownerKey: owner, conversationId }).sessions).toEqual([]);
  } finally {
    await service.dispose();
    await server.stop();
  }
});

it("reports a genuinely unavailable production terminal without inventing sessions", async () => {
  const service = new RuntimeTerminalService();
  const identity = { ownerKey: "owner", conversationId: "chat" };
  expect(service.list(identity)).toMatchObject({
    capability: { launch: false, interactive: false },
    sessions: [],
  });
  await expect(service.create(identity, "irrelevant")).rejects.toMatchObject({
    code: "TERMINAL_UNAVAILABLE",
  });
  await service.dispose();
});

it("requires exact human review at the real HTTP boundary and rejects injection, replay and cross-owner/chat grants (mock only)", async () => {
  const conversationId = "01a110b8-292d-73a8-a47d-16da3b861b38";
  const owner = "a".repeat(43);
  const cwd = resolve("terminal-fixture-workspace");
  const shell = resolve("fixed-fixture-shell.exe");
  let trusted = true,
    now = 0;
  const authority = new RuntimeTerminalAuthority({ now: () => now, reviewTtlMs: 10, ttlMs: 20 });
  const launch = vi.fn(() =>
    Promise.resolve({
      input: () => Promise.resolve(),
      resize: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      close: () => Promise.resolve(),
    }),
  );
  const service = new RuntimeTerminalService({
    now: () => now,
    humanGrant: (identity) => authority.get(identity),
    validateCwd: (_identity, path) => Promise.resolve(path),
    adapter: {
      authority: { windowsIdentity: "S-1-5-fixture", shell },
      capabilities: {
        interactive: true,
        input: true,
        resize: true,
        interrupt: true,
        mode: "human-host-pty",
      },
      launch,
    },
  });
  const server = new RuntimeHttpServer({ port: 0 }, undefined, undefined, {
    terminal: {
      service,
      authority,
      conversationRoot: () => {
        if (!trusted) throw Error("untrusted-private-detail");
        return Promise.resolve(cwd);
      },
    },
  });
  await server.start();
  try {
    const base = `http://127.0.0.1:${server.snapshot().port}`;
    const { csrfToken } = (await (await fetch(`${base}/api/session`)).json()) as {
      csrfToken: string;
    };
    const headers = {
      "content-type": "application/json",
      "x-zet-csrf": csrfToken,
      "x-zet-terminal-owner": owner,
    };
    const get = async () =>
      (await (
        await fetch(`${base}/api/terminal?conversationId=${conversationId}`, { headers })
      ).json()) as {
        grantReview: { nonce: string; cwd: string; shell: string; identity: string };
        capability: { launch: boolean };
      };
    const post = (body: object, who = owner) =>
      fetch(`${base}/api/terminal`, {
        method: "POST",
        headers: { ...headers, "x-zet-terminal-owner": who },
        body: JSON.stringify(body),
      });
    const review = await get();
    expect(review.capability.launch).toBe(false);
    expect(review.grantReview).toMatchObject({ cwd, shell, identity: "S-1-5-fixture" });
    for (const field of [
      "cwd",
      "shell",
      "env",
      "ownerKey",
      "identity",
      "expiresAt",
      "policyVersion",
      "timeout",
    ]) {
      expect(
        (
          await post({
            action: "grant",
            conversationId,
            nonce: review.grantReview.nonce,
            confirm: true,
            [field]: "injected",
          })
        ).status,
      ).toBe(400);
    }
    const grant = {
      action: "grant",
      conversationId,
      nonce: review.grantReview.nonce,
      confirm: true,
    };
    expect((await post(grant, "b".repeat(43))).status).toBe(409);
    expect(
      (await post({ ...grant, conversationId: "01a110b8-291d-737f-a0a1-c9298a4f3e2f" })).status,
    ).toBe(409);
    expect((await post({ ...grant, confirm: false })).status).toBe(400);
    expect((await post(grant)).status).toBe(200);
    expect((await get()).capability.launch).toBe(true);
    expect((await post(grant)).status).toBe(409);
    expect(launch).not.toHaveBeenCalled();
    const created = (await (await post({ action: "create", conversationId })).json()) as {
      result: { id: string };
    };
    expect(launch).toHaveBeenCalledOnce();
    expect(
      (await post({ action: "close", conversationId, terminalId: created.result.id })).status,
    ).toBe(200);
    expect(authority.get({ ownerKey: owner, conversationId })).toBeUndefined();
    expect((await post({ action: "create", conversationId })).status).toBe(403);
    expect((await post({ action: "revoke", conversationId })).status).toBe(200);
    expect((await get()).capability.launch).toBe(false);
    const expiring = (await get()).grantReview;
    now = 10;
    expect(
      (await post({ action: "grant", conversationId, nonce: expiring.nonce, confirm: true }))
        .status,
    ).toBe(409);
    const untrusted = (await get()).grantReview;
    trusted = false;
    expect(
      (await post({ action: "grant", conversationId, nonce: untrusted.nonce, confirm: true }))
        .status,
    ).toBe(409);
    expect(authority.get({ ownerKey: owner, conversationId })).toBeUndefined();
    expect(launch).toHaveBeenCalledOnce();
  } finally {
    authority.revokeAll();
    await service.dispose();
    await server.stop();
  }
});
