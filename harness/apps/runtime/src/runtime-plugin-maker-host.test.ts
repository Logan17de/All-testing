import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimePluginMaker } from "./runtime-plugin-maker.js";
import { createRuntimePluginMakerHost } from "./runtime-plugin-maker-host.js";
import type { runSandboxedProjectCommand } from "./runtime-process-sandbox.js";

let temporary: string, workspace: string, plugins: string;
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "zet-maker-host-fixture-"));
  workspace = join(temporary, "workspace");
  plugins = join(temporary, "installed");
  await mkdir(workspace);
  await mkdir(plugins);
});
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});
function fixture() {
  const authority = Object.freeze({});
  let generation = 1;
  let privatePaths: readonly string[] = [];
  let installDirectory = plugins;
  const maker = createRuntimePluginMaker(
    { write: () => Promise.reject(new Error("unused")) },
    authority,
  );
  const artifact = maker.scaffold({ id: "com.fixture.generated", name: "Fixture" });
  const approve = vi.fn(() => Promise.resolve(true));
  const sandbox = vi.fn<typeof runSandboxedProjectCommand>(async (request, options) => {
    expect(options?.privatePaths).toEqual(privatePaths);
    expect(Object.isFrozen(options?.privatePaths)).toBe(true);
    expect(request.cwd).not.toBe(join(workspace, "generated"));
    expect(request.command).toBe("project-test");
    expect(await readFile(join(request.cwd, "index.mjs"), "utf8")).toBe(
      artifact.files.find((file) => file.path === "index.mjs")!.content,
    );
    return {
      outcome: "exited",
      exitCode: 0,
      signal: null,
      stdout: "fixture only",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
    };
  });
  const host = createRuntimePluginMakerHost(
    {
      workspaceRoot: () => workspace,
      scopeGeneration: () => generation,
      privatePaths: () => privatePaths,
      pluginOptions: () => ({ directory: installDirectory }),
      approve,
      sandbox,
    },
    authority,
  );
  return {
    authority,
    artifact,
    host,
    approve,
    sandbox,
    invalidate: () => {
      generation++;
    },
    setPrivatePaths: (value: readonly string[]) => {
      privatePaths = value;
    },
    setInstallDirectory: (value: string) => {
      installDirectory = value;
    },
    signal: new AbortController().signal,
  };
}
it.runIf(process.platform === "linux")(
  "materializes exact artifacts, tests an isolated immutable copy, and configures reviewed zero-grant install without importing",
  async () => {
    const f = fixture();
    await f.host.materialize(f.authority, f.artifact, "generated", f.signal);
    await expect(
      f.host.materialize(f.authority, f.artifact, "generated", f.signal),
    ).rejects.toThrow();
    expect(await readdir(plugins)).toEqual([]);
    expect(await f.host.test(f.authority, f.artifact, "generated", f.signal)).toMatchObject({
      executed: true,
      passed: true,
      mode: "required-os-sandbox",
    });
    const result = await f.host.enable(
      f.authority,
      f.artifact,
      "generated",
      { confirmTrustedCodeExecution: true },
      f.signal,
    );
    expect(result).toMatchObject({ enabled: true, restartRequired: true, grantedCapabilities: [] });
    expect(JSON.parse(await readFile(join(plugins, "plugins.json"), "utf8")) as unknown).toEqual({
      plugins: [{ id: "com.fixture.generated", enabled: true, grantedCapabilities: [] }],
    });
    for (const file of f.artifact.files)
      expect(await readFile(join(plugins, "com.fixture.generated", file.path), "utf8")).toBe(
        file.content,
      );
    expect(f.sandbox).toHaveBeenCalledTimes(1);
  },
);
it.runIf(process.platform === "linux")(
  "requires human authority and current proof after approval before writing",
  async () => {
    const f = fixture();
    await expect(f.host.materialize({}, f.artifact, "generated", f.signal)).rejects.toThrow(
      "refused",
    );
    expect(f.approve).not.toHaveBeenCalled();
    f.approve.mockImplementationOnce(() => {
      f.invalidate();
      return Promise.resolve(true);
    });
    await expect(
      f.host.materialize(f.authority, f.artifact, "generated", f.signal),
    ).rejects.toThrow();
    expect(await readdir(workspace)).toEqual([]);
    const g = fixture();
    let live = true;
    g.approve.mockImplementationOnce(() => {
      live = false;
      return Promise.resolve(true);
    });
    await expect(
      g.host.materialize(g.authority, g.artifact, "generated", {
        signal: g.signal,
        check: () => {
          if (!live) throw new Error("stale operation");
        },
      }),
    ).rejects.toThrow();
    expect(await readdir(workspace)).toEqual([]);
  },
);
it.runIf(process.platform === "linux")(
  "refuses altered files, extra files, invalid digest, and enable without successful scoped test",
  async () => {
    const f = fixture();
    await expect(
      f.host.materialize(
        f.authority,
        { ...f.artifact, hash: "0".repeat(64) },
        "generated",
        f.signal,
      ),
    ).rejects.toThrow();
    await f.host.materialize(f.authority, f.artifact, "generated", f.signal);
    await expect(
      f.host.enable(
        f.authority,
        f.artifact,
        "generated",
        { confirmTrustedCodeExecution: true },
        f.signal,
      ),
    ).rejects.toThrow();
    await writeFile(join(workspace, "generated", "extra.md"), "extra");
    await expect(f.host.test(f.authority, f.artifact, "generated", f.signal)).rejects.toThrow(
      "refused",
    );
    expect(f.sandbox).not.toHaveBeenCalled();
    await rm(join(workspace, "generated", "extra.md"));
    await writeFile(join(workspace, "generated", "index.mjs"), "throw new Error('changed');");
    await expect(f.host.test(f.authority, f.artifact, "generated", f.signal)).rejects.toThrow(
      "refused",
    );
    expect(f.sandbox).not.toHaveBeenCalled();
    expect(await readdir(plugins)).toEqual([]);
  },
);
it.runIf(process.platform === "linux")(
  "sandbox refusal has no host fallback and cannot authorize enable",
  async () => {
    const f = fixture();
    await f.host.materialize(f.authority, f.artifact, "generated", f.signal);
    f.sandbox.mockRejectedValueOnce(new Error("kernel sandbox unavailable"));
    await expect(f.host.test(f.authority, f.artifact, "generated", f.signal)).rejects.toThrow(
      "refused",
    );
    await expect(
      f.host.enable(
        f.authority,
        f.artifact,
        "generated",
        { confirmTrustedCodeExecution: true },
        f.signal,
      ),
    ).rejects.toThrow();
    expect(f.sandbox).toHaveBeenCalledTimes(1);
    expect(await readdir(plugins)).toEqual([]);
  },
);
it.runIf(process.platform !== "linux")(
  "fails closed on platforms without confined maker host implementation",
  async () => {
    const f = fixture();
    await expect(
      f.host.materialize(f.authority, f.artifact, "generated", f.signal),
    ).rejects.toThrow();
    expect(f.approve).not.toHaveBeenCalled();
    expect(f.sandbox).not.toHaveBeenCalled();
  },
);

