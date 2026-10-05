import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeDesktopController } from "./runtime-desktop-http.js";
import type { DesktopAction, DesktopDriver } from "./runtime-desktop-session.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-broker-"));
  const calls: DesktopAction[] = [];
  const driver: DesktopDriver = {
    inventory: () =>
      Promise.resolve({
        monitors: [{ id: "left", x: -100, y: 0, width: 100, height: 100, scale: 1 }],
        windows: [{ id: "123", title: "Fixture" }],
      }),
    capture: async () => {
      const localPath = path.join(root, "fixture.png");
      await writeFile(localPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
      return { localPath, width: 100, height: 100 };
    },
    act: async (action) => {
      calls.push(structuredClone(action));
      await Promise.resolve();
    },
    removeCapture: async () => {},
  };
  const controller = new RuntimeDesktopController({ driver });
  await controller.action("inventory", {});
  await controller.action("arm", {
    task: "fixture",
    monitorId: "left",
    windowId: "123",
    confirm: true,
  });
  return {
    controller,
    calls,
    close: async () => {
      controller.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("desktop HTTP consent broker (mock driver only)", () => {
  it("starts disabled and requires explicit arm consent", async () => {
    expect(new RuntimeDesktopController().snapshot().state).toBe("disabled");
    const f = await fixture();
    try {
      await expect(
        f.controller.action("arm", { task: "fixture", monitorId: "left" }),
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
  it("binds immutable exact input once, rejects stale/replayed decisions", async () => {
    const f = await fixture();
    try {
      const generation = f.controller.snapshot().generation;
      const action = { kind: "click", x: -10, y: 10 };
      const pending = f.controller.action("act", { generation, action });
      await new Promise((resolve) => setImmediate(resolve));
      action.x = -99;
      const request = f.controller.snapshot().pendingConsents[0]!;
      expect(request.action).toEqual({ kind: "click", x: -10, y: 10 });
      expect(f.calls).toEqual([]);
      await expect(
        f.controller.action("approval/respond", {
          id: request.id,
          generation: generation + 1,
          decision: "approved",
        }),
      ).rejects.toThrow();
      await f.controller.action("approval/respond", {
        id: request.id,
        generation,
        decision: "approved",
      });
      await pending;
      expect(f.calls).toEqual([{ kind: "click", x: -10, y: 10 }]);
      await expect(
        f.controller.action("approval/respond", {
          id: request.id,
          generation,
          decision: "approved",
        }),
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
  it("stop aborts pending input; screenshot preview is local and export separately confirmed once", async () => {
    const f = await fixture();
    try {
      let generation = f.controller.snapshot().generation;
      const pending = f.controller.action("act", {
        generation,
        action: { kind: "click", x: -10, y: 10 },
      });
      const rejected = expect(pending).rejects.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      await f.controller.action("stop", {});
      await rejected;
      expect(f.calls).toEqual([]);
      await f.controller.action("arm", { task: "fixture", monitorId: "left", confirm: true });
      generation = f.controller.snapshot().generation;
      const capture = (await f.controller.action("capture", { generation })) as {
        artifactId: string;
      };
      expect((await f.controller.preview(generation, capture.artifactId)).subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      await expect(
        f.controller.action("export", { generation, artifactId: capture.artifactId }),
      ).rejects.toThrow();
      const exported = f.controller.action("export", {
        generation,
        artifactId: capture.artifactId,
        confirmTransmission: true,
      });
      await new Promise((resolve) => setImmediate(resolve));
      const consent = f.controller.snapshot().pendingConsents[0]!;
      expect(consent.purpose).toBe("transmission");
      await f.controller.action("approval/respond", {
        id: consent.id,
        generation,
        decision: "approved",
      });
      expect(await exported).toEqual({
        authorized: true,
        artifactId: capture.artifactId,
        transmission: "not-sent",
      });
      await expect(
        f.controller.action("export", {
          generation,
          artifactId: capture.artifactId,
          confirmTransmission: true,
        }),
      ).rejects.toThrow();
      await f.controller.action("stop", {});
      await expect(f.controller.preview(generation, capture.artifactId)).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
});
