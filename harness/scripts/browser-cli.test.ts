import { expect, it, vi } from "vitest";
import { parseBrowserCommand, runBrowserCommand } from "./browser-cli.mjs";

it("requires explicit task consent and refuses remote runtime credentials", () => {
  expect(() =>
    parseBrowserCommand(["arm", "--task", "Read docs", "--domains", "example.com"]),
  ).toThrow("consent");
  expect(() => parseBrowserCommand(["status", "--runtime", "http://example.com"])).toThrow(
    "loopback",
  );
  expect(() => parseBrowserCommand(["status", "--runtime", "http://secret@localhost"])).toThrow(
    "loopback",
  );
  expect(
    parseBrowserCommand([
      "arm",
      "--task",
      "Read docs",
      "--domains",
      "example.com",
      "--consent",
      "yes",
    ]).body?.params,
  ).toMatchObject({ confirm: true, task: "Read docs", domains: ["example.com"] });
});

it("binds separate approval to supplied generation and obtains CSRF before mutation", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "fixture" })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: { accepted: true } })));
  expect(await runBrowserCommand(["deny", "--id", "call", "--generation", "2"], request)).toContain(
    "accepted",
  );
  const init = request.mock.calls[1]?.[1];
  expect(init?.headers).toMatchObject({ "x-zet-csrf": "fixture" });
  if (typeof init?.body !== "string") throw new Error("Expected JSON request body.");
  expect(JSON.parse(init.body)).toEqual({
    action: "approval/respond",
    params: { id: "call", generation: 2, decision: "rejected" },
  });
  expect(init?.redirect).toBe("error");
});

it("never sends a mutation when session establishment fails", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 403 }));
  await expect(runBrowserCommand(["stop"], request)).rejects.toThrow("session");
  expect(request).toHaveBeenCalledTimes(1);
});
