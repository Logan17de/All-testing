import { afterEach, expect, it, vi } from "vitest";
import { proxyTerminal } from "./terminal-proxy";

afterEach(() => vi.unstubAllGlobals());

it("refuses cross-site access before fetching any runtime token", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const reply = await proxyTerminal(
    new Request("http://127.0.0.1:3000/api/editor/terminal", {
      headers: { origin: "https://untrusted.invalid", "sec-fetch-site": "cross-site" },
    }),
  );
  expect(reply.status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps owner identity HttpOnly and forwards runtime CSRF on reads without leaking it", async () => {
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/api/session")) return Response.json({ csrfToken: "test-runtime-token" });
    expect(new Headers(init?.headers).get("x-zet-csrf")).toBe("test-runtime-token");
    expect(new Headers(init?.headers).get("x-zet-terminal-owner")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return Response.json({
      capability: { launch: false, interactive: false, reason: "blocked" },
      sessions: [],
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const reply = await proxyTerminal(
    new Request("http://127.0.0.1:3000/api/editor/terminal?conversationId=fixture"),
  );
  expect(reply.status).toBe(200);
  expect(reply.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict/);
  expect(reply.headers.get("set-cookie")).not.toContain("Max-Age");
  expect(await reply.text()).not.toContain("test-runtime-token");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("uses the same session owner on reconnect and never forwards client owner headers", async () => {
  const owner = "a".repeat(43);
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/api/session")) return Response.json({ csrfToken: "test-runtime-token" });
    expect(new Headers(init?.headers).get("x-zet-terminal-owner")).toBe(owner);
    return Response.json({
      capability: { launch: false, interactive: false, reason: "blocked" },
      sessions: [],
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const reply = await proxyTerminal(
    new Request("http://127.0.0.1:3000/api/editor/terminal?conversationId=fixture&after=4", {
      headers: { cookie: `zet-terminal-owner-v1=${owner}`, "x-zet-terminal-owner": "attacker" },
    }),
  );
  expect(reply.headers.get("set-cookie")).toBeNull();
  expect(reply.status).toBe(200);
});

it.each(["create", "input"])("bounds %s proxy deadline appropriately", async (action) => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Response.json(url.endsWith("/api/session") ? { csrfToken: "test" } : {}),
    ),
  );
  try {
    await proxyTerminal(
      new Request("http://127.0.0.1:3000/api/editor/terminal", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
        body: JSON.stringify({ action, conversationId: "fixture" }),
      }),
    );
    expect(timeout).toHaveBeenCalledWith(action === "create" ? 70_000 : 15_000);
  } finally {
    timeout.mockRestore();
  }
});
