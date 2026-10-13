import { describe, expect, it } from "vitest";
import {
  preflightHumanTerminalJob,
  fixedHumanTerminalShell,
} from "./runtime-terminal-job-launcher.js";
describe.skipIf(process.platform !== "win32")(
  "native terminal compile-only preflight (no PTY spawn)",
  () => {
    it("compiles exact Job Object bridge and advertises inherited Windows identity", async () => {
      const result = await preflightHumanTerminalJob();
      expect(result.windowsIdentity).toMatch(/^[^\\]+\\[^\\]+$/u);
      expect(result.shell).toBe(await fixedHumanTerminalShell());
    }, 75000);
  },
);
