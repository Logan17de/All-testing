import { afterEach, describe, expect, it, vi } from "vitest";
import { readTerminals, terminalAction } from "./terminal-transport";
afterEach(() => vi.unstubAllGlobals());
const blocked = {
  capability: {
    launch: false,
    interactive: false,
    input: false,
    resize: false,
    interrupt: false,
    mode: "unavailable",
    reason: "No verified adapter.",
  },
  sessions: [],
};
describe("dedicated human terminal transport", () => {
  it("reports missing runtime endpoint truthfully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "not_found" }, { status: 404 })),
    );
    expect(await readTerminals("chat-a")).toEqual({
      ok: false,
      reason: "This runtime does not support terminal sessions yet.",
    });
  });
  it.each([
    null,
    {},
    { capability: { launch: true }, sessions: [] },
    { ...blocked, sessions: {} },
    { ...blocked, capability: { ...blocked.capability, interactive: true } },
    { ...blocked, sessions: [{ id: "bad", chunks: [{ text: { html: "unsafe" } }] }] },
  ])("rejects malformed 200 snapshots %#", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
    expect(await readTerminals("chat-a")).toEqual({
      ok: false,
      reason: "Terminal service returned an invalid session snapshot.",
    });
  });
  it("validates session output shape and chat binding", async () => {
    const session = {
      id: "terminal-a",
      conversationId: "chat-a",
      cwd: "D:\\fixture",
      status: "exited",
      exitCode: 0,
      cols: 80,
      rows: 24,
      cursor: 1,
      truncated: false,
      chunks: [{ sequence: 1, stream: "stdout", text: "<script>text</script>" }],
    };
    const snapshot = { ...blocked, sessions: [session] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(snapshot)));
    expect((await readTerminals("chat-a")).ok).toBe(true);
    expect((await readTerminals("chat-b")).ok).toBe(false);
    for (const change of [
      { status: "unknown" },
      { chunks: [{ sequence: 1, stream: "stdin", text: "x" }] },
      { cols: 0 },
      { cursor: -1 },
      { exitCode: "0" },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(Response.json({ ...snapshot, sessions: [{ ...session, ...change }] })),
      );
      expect((await readTerminals("chat-a")).ok).toBe(false);
    }
  });
  it("reads through owner-cookie proxy without browser-held authority fields", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(blocked));
    vi.stubGlobal("fetch", fetch);
    const result = await readTerminals("chat&other=bad");
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/editor/terminal?conversationId=chat%26other%3Dbad", {
      cache: "no-store",
    });
  });
  it("sends exact session operation and preserves input text", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await terminalAction("chat-a", "input", { terminalId: "terminal-a", text: "echo test\r" });
    const [path, options] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/editor/terminal");
    expect(JSON.parse(options?.body as string)).toEqual({
      conversationId: "chat-a",
      action: "input",
      terminalId: "terminal-a",
      text: "echo test\r",
    });
    expect(options?.headers).toEqual({ "content-type": "application/json" });
  });
  it("reports rejected and unavailable services without success data", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ error: { reason: "Owner rejected" } }, { status: 403 })),
    );
    expect(await readTerminals("chat-a")).toEqual({ ok: false, reason: "Owner rejected" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await readTerminals("chat-a")).toEqual({
      ok: false,
      reason: "Terminal service is not reachable.",
    });
  });
});

it("validates human PTY proposal binding and combined output (fake backend)", async () => {
  const review = {
    nonce: "proposal",
    identity: "LOGAN\\codexsandboxoffline",
    shell: "cmd.exe",
    cwd: "D:\\fixture",
    conversationId: "chat-a",
    expiresAt: Date.now() + 60000,
  };
  const human = {
    capability: { ...blocked.capability, mode: "human-host-pty", reason: "Awaiting human grant." },
    sessions: [],
    grantReview: review,
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(human)));
  expect((await readTerminals("chat-a")).ok).toBe(true);
  expect((await readTerminals("chat-b")).ok).toBe(false);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ ...human, grantReview: { ...review, expiresAt: "invalid" } }),
      ),
  );
  expect((await readTerminals("chat-a")).ok).toBe(false);
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  await terminalAction("chat-a", "grant", { nonce: review.nonce, confirm: true });
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
    action: "grant",
    conversationId: "chat-a",
    nonce: "proposal",
    confirm: true,
  });
});
