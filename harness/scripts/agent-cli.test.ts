import { describe, expect, it } from "vitest";
import { parseAgentCommand, runAgentCommand } from "./agent-cli.mjs";

describe("standalone coding CLI", () => {
  it("uses inference-only native turns without provider CLI or privilege flags", () => {
    expect(
      parseAgentCommand(["exec", "--session", "s", "--model", "m", "--prompt", "hello $(private)"])
        .body,
    ).toEqual({
      action: "turn/start",
      params: { sessionId: "s", modelId: "m", text: "hello $(private)" },
    });
    for (const args of [
      ["exec", "--dangerously-bypass-approvals", "yes"],
      ["status", "--runtime", "https://example.com"],
      ["status", "--runtime", "http://secret@localhost:3211"],
      ["exec"],
      ["status", "--runtime", "http://localhost:3211", "--runtime", "http://localhost:3212"],
    ])
      expect(() => parseAgentCommand(args)).toThrow();
  });
  it("does not execute a fallback after a runtime denial or expose the session token", async () => {
    const requests: string[] = [];
    const request = ((url: string | URL | Request) => {
      const location = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      requests.push(location);
      return Promise.resolve(
        location.endsWith("/api/session")
          ? Response.json({ csrfToken: "private-test-token" })
          : Response.json({ error: "denied" }, { status: 403 }),
      );
    }) as typeof fetch;
    await expect(runAgentCommand(["start"], request)).rejects.toThrow("no fallback");
    expect(requests).toEqual([
      "http://127.0.0.1:3211/api/session",
      "http://127.0.0.1:3211/api/agent",
    ]);
  });
});
