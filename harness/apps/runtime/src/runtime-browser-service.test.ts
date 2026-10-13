import { expect, it, vi } from "vitest";
import type { AdapterInvocationContext } from "@zet-harness/plugin-api";
import { RuntimeBrowserService } from "./runtime-browser-service.js";
import { createRuntimeBrowserTools } from "./runtime-browser-tools.js";
function fixture() {
  let root = "/workspace/a";
  const execute = vi.fn(() => Promise.resolve("visible text"));
  const service = new RuntimeBrowserService({
    cwd: () => root,
    createScope: () => ({ permits: () => true, pin: () => Promise.resolve([]) }),
    createDriver: () => Promise.resolve({ execute, close: () => Promise.resolve() }),
  });
  const arm = () =>
    service.action("arm", {
      task: "fixture",
      domains: ["allowed.org"],
      minutes: 1,
      maxActions: 10,
      confirm: true,
    });
  return {
    service,
    execute,
    arm,
    changeRoot: () => {
      root = "/workspace/b";
    },
  };
}
function context(): AdapterInvocationContext {
  return {
    runId: "r",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "e",
    signal: new AbortController().signal,
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => 0,
    },
  };
}
it("native browser input executes only after exact generation-bound approval", async () => {
  const { service, execute, arm } = fixture();
  await arm();
  const state = service.snapshot();
  const pending = service.action("execute", {
    generation: state.generation,
    input: { kind: "click", selector: "button" },
  });
  await Promise.resolve();
  const request = service.snapshot().pendingInputs[0]!;
  expect(request.action).toEqual({ kind: "click", selector: "button" });
  expect(execute).not.toHaveBeenCalled();
  await expect(
    service.action("approval/respond", {
      id: request.id,
      generation: state.generation - 1,
      decision: "approved",
    }),
  ).rejects.toThrow("Expired");
  await service.action("approval/respond", {
    id: request.id,
    generation: state.generation,
    decision: "approved",
  });
  expect(await pending).toBe("visible text");
  expect(execute).toHaveBeenCalledTimes(1);
  await service.close();
});
it("workspace switch revokes pending inputs and stale native tools", async () => {
  const { service, execute, arm, changeRoot } = fixture();
  await arm();
  const tool = createRuntimeBrowserTools(service).find(
    (entry) => entry.manifest.id === "harness.browser.click",
  )!;
  const pending = tool.invoke({ selector: "button" }, context());
  const rejected = expect(pending).rejects.toThrow();
  await Promise.resolve();
  changeRoot();
  expect(service.snapshot().armed).toBe(false);
  await rejected;
  expect(execute).not.toHaveBeenCalled();
  await arm();
  await expect(tool.invoke({ selector: "button" }, context())).rejects.toThrow("armed");
  await service.close();
});
it("workspace cleanup rejection is handled after authority is revoked", async () => {
  const { service, arm, changeRoot } = fixture();
  await arm();
  const stop = service.session.stop.bind(service.session);
  const failing = vi.spyOn(service.session, "stop").mockImplementation(() =>
    stop().then(() => {
      throw new Error("Private cleanup failure");
    }),
  );
  changeRoot();
  expect(service.snapshot().armed).toBe(false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  failing.mockRestore();
  await service.close();
});
it("tool cancellation handles rejected cleanup without continuing execution", async () => {
  const { service, arm } = fixture();
  await arm();
  const tool = createRuntimeBrowserTools(service).find(
    (entry) => entry.manifest.id === "harness.browser.read",
  )!;
  const close = service.close.bind(service);
  const failing = vi.spyOn(service, "close").mockImplementation(() =>
    close().then(() => {
      throw new Error("Private cleanup failure");
    }),
  );
  const controller = new AbortController();
  const pending = tool.invoke({ selector: "body" }, { ...context(), signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow();
  controller.abort();
  await rejected;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(service.snapshot().armed).toBe(false);
  failing.mockRestore();
  await service.close();
});
