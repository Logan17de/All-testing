import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMinimalEnvironment, runBoundedProcess } from "./process-runner.js";

const NODE = process.execPath;

let workdir: string;

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), "zet-proc-"));
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true, maxRetries: 3 });
});

function run(
  args: readonly string[],
  options: Parameters<typeof runBoundedProcess>[0] extends never
    ? never
    : Partial<Parameters<typeof runBoundedProcess>[0]> = {},
) {
  return runBoundedProcess({
    command: NODE,
    args,
    cwd: workdir,
    env: createMinimalEnvironment(),
    ...options,
  });
}

describe("runBoundedProcess basics", () => {
  it("captures stdout from a successful run", async () => {
    const result = await run(["-e", "process.stdout.write('hello')"]);
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  it("captures stderr separately", async () => {
    const result = await run(["-e", "process.stderr.write('problem')"]);
    expect(result.stderr).toBe("problem");
    expect(result.stdout).toBe("");
  });

  it("treats a non-zero exit as a result, not a harness failure", async () => {
    const result = await run(["-e", "process.exit(3)"]);
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(3);
  });

  it("reports a spawn failure instead of throwing", async () => {
    const result = await runBoundedProcess({
      command: join(workdir, "definitely-not-an-executable"),
      args: [],
      cwd: workdir,
      env: createMinimalEnvironment(),
    });
    expect(result.outcome).toBe("spawn-failed");
    expect(result.exitCode).toBeNull();
  });

  it("runs in the requested working directory", async () => {
    const result = await run(["-e", "process.stdout.write(process.cwd())"]);
    // macOS reports /private/var for /var, so compare the trailing segment.
    expect(result.stdout.endsWith(workdir.split(/[\\/]/u).pop() ?? "")).toBe(true);
  });

  it("reports a duration", async () => {
    const result = await run(["-e", "0"]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("drains output from a process that exits immediately after writing", async () => {
    const result = await run(["-e", "process.stdout.write('x'.repeat(5000)); process.exit(0)"]);
    expect(result.stdout).toHaveLength(5000);
  });
});

describe("argument handling", () => {
  it("never interprets arguments through a shell", async () => {
    // If a shell were involved this would run two commands and/or expand the
    // variable. Spawned directly, it is one literal argument.
    const payload = "hi; echo pwned $HOME `whoami`";
    const result = await run(["-e", "process.stdout.write(process.argv[1] ?? '')", payload]);
    expect(result.stdout).toBe(payload);
    expect(result.stdout).not.toContain("pwned\n");
  });

  it("passes arguments containing spaces and quotes intact", async () => {
    const payload = 'a "quoted" value';
    const result = await run(["-e", "process.stdout.write(process.argv[1] ?? '')", payload]);
    expect(result.stdout).toBe(payload);
  });
});

describe("environment isolation", () => {
  it("does not inherit the harness environment", async () => {
    process.env["ZET_TEST_SECRET"] = "super-secret-value";
    try {
      const result = await run([
        "-e",
        "process.stdout.write(String(process.env.ZET_TEST_SECRET ?? 'absent'))",
      ]);
      expect(result.stdout).toBe("absent");
    } finally {
      delete process.env["ZET_TEST_SECRET"];
    }
  });

  it("passes explicitly supplied variables", async () => {
    const result = await runBoundedProcess({
      command: NODE,
      args: ["-e", "process.stdout.write(String(process.env.ZET_ALLOWED ?? 'absent'))"],
      cwd: workdir,
      env: createMinimalEnvironment({ ZET_ALLOWED: "visible" }),
    });
    expect(result.stdout).toBe("visible");
  });

  it("keeps PATH so an executable can still be found", () => {
    const env = createMinimalEnvironment();
    const hasPath = typeof env["PATH"] === "string" || typeof env["Path"] === "string";
    expect(hasPath).toBe(true);
  });

  it("does not copy unrelated harness variables", () => {
    process.env["ZET_UNRELATED"] = "value";
    try {
      expect(createMinimalEnvironment()["ZET_UNRELATED"]).toBeUndefined();
    } finally {
      delete process.env["ZET_UNRELATED"];
    }
  });
});

describe("time limits", () => {
  it("stops a process that outlives its budget", async () => {
    const result = await run(["-e", "setTimeout(() => {}, 60000)"], {
      limits: { timeoutMs: 300, killGraceMs: 200 },
    });
    expect(result.outcome).toBe("timed-out");
  });

  it("does not report a timeout for a process that finishes in time", async () => {
    const result = await run(["-e", "process.stdout.write('fast')"], {
      limits: { timeoutMs: 10_000 },
    });
    expect(result.outcome).toBe("exited");
  });

  it("keeps the output produced before a timeout", async () => {
    const result = await run(
      ["-e", "process.stdout.write('partial'); setTimeout(() => {}, 60000)"],
      { limits: { timeoutMs: 400, killGraceMs: 200 } },
    );
    expect(result.stdout).toContain("partial");
    expect(result.outcome).toBe("timed-out");
  });
});

describe("output limits", () => {
  it("stops a process that floods stdout", async () => {
    const result = await run(
      ["-e", "for (let i = 0; i < 100000; i += 1) process.stdout.write('x'.repeat(1000));"],
      { limits: { maxOutputBytes: 2048, timeoutMs: 15_000, killGraceMs: 200 } },
    );
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(2048);
  });

  it("bounds stderr independently", async () => {
    const result = await run(
      ["-e", "for (let i = 0; i < 100000; i += 1) process.stderr.write('e'.repeat(1000));"],
      { limits: { maxOutputBytes: 1024, timeoutMs: 15_000, killGraceMs: 200 } },
    );
    expect(result.stderrTruncated).toBe(true);
    expect(result.stderr.length).toBeLessThanOrEqual(1024);
  });

  it("does not mark a small output as truncated", async () => {
    const result = await run(["-e", "process.stdout.write('tiny')"], {
      limits: { maxOutputBytes: 1024 },
    });
    expect(result.stdoutTruncated).toBe(false);
  });
});

describe("cancellation", () => {
  it("returns immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run(["-e", "setTimeout(() => {}, 60000)"], {
      signal: controller.signal,
    });
    expect(result.outcome).toBe("cancelled");
  });

  it("stops a running process when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = run(["-e", "setTimeout(() => {}, 60000)"], {
      signal: controller.signal,
      limits: { timeoutMs: 30_000, killGraceMs: 200 },
    });
    setTimeout(() => {
      controller.abort();
    }, 200);
    const result = await pending;
    expect(result.outcome).toBe("cancelled");
  });

  it("keeps the first stop reason when cancellation follows a timeout", async () => {
    const controller = new AbortController();
    const pending = run(["-e", "setTimeout(() => {}, 60000)"], {
      signal: controller.signal,
      limits: { timeoutMs: 200, killGraceMs: 2000 },
    });
    setTimeout(() => {
      controller.abort();
    }, 600);
    const result = await pending;
    expect(result.outcome).toBe("timed-out");
  });
});

