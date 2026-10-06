import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { AdapterInvocationContext } from "@zet-harness/plugin-api";
import { RuntimeDesktopController } from "./runtime-desktop-http.js";
import { RuntimeCodingImageStore } from "./runtime-coding-image-store.js";
import { createRuntimeCodingDesktopTools } from "./runtime-coding-desktop-tools.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhb0AAAAASUVORK5CYII=",
  "base64",
);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-native-"));
  let current = true,
    calls = 0;
  const controller = new RuntimeDesktopController({
    driver: {
      inventory: () =>
        Promise.resolve({
          monitors: [{ id: "m", x: 0, y: 0, width: 1, height: 1, scale: 1 }],
          windows: [{ id: "123", title: "Fixture" }],
        }),
      capture: async () => {
        const localPath = path.join(root, "synthetic.png");
        await writeFile(localPath, png);
        return { localPath, width: 1, height: 1 };
      },
      act: async () => {
        calls++;
        await Promise.resolve();
      },
      removeCapture: async () => {},
    },
  });
  await controller.action("inventory", {});
  await controller.action("arm", {
    task: "synthetic fixture",
    monitorId: "m",
    windowId: "123",
    confirm: true,
  });
  const authority = {
    runId: "r",
    sessionId: "s",
    modelId: "model",
    accountId: "account-digest",
    root,
    desktopGeneration: controller.snapshot().generation,
  };
  const store = new RuntimeCodingImageStore({ isCurrent: () => current });
  const tools = createRuntimeCodingDesktopTools({ controller, authority, imageStore: store });
  const context = (
    id: string,
    signal = new AbortController().signal,
  ): AdapterInvocationContext => ({
    runId: "r",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "e",
    signal,
    toolScope: [id],
    retryBudget: {
      maxAttempts: 1,
      repeatAuthorized: false,
      usedAttempts: 1,
      remainingAttempts: 0,
      reportInternalRetries: () => 0,
    },
  });
  return {
    controller,
    authority,
    store,
    tools,
    context,
    revoke: () => {
      current = false;
    },
    calls: () => calls,
    close: async () => {
      controller.close();
      store.clear();
      await rm(root, { recursive: true, force: true });
    },
  };
}
it("synthetic capture is local; separate exact destination approval creates only opaque turn lease", async () => {
  const f = await fixture();
  try {
    const capture = f.tools.find((t) => t.manifest.id.endsWith(".capture"))!;
    const share = f.tools.find((t) => t.manifest.id.endsWith(".share"))!;
    const result = await capture.invoke({}, f.context(capture.manifest.id));
    expect(JSON.stringify(result)).not.toContain("synthetic.png");
    expect(f.store.partsFor(f.authority)).toEqual([]);
    const artifactId = (result.value as { artifactId: string }).artifactId;
    const pending = share.invoke({ artifactId, maxUses: 2 }, f.context(share.manifest.id));
    await new Promise((resolve) => setImmediate(resolve));
    const consent = f.controller.snapshot().pendingConsents[0]!;
    expect(consent.destination).toMatchObject({
      runId: "r",
      sessionId: "s",
      modelId: "model",
      accountId: "account-digest",
      maxUses: 2,
    });
    expect(consent.captureScope).toEqual({
      monitorId: "m",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      windowId: "123",
    });
    expect(f.store.partsFor(f.authority)).toEqual([]);
    await f.controller.action("approval/respond", {
      id: consent.id,
      generation: consent.generation,
      decision: "approved",
    });
    const shared = await pending;
    expect(JSON.stringify(shared)).not.toContain("base64");
    const part = f.store.partsFor(f.authority)[0]!;
    expect(
      await f.store.resolve(part.artifactRef, f.authority, new AbortController().signal),
    ).toEqual(png);
  } finally {
    await f.close();
  }
});
it("node scope absence and authority revoked during input consent cannot execute", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.find((t) => t.manifest.id.endsWith(".input"))!;
    await expect(
      tool.invoke(
        { action: { kind: "click", x: 0, y: 0 } },
        { ...f.context(tool.manifest.id), toolScope: [] },
      ),
    ).rejects.toThrow();
    expect(f.controller.snapshot().pendingConsents).toEqual([]);
    const pending = tool.invoke(
      { action: { kind: "click", x: 0, y: 0 } },
      f.context(tool.manifest.id),
    );
    const rejection = expect(pending).rejects.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    const consent = f.controller.snapshot().pendingConsents[0]!;
    f.revoke();
    await f.controller.action("approval/respond", {
      id: consent.id,
      generation: consent.generation,
      decision: "approved",
    });
    await rejection;
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});
it("cancellation aborts pending human input and closes task with no fallback", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.find((t) => t.manifest.id.endsWith(".input"))!;
    const abort = new AbortController();
    const pending = tool.invoke(
      { action: { kind: "click", x: 0, y: 0 } },
      f.context(tool.manifest.id, abort.signal),
    );
    const rejection = expect(pending).rejects.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await rejection;
    expect(f.calls()).toBe(0);
    expect(f.controller.snapshot().state).not.toBe("armed");
    expect(
      createRuntimeCodingDesktopTools({
        controller: f.controller,
        authority: f.authority,
        imageStore: f.store,
      }),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});
