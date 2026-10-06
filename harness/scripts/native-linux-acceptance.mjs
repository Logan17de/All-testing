// Live kernel acceptance uses only synthetic temporary data and an ephemeral local repository.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import {
  runSandboxedProcess,
  runSandboxedProjectCommand,
  runSandboxedManagedWorktree,
} from "../apps/runtime/dist/runtime-process-sandbox.js";
import { createRuntimeWorktreeTools } from "../apps/runtime/dist/runtime-coding-worktrees.js";
// This fixed, output-bounded probe distinguishes kernel namespace refusal from harness setup.
// It runs only /usr/bin/true and does not read application data or accept source/arguments.
execFileSync(
  "/usr/bin/bwrap",
  ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "--", "/usr/bin/true"],
  { env: {}, timeout: 10000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] },
);
console.log("LINUX_NAMESPACE_PREFLIGHT_OK");
const temporary = await mkdtemp(join(tmpdir(), "zet-linux-native-"));
const server = createServer((socket) => socket.destroy());
try {
  const root = join(temporary, "project");
  await mkdir(root);
  const diagnostic = await runSandboxedProcess({
    command: process.execPath,
    args: ["--version"],
    cwd: root,
    env: {},
  });
  assert.equal(diagnostic.exitCode, 0);
  assert.match(diagnostic.stdout, /^v24\./);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const outside = join(temporary, "outside.txt");
  await writeFile(outside, "SYNTHETIC-OUTSIDE-FIXTURE");
  await writeFile(join(root, ".env"), "SYNTHETIC-CREDENTIAL-FIXTURE");
  const privatePaths = ["private-state.db", "private-state.db-wal", "private-state.db-shm"].map(
    (name) => join(root, name),
  );
  for (const path of privatePaths) await writeFile(path, "SYNTHETIC-PRIVATE-STATE");
  const publicDependency = join(root, "node_modules/public-fixture");
  await mkdir(publicDependency, { recursive: true });
  await writeFile(join(publicDependency, "public.txt"), "fixture dependency");
  const selectedIdentities = await Promise.all(
    [root, publicDependency].map(async (path) => {
      const st = await stat(path);
      return [st.dev, st.ino];
    }),
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "isolated-native-fixture",
      private: true,
      scripts: { test: "node check.cjs" },
    }),
  );
  await writeFile(
    join(root, "check.cjs"),
    `const fs=require('node:fs');const assert=require('node:assert/strict');assert.throws(()=>fs.readFileSync(${JSON.stringify(outside)}));assert.throws(()=>fs.readFileSync('/workspace/.env'));for(const name of ['private-state.db','private-state.db-wal','private-state.db-shm'])assert.throws(()=>fs.readFileSync('/workspace/'+name));const selected=${JSON.stringify(selectedIdentities)};for(const name of fs.readdirSync('/proc/self/fd')){const fd=Number(name);if(fd<3)continue;try{const st=fs.fstatSync(fd);if(st.isDirectory()){assert.ok(!selected.some(([dev,ino])=>st.dev===dev&&st.ino===ino),'source descriptor leaked');let wrote=false;try{fs.writeFileSync('/proc/self/fd/'+fd+'/fd-escape-marker','fixture');wrote=true}catch{}assert.ok(!wrote,'directory descriptor write escaped');}}catch(error){if(error.code!=='EBADF')throw error;}}fs.writeFileSync('/workspace/snapshot-only.txt','fixture');const net=require('node:net');const socket=net.connect({host:'127.0.0.1',port:${port}});socket.on('connect',()=>process.exit(21));socket.on('error',()=>{console.log('NATIVE_NAMESPACE_BOUNDARIES_OK');process.exit(0)});setTimeout(()=>process.exit(22),3000);`,
  );
  const result = await runSandboxedProjectCommand(
    { cwd: root, command: "project-test" },
    { npmCliPath: process.env.ZET_NPM_CLI, privatePaths },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /NATIVE_NAMESPACE_BOUNDARIES_OK/);
  await assert.rejects(access(join(root, "snapshot-only.txt")));
  assert.equal(await readFile(outside, "utf8"), "SYNTHETIC-OUTSIDE-FIXTURE");
  console.log(
    "LINUX_PROJECT_BOUNDARIES_OK diagnostic=live network=denied outside-read=denied private-state=excluded inherited-source-FDs=closed snapshot=isolated",
  );
  const repo = join(temporary, "repo");
  await mkdir(repo);
  const git = (args) =>
    execFileSync("/usr/bin/git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: temporary,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }).trim();
  git(["init", "--initial-branch=fixture"]);
  await writeFile(join(repo, "source.txt"), "fixture source\n");
  git(["add", "source.txt"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.org",
    "commit",
    "-m",
    "fixture",
  ]);
  const commit = git(["rev-parse", "HEAD"]);
  const state = join(temporary, "private-state");
  await mkdir(state, { mode: 0o700 });
  const tools = createRuntimeWorktreeTools({
    root: repo,
    journalPath: join(state, "worktrees.json"),
    sandbox: runSandboxedManagedWorktree,
    approve: async () => true,
  });
  const context = {
    runId: "fixture-run",
    opIndex: 0,
    iteration: 0,
    attempt: 1,
    logicalEffectId: "fixture-effect",
    signal: new AbortController().signal,
    env: {},
  };
  const tool = (name) => tools.find((tool) => tool.manifest.id === `harness.git.worktree.${name}`);
  await tool("create").invoke({ name: "task", commit }, context);
  assert.equal(
    await readFile(join(repo, ".zet-worktrees/task/source.txt"), "utf8"),
    "fixture source\n",
  );
  await tool("list").invoke({}, context);
  await tool("remove").invoke({ name: "task" }, context);
  await assert.rejects(access(join(repo, ".zet-worktrees/task")));
  console.log(
    "LINUX_NATIVE_ACCEPTANCE_OK diagnostic=live project-test=live outside-read=denied network=denied snapshot=isolated worktree-create-list-remove=live private-state=excluded inherited-source-FDs=closed",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
