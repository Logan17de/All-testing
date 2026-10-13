import { afterEach, expect, it, vi } from "vitest";
import { postToRuntime } from "./runtime-client";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function delayedRuntime(delay: number) {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), milliseconds);
    return controller.signal;
  });
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/session"))
      return Promise.resolve(Response.json({ csrfToken: "fixture-only" }));
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ result: "fixture" })), delay);
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("fixture request aborted"));
        },
        { once: true },
      );
    });
  });
}

it("allows cold browser preparation that exceeds the ordinary proxy deadline", async () => {
  vi.useFakeTimers();
  delayedRuntime(18_000);
  const response = postToRuntime("/api/browser", { action: "arm", params: {} });
  await vi.advanceTimersByTimeAsync(18_000);
  expect(await response).toEqual({ status: 200, body: { result: "fixture" } });
});

it("keeps non-browser requests bounded despite a caller timeout field", async () => {
  vi.useFakeTimers();
  delayedRuntime(18_000);
  const response = postToRuntime("/api/agent", { action: "arm", timeoutMs: 50_000 });
  await vi.advanceTimersByTimeAsync(18_000);
  expect(await response).toMatchObject({
    status: 503,
    body: { error: { code: "RUNTIME_UNREACHABLE" } },
  });
});

it("bounds browser initialization even when a worker never replies", async () => {
  vi.useFakeTimers();
  delayedRuntime(60_000);
  const response = postToRuntime("/api/browser", { action: "arm", timeoutMs: 999_999 });
  await vi.advanceTimersByTimeAsync(50_000);
  expect(await response).toMatchObject({ status: 503 });
});
