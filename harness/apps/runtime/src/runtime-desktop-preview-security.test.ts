import type * as FilePromises from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { DesktopDriver } from "./runtime-desktop-session.js";
const fake = vi.hoisted(() => ({
  growth: true,
  nlink: 1,
  closed: false,
  readLengths: [] as number[],
  hook: (): void => undefined,
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof FilePromises>()),
  open: () =>
    Promise.resolve({
      stat: () => Promise.resolve({ isFile: () => true, size: 8, nlink: fake.nlink }),
      readFile: () => {
        throw new Error("Unbounded read must never run.");
      },
      read: (buffer: Buffer, offset: number, length: number, position: number) => {
        fake.readLengths.push(length);
        fake.hook();
        if (position === 0) Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, offset);
        return Promise.resolve({
          bytesRead: fake.growth ? length : position === 0 ? 8 : 0,
          buffer,
        });
      },
      close: () => {
        fake.closed = true;
        return Promise.resolve();
      },
    }),
}));
import { RuntimeDesktopController } from "./runtime-desktop-http.js";
async function fixture() {
  fake.closed = false;
  fake.nlink = 1;
  fake.readLengths = [];
  fake.hook = () => undefined;
  const driver: DesktopDriver = {
    inventory: () =>
      Promise.resolve({
        monitors: [{ id: "monitor", x: 0, y: 0, width: 100, height: 100, scale: 1 }],
        windows: [],
      }),
    capture: () => Promise.resolve({ localPath: "private-fixture.png", width: 100, height: 100 }),
    act: () => Promise.resolve(),
    removeCapture: () => Promise.resolve(),
  };
  const controller = new RuntimeDesktopController({ driver });
  await controller.action("inventory", {});
  await controller.action("arm", { task: "Fixture", monitorId: "monitor", confirm: true });
  const generation = controller.snapshot().generation;
  const capture = (await controller.action("capture", { generation })) as { artifactId: string };
  return { controller, generation, ...capture };
}
it("bounds a screenshot that grows after stat and closes its handle", async () => {
  fake.growth = true;
  const f = await fixture();
  try {
    await expect(f.controller.preview(f.generation, f.artifactId)).rejects.toThrow("exceeds limit");
    expect(fake.readLengths).toEqual([32 * 1024 * 1024 + 1]);
    expect(fake.closed).toBe(true);
  } finally {
    f.controller.close();
  }
});
it("revokes preview when the desktop generation changes during file read", async () => {
  fake.growth = false;
  const f = await fixture();
  fake.hook = () => f.controller.close();
  await expect(f.controller.preview(f.generation, f.artifactId)).rejects.toThrow("inactive");
  expect(fake.closed).toBe(true);
});

it("refuses a multiply linked local capture before reading pixels", async () => {
  const f = await fixture();
  fake.nlink = 2;
  try {
    await expect(f.controller.preview(f.generation, f.artifactId)).rejects.toThrow(
      "Invalid local preview",
    );
    expect(fake.readLengths).toEqual([]);
    expect(fake.closed).toBe(true);
  } finally {
    f.controller.close();
  }
});
