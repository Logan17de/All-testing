import { describe, expect, it } from "vitest";
import { parseAgentCommand, runAgentCommand } from "./agent-cli.mjs";

describe("standalone coding CLI", () => {
  it("defaults all per-turn capabilities to disabled", () => {
    expect(
      parseAgentCommand(["exec", "--session", "s", "--model", "m", "--prompt", "hello $(private)"])
        .body,
    ).toEqual({
      action: "turn/start",
      params: {
        sessionId: "s",
        modelId: "m",
        text: "hello $(private)",
        mutationConsent: false,
        subagentsEnabled: false,
        browserEnabled: false,
        searchEnabled: false,
      },
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
  it("requires exact explicit per-turn opt-ins without granting automatic approvals", () => {
    const base = ["exec", "--session", "s", "--model", "m", "--prompt", "task"];
    expect(
      parseAgentCommand([
        ...base,
        "--consent",
        "yes",
        "--subagents",
        "yes",
        "--browser",
        "yes",
        "--search",
        "yes",
      ]).body?.params,
    ).toMatchObject({
      mutationConsent: true,
      subagentsEnabled: true,
      browserEnabled: true,
      searchEnabled: true,
    });
    for (const key of ["consent", "subagents", "browser", "search"]) {
      expect(parseAgentCommand([...base, `--${key}`, "no"]).body?.params).toMatchObject({
        mutationConsent: false,
        subagentsEnabled: false,
        browserEnabled: false,
        searchEnabled: false,
      });
      for (const value of ["true", "YES", "1", "auto"])
        expect(() => parseAgentCommand([...base, `--${key}`, value])).toThrow();
      expect(() => parseAgentCommand(["status", `--${key}`, "yes"])).toThrow();
    }
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

it("passes an explicitly selected workspace directory without changing runtime authority", () => {
  expect(
    parseAgentCommand([
      "exec",
      "--session",
      "s",
      "--model",
      "m",
      "--prompt",
      "task",
      "--cwd",
      "apps/web",
    ]).body?.params,
  ).toMatchObject({ workingDirectory: "apps/web", mutationConsent: false });
  expect(() => parseAgentCommand(["status", "--cwd", "apps/web"])).toThrow();
});

it("selects bounded workspace skills without invoking a skill or granting permissions", () => {
  const base = ["exec", "--session", "s", "--model", "m", "--prompt", "task"];
  expect(
    parseAgentCommand([...base, "--skill-mode", "catalog", "--skills", "review,build"]).body
      ?.params,
  ).toMatchObject({
    skillMode: "catalog",
    skillNames: ["review", "build"],
    mutationConsent: false,
  });
  for (const names of [
    "review,review",
    "../private",
    "review,",
    "one/two",
    " ",
    Array.from({ length: 21 }, (_, i) => `s${i}`).join(","),
  ])
    expect(() => parseAgentCommand([...base, "--skills", names])).toThrow();
  expect(() => parseAgentCommand([...base, "--skill-mode", "auto"])).toThrow();
  expect(() => parseAgentCommand(["status", "--skills", "review"])).toThrow();
});
