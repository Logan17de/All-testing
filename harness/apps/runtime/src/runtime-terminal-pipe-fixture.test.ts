/* eslint-disable @typescript-eslint/require-await -- Fixture adapter follows the async PTY seam; unsupported pipe methods intentionally reject. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  RuntimeTerminalService,
  type SandboxedTerminalAdapter,
} from "./runtime-terminal-service.js";

/** Test-only fixed benign process. Not a PTY, not sandbox verification, and never
 * wired to HTTP or production. No caller supplied command, source, shell or input. */
function fixedPipeFixture(): SandboxedTerminalAdapter {
  return {
    capabilities: {
      interactive: false,
      input: false,
      resize: false,
      interrupt: false,
      mode: "process-output",
    },
    async launch(request) {
      const child = spawn(
        process.execPath,
        [
          "--input-type=commonjs",
          "-e",
          "process.stdout.write('fixture-ready\\n');process.stderr.write('fixture-stderr\\n');setInterval(()=>process.stdout.write('tick\\n'),50);",
        ],
        {
          cwd: request.cwd,
          env: { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" },
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let bytes = 0;
      const emit = (stream: "stdout" | "stderr", chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096) child.kill();
        else request.output(stream, chunk.toString("utf8"));
      };
      child.stdout.on("data", (chunk: Buffer) => emit("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => emit("stderr", chunk));
      const closed = once(child, "close");
      child.on("close", (code) => request.exit(code));
      const timeout = setTimeout(() => child.kill(), 3000);
      child.on("close", () => clearTimeout(timeout));
      const cancel = () => {
        child.kill();
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      child.on("close", () => request.signal.removeEventListener("abort", cancel));
      return {
        input: async () => {
          throw new Error("Fixed pipe fixture has no stdin or interactive authority.");
        },
        resize: async () => {
          throw new Error("Pipes have no PTY geometry; resize unsupported.");
        },
        interrupt: async () => {
          throw new Error("Pipe fixture has no console interrupt support; use close.");
        },
        close: async () => {
          child.kill();
          await closed;
        },
      };
    },
  };
}
describe("real bounded Node pipe fixture (not interactive terminal)", () => {
  it("streams actual stdout/stderr before exit, reconnects and cleans up cancellation", async () => {
    const identity = { ownerKey: "fixture-human", conversationId: "fixture-chat" };
    const service = new RuntimeTerminalService({
      adapter: fixedPipeFixture(),
      validateCwd: async () => process.cwd(),
    });
    try {
      const session = await service.create(identity, "fixture");
      expect(service.capability()).toMatchObject({
        launch: true,
        interactive: false,
        input: false,
        resize: false,
        interrupt: false,
        mode: "process-output",
      });
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const chunks = service.list(identity).sessions[0]?.chunks ?? [];
        if (chunks.some((c) => c.stream === "stdout") && chunks.some((c) => c.stream === "stderr"))
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const view = service.list(identity).sessions[0]!;
      expect(view.status).toBe("running");
      expect(
        view.chunks.some((c) => c.stream === "stdout" && c.text.includes("fixture-ready")),
      ).toBe(true);
      expect(
        view.chunks.some((c) => c.stream === "stderr" && c.text.includes("fixture-stderr")),
      ).toBe(true);
      expect(service.list(identity).sessions[0]?.id).toBe(session.id);
      await expect(service.resize(identity, session.id, 90, 24)).rejects.toThrow(
        "resize unsupported",
      );
      await expect(service.input(identity, session.id, "hello")).rejects.toThrow("no stdin");
      await service.close(identity, session.id);
      expect(service.list(identity).sessions).toEqual([]);
    } finally {
      await service.dispose();
    }
  });
});
