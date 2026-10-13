import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import childProcess from "node:child_process";
import { expect, it, vi } from "vitest";
import { createWindowsDiagnosticPreflights } from "./runtime-windows-process-preflight.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zet-preflight-fixture-")));
  const cwd = join(root, "workspace");
  const reservations = join(root, "reservations");
  await mkdir(cwd);
  await mkdir(reservations);
  const host = await createWindowsDiagnosticPreflights(reservations);
  const invocation = {
    runId: "fixture-run",
    logicalEffectId: "fixture-call",
    command: "node-version" as const,
    cwd,
  };
  return { root, cwd, reservations, host, invocation };
}
it("reserves exact frozen host identities without process/profile/ACL effects", async () => {
  const f = await fixture();
  const spawn = vi.spyOn(childProcess, "spawn");
  const exec = vi.spyOn(childProcess, "execFile");
  try {
    const receipt = await f.host.reserve(f.invocation, new AbortController().signal);
    expect(receipt.profile).toMatch(/^zet-harness-[0-9a-f-]{36}$/u);
    expect(receipt.temporary.startsWith(join(f.reservations, "zet-win-process-"))).toBe(true);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.invocation)).toBe(true);
    expect(await readdir(receipt.temporary)).toEqual([]);
    expect(await readdir(f.cwd)).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    const source = await readFile(
      resolve("apps/runtime/src/runtime-windows-process-preflight.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /(?:CreateAppContainerProfile|SetAccessControl|executeWindows|child_process|WINDOWS_PROCESS_BRIDGE)/u,
    );
    expect(f.host.claim(receipt, f.invocation)).toBe(receipt);
    expect(() => f.host.claim(receipt, f.invocation)).toThrow("unavailable or mismatched");
    await f.host.release(receipt);
    await expect(stat(receipt.temporary)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    spawn.mockRestore();
    exec.mockRestore();
    await f.host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
it("rejects forged copies, other host receipts, wrong invocations and added argv", async () => {
  const f = await fixture();
  const second = await createWindowsDiagnosticPreflights(f.reservations);
  try {
    const receipt = await f.host.reserve(f.invocation, new AbortController().signal);
    expect(() => f.host.claim({ ...receipt }, f.invocation)).toThrow();
    expect(() => second.claim(receipt, f.invocation)).toThrow();
    for (const field of ["runId", "logicalEffectId", "cwd"] as const)
      expect(() => f.host.claim(receipt, { ...f.invocation, [field]: "different" })).toThrow();
    expect(() =>
      f.host.claim(receipt, { ...f.invocation, command: "git-status" } as never),
    ).toThrow();
    expect(() =>
      f.host.claim(receipt, { ...f.invocation, argv: ["--version", "-e", "other"] } as never),
    ).toThrow();
    expect(f.host.claim(receipt, f.invocation)).toBe(receipt);
  } finally {
    await f.host.close();
    await second.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
it("cancellation and repeated release invalidate receipts and roll back only reservations", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const receipt = await f.host.reserve(f.invocation, controller.signal);
    controller.abort();
    expect(() => f.host.claim(receipt, f.invocation)).toThrow();
    await f.host.release(receipt);
    await f.host.release(receipt);
    expect(await readdir(f.reservations)).toEqual([]);
    expect((await stat(f.cwd)).isDirectory()).toBe(true);
    await expect(f.host.reserve(f.invocation, controller.signal)).rejects.toThrow();
  } finally {
    await f.host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
it("host close rolls back reserved and claimed receipts", async () => {
  const f = await fixture();
  try {
    const first = await f.host.reserve(f.invocation, new AbortController().signal);
    const second = await f.host.reserve(
      { ...f.invocation, logicalEffectId: "other-call" },
      new AbortController().signal,
    );
    f.host.claim(first, f.invocation);
    await f.host.close();
    expect(await readdir(f.reservations)).toEqual([]);
    await expect(f.host.reserve(f.invocation, new AbortController().signal)).rejects.toThrow();
    expect(() => f.host.claim(first, f.invocation)).toThrow();
    expect(() => f.host.claim(second, second.invocation)).toThrow();
  } finally {
    await f.host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
