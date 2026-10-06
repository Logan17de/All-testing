// Live Linux OS sandbox, synthetic temporary plugin only. No provider/auth/user workspace.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimePluginMaker } from "../apps/runtime/dist/runtime-plugin-maker.js";
import { createRuntimePluginMakerHost } from "../apps/runtime/dist/runtime-plugin-maker-host.js";
import { loadRuntimePlugins } from "../apps/runtime/dist/runtime-plugins.js";

assert.equal(process.platform, "linux", "Linux maker sandbox acceptance requires Linux");
assert.ok(process.env.ZET_NPM_CLI, "Configure the trusted npm CLI for the OS sandbox");
const temporary = await mkdtemp(join(tmpdir(), "zet-live-maker-"));
let activated;
try {
  const workspace = join(temporary, "workspace"),
    directory = join(temporary, "installed");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const authority = Object.freeze({});
  const maker = createRuntimePluginMaker(
    { write: () => Promise.reject(new Error("unused")) },
    authority,
  );
  const artifact = maker.scaffold({
    id: "com.fixture.makerlive",
    name: "Synthetic live maker fixture",
  });
  const approvals = [];
  const host = createRuntimePluginMakerHost(
    {
      workspaceRoot: () => workspace,
      scopeGeneration: () => 1,
      privatePaths: () => [],
      pluginOptions: () => ({ directory }),
      approve: async (request) => {
        approvals.push(request);
        return true;
      },
    },
    authority,
  );
  const signal = new AbortController().signal;
  await host.materialize(authority, artifact, "generated", signal);
  await assert.rejects(
    host.enable(authority, artifact, "generated", { confirmTrustedCodeExecution: true }, signal),
  );
  const tested = await host.test(authority, artifact, "generated", signal);
  assert.equal(tested.passed, true);
  assert.equal(tested.mode, "required-os-sandbox");
  const enabled = await host.enable(
    authority,
    artifact,
    "generated",
    { confirmTrustedCodeExecution: true },
    signal,
  );
  assert.equal(enabled.restartRequired, true);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "plugins.json"), "utf8")), {
    plugins: [{ id: "com.fixture.makerlive", enabled: true, grantedCapabilities: [] }],
  });
  activated = await loadRuntimePlugins({ directory });
  assert.deepEqual(activated.report.failures, []);
  assert.deepEqual(activated.report.activated, ["com.fixture.makerlive"]);
  assert.deepEqual(
    approvals.map((request) => request.action),
    ["materialize", "test", "enable"],
  );
  console.log(
    "PASS native plugin maker: exact materialization, real OS-sandbox node test, zero-grant reviewed enable, synthetic loader restart activation",
  );
} finally {
  if (activated) {
    for (const sandbox of activated.sandboxes) await sandbox.close();
    await activated.host.dispose();
  }
  await rm(temporary, { recursive: true, force: true });
}
