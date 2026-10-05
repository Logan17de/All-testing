import { describe, expect, it, vi } from "vitest";
import { RuntimeBrowserSession, type RuntimeBrowserDriver } from "./runtime-browser-session.js";
function fixture(approve = () => Promise.resolve(true)) {
  const driver: RuntimeBrowserDriver = {
    execute: vi.fn(() => Promise.resolve("result")),
    close: vi.fn(() => Promise.resolve(undefined)),
  };
  const session = new RuntimeBrowserSession({
    createDriver: () => Promise.resolve(driver),
    approve,
    createScope: () => ({
      pin: () => Promise.resolve([]),
      permits: (url) => url.startsWith("https://allowed.org/"),
    }),
  });
  const arm = () =>
    session.arm({
      task: "Test browser task",
      domains: ["allowed.org"],
      minutes: 1,
      maxActions: 3,
      confirm: true,
    });
  return { session, driver, arm };
}
describe("native browser session", () => {
  it("requires explicit bounded consent and denies out of scope navigation", async () => {
    const { session, driver, arm } = fixture();
    await expect(
      session.arm({
        task: "task",
        domains: [],
        minutes: 1,
        maxActions: 1,
        confirm: false,
      } as never),
    ).rejects.toThrow();
    const state = await arm();
    await expect(
      session.execute({ kind: "navigate", url: "http://localhost/" }, state.generation),
    ).rejects.toThrow("scope");
    expect(vi.mocked(driver).execute).not.toHaveBeenCalled();
    await session.stop();
  });
  it("declined input never reaches driver; read consumes bounded action budget", async () => {
    const { session, driver, arm } = fixture(() => Promise.resolve(false));
    const state = await arm();
    await expect(
      session.execute({ kind: "type", selector: "#query", text: "secret" }, state.generation),
    ).rejects.toThrow("declined");
    expect(vi.mocked(driver).execute).not.toHaveBeenCalled();
    await session.execute({ kind: "read", selector: "body" }, state.generation);
    await session.execute({ kind: "read", selector: "body" }, state.generation);
    await expect(
      session.execute({ kind: "read", selector: "body" }, state.generation),
    ).rejects.toThrow("budget");
    await session.stop();
  });
  it("stop revokes pending consent and stale generation", async () => {
    let accept: ((value: boolean) => void) | undefined;
    const { session, driver, arm } = fixture(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    );
    const state = await arm();
    const pending = session.execute({ kind: "click", selector: "button" }, state.generation);
    const rejected = expect(pending).rejects.toThrow("stopped");
    await session.stop();
    accept?.(true);
    await rejected;
    expect(vi.mocked(driver).execute).not.toHaveBeenCalled();
    await arm();
    await expect(
      session.execute({ kind: "read", selector: "body" }, state.generation),
    ).rejects.toThrow("armed");
    await session.stop();
  });
  it("refuses arbitrary keys and extra authority fields", async () => {
    const { session, arm } = fixture();
    const state = await arm();
    await expect(
      session.execute({ kind: "key", key: "Control+L" }, state.generation),
    ).rejects.toThrow("key");
    await expect(
      session.execute(
        { kind: "read", selector: "body", allowPrivate: true } as never,
        state.generation,
      ),
    ).rejects.toThrow("action");
    await session.stop();
  });
});