describe("process-tree cancellation", () => {
  it("kills a grandchild, not just the direct child", async () => {
    // The parent spawns a detached grandchild that writes a marker file after a
    // delay. Killing only the parent would leave the grandchild alive and the
    // marker would appear.
    const marker = join(workdir, `grandchild-${String(Date.now())}.txt`);
    const grandchild = join(workdir, "grandchild.cjs");
    const script = join(workdir, "spawner.cjs");

    // The marker path travels as an argument rather than being interpolated
    // into source text, so Windows backslashes cannot break the fixture.
    await writeFile(
      grandchild,
      `const fs = require("node:fs");
const target = process.argv[2];
setTimeout(() => { fs.writeFileSync(target, "alive"); }, 2500);
`,
      "utf8",
    );
    await writeFile(
      script,
      `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: "ignore" });
process.stdout.write("spawned:" + String(child.pid));
setTimeout(() => {}, 60000);
`,
      "utf8",
    );

    const result = await run([script, grandchild, marker], {
      limits: { timeoutMs: 500, killGraceMs: 200 },
    });
    expect(result.outcome).toBe("timed-out");
    expect(result.stdout).toContain("spawned:");

    // Wait past the point where a surviving grandchild would have written.
    await new Promise((resolveWait) => setTimeout(resolveWait, 3500));

    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  }, 20_000);
});
