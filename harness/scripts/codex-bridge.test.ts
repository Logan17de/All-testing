import { describe, expect, it } from "vitest";
// The CLI entry point is JavaScript so it works before building the runtime.
import { bridgeArgs } from "./codex-bridge.mjs";

describe("official Codex bridge policy", () => {
  it("requires explicit persistent-login consent", () => {
    expect(() => bridgeArgs(["login"])).toThrow();
    expect(bridgeArgs(["login", "--confirm-persist-login", "--device"])).toEqual([
      "login",
      "--device-auth",
    ]);
    expect(() => bridgeArgs(["login", "--confirm-persist-login", "--with-access-token"])).toThrow();
  });
  it("keeps native approvals and defaults to a read-only sandbox", () => {
    const args = bridgeArgs(["chat", "--prompt", "hello $(private)"], process.cwd());
    expect(args).toContain("read-only");
    expect(args).toContain("on-request");
    expect(args!.slice(-2)).toEqual(["--", "hello $(private)"]);
    expect(bridgeArgs(["exec", "--write"])).toContain("workspace-write");
    expect(bridgeArgs(["exec"])).toContain("--json");
  });
  it("refuses bypass flags, ambiguous resume and repeated overrides", () => {
    for (const argv of [
      ["chat", "--dangerously-bypass-approvals-and-sandbox"],
      ["chat", "--config", "x"],
      ["resume"],
      ["exec", "--session", "abc"],
      ["chat", "--model", "a", "--model", "b"],
    ]) {
      expect(() => bridgeArgs(argv)).toThrow();
    }
    expect(bridgeArgs(["resume", "--session", "00000000-0000-0000-0000-000000000001"])).toContain(
      "resume",
    );
  });
});
