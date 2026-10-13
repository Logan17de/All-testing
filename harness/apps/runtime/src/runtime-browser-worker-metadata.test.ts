import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { browserExecutableMetadata } from "./runtime-browser-worker-metadata.js";
it("returns only fixed executable existence and full revision booleans", async () => {
  const root = await mkdtemp(join(tmpdir(), "zet-browser-metadata-"));
  try {
    const file = join(root, "PRIVATE_PATH");
    await writeFile(file, "fixture");
    expect(await browserExecutableMetadata(file)).toEqual({
      executablePresent: true,
      expectedRevision: false,
    });
    expect(await browserExecutableMetadata(join(root, "absent"))).toEqual({
      executablePresent: false,
      expectedRevision: false,
    });
    expect(await browserExecutableMetadata(root)).toEqual({
      executablePresent: false,
      expectedRevision: false,
    });
    const full = await browserExecutableMetadata(
      "C:\\private\\chromium-1243\\chrome-win64\\chrome.exe",
    );
    expect(full.expectedRevision).toBe(true);
    expect(JSON.stringify(full)).not.toContain("private");
    expect(
      (
        await browserExecutableMetadata(
          "C:\\private\\chromium_headless_shell-1243\\chrome-win64\\chrome.exe",
        )
      ).expectedRevision,
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