it.runIf(process.platform === "linux")(
  "rejects private overlaps and workspace-looking dotdot install names before mutation",
  async () => {
    const f = fixture();
    f.setPrivatePaths([join(workspace, "generated", "index.mjs")]);
    await expect(
      f.host.materialize(f.authority, f.artifact, "generated", f.signal),
    ).rejects.toThrow();
    expect(f.approve).not.toHaveBeenCalled();
    expect(await readdir(workspace)).toEqual([]);
    f.setPrivatePaths([join(temporary, "private.db")]);
    await f.host.materialize(f.authority, f.artifact, "generated", f.signal);
    await f.host.test(f.authority, f.artifact, "generated", f.signal);
    const nested = join(workspace, "..installed");
    await mkdir(nested);
    f.setInstallDirectory(nested);
    await expect(
      f.host.enable(
        f.authority,
        f.artifact,
        "generated",
        { confirmTrustedCodeExecution: true },
        f.signal,
      ),
    ).rejects.toThrow();
    expect(await readdir(nested)).toEqual([]);
  },
);

it.runIf(process.platform === "linux")(
  "creates confined approved parent directories without overwriting existing artifact files",
  async () => {
    const f = fixture();
    await f.host.materialize(f.authority, f.artifact, "drafts/nested/generated", f.signal);
    expect(await readFile(join(workspace, "drafts/nested/generated/index.mjs"), "utf8")).toBe(
      f.artifact.files.find((file) => file.path === "index.mjs")!.content,
    );
    await expect(
      f.host.materialize(f.authority, f.artifact, "drafts/nested/generated", f.signal),
    ).rejects.toThrow();
    expect(await readFile(join(workspace, "drafts/nested/generated/index.mjs"), "utf8")).toBe(
      f.artifact.files.find((file) => file.path === "index.mjs")!.content,
    );
  },
);

it.runIf(process.platform === "linux")(
  "refuses unsigned activation before writes when trusted host requires integrity",
  async () => {
    const f = fixture();
    const host = createRuntimePluginMakerHost(
      {
        workspaceRoot: () => workspace,
        scopeGeneration: () => 1,
        privatePaths: () => [],
        pluginOptions: () => ({ directory: plugins, requireIntegrity: true }),
        approve: () => Promise.resolve(true),
        sandbox: f.sandbox,
      },
      f.authority,
    );
    await host.materialize(f.authority, f.artifact, "generated", f.signal);
    await host.test(f.authority, f.artifact, "generated", f.signal);
    await expect(
      host.enable(
        f.authority,
        f.artifact,
        "generated",
        { confirmTrustedCodeExecution: true },
        f.signal,
      ),
    ).rejects.toThrow();
    expect(await readdir(plugins)).toEqual([]);
  },
);
