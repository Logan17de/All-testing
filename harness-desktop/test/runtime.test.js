const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { HarnessRuntime } = require('../lib/runtime');

function runtimeFixture() {
  const logs = [];
  const runtime = new HarnessRuntime({
    appRoot: path.resolve(__dirname, '..'),
    logger: (source, message) => logs.push({ source, message }),
  });
  return { runtime, logs };
}

test('spawned build commands time out and are terminated', async () => {
  const { runtime, logs } = runtimeFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-timeout-'));
  const script = path.join(root, 'hang.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  const result = await runtime.runNodeScript(script, [], { cwd: root, timeoutMs: 150 });
  assert.equal(result.code, -1);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /timed out/);
  assert.equal(logs.some((entry) => /timed out/.test(entry.message)), true);
});

test('health from an unrelated server is not accepted after the owned child exits', async () => {
  const { runtime } = runtimeFixture();
  runtime.isHealthy = async () => true;
  runtime.child = { exitCode: 1 };
  assert.equal(await runtime.waitHealthy(350), false);
});

test('all DSH commands include the Node internals flag required by the bundled DSH profile', async () => {
  const { runtime } = runtimeFixture();
  let observed;
  runtime.runNodeScript = async (script, args, options) => {
    observed = { script, args, nodeArgs: options.nodeArgs };
    return { code: 0, stdout: '', stderr: '' };
  };
  await runtime.runDsh(['--version']);
  assert.equal(observed.script, runtime.dshCli);
  assert.deepEqual(observed.nodeArgs, ['--expose-internals']);
});

test('the desktop runtime owns a minimal isolated profile instead of loading the user web profile', () => {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-desktop-home-'));
  const runtime = new HarnessRuntime({
    appRoot: path.resolve(__dirname, '..'),
    logger: () => {},
    dshHome,
    profileName: 'desktop',
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(dshHome, 'profiles', 'desktop', 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  assert.equal(runtime.profileName, 'desktop');
  assert.equal(runtime.nodeEnv().DSH_HOME, dshHome);
});

test('desktop IPC correlates responses and forwards engine events without HTTP', async () => {
  const { runtime } = runtimeFixture();
  runtime.ready = true;
  runtime.child = {
    exitCode: null,
    stdin: {
      write(line, callback) {
        const request = JSON.parse(line);
        setImmediate(() => runtime.handleIpcMessage({
          type: 'response',
          id: request.id,
          result: { ok: true, value: { method: request.method, payload: request.payload } },
        }));
        callback();
      },
    },
  };
  const event = new Promise((resolve) => runtime.once('event', resolve));
  runtime.consumeStdout(`\u001eHARNESS_DESKTOP_IPC ${JSON.stringify({ type: 'event', stream: 'host', payload: { type: 'host/session-status', running: true } })}\n`);
  assert.deepEqual(await runtime.request('session.list', {}), { method: 'session.list', payload: {} });
  assert.equal((await event).payload.running, true);
  assert.equal(runtime.status().transport, 'process-ipc');
  assert.equal('url' in runtime.status(), false);
});

test('native engine overlay disables the browser surface and mounts the IPC bridge', () => {
  const overlay = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'native-engine.patch.yml'), 'utf8');
  for (const id of ['webserver', 'web-runtime', 'connection', 'cordis-client-runner', 'ui-conversation']) {
    assert.match(overlay, new RegExp(`id: ${id}\\r?\\n  disabled: true`));
  }
  assert.match(overlay, /harness-desktop-engine-bridge/);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('start() does not report success while the engine has not completed its ready handshake', async () => {
  const { runtime } = runtimeFixture();
  // A boot is already in flight: the child is alive but has never sent 'ready'.
  runtime.child = { exitCode: null, pid: -1, kill() {} };
  runtime.ready = false;

  let result = null;
  const started = runtime.start(os.tmpdir()).then((value) => { result = value; });
  await sleep(700);
  assert.equal(result, null, 'start() reported a result before the ready handshake');

  runtime.child = null; // the in-flight engine gave up
  await started;
  assert.equal(result.ok, false, 'start() reported success for an engine that never became ready');
});

test('start() clears an exited child instead of reporting it as already running', async () => {
  const { runtime } = runtimeFixture();
  runtime.child = { exitCode: 1, pid: -1, kill() {} };
  runtime.ready = false;

  let respawned = false;
  runtime.waitHealthy = async () => { respawned = true; return false; };

  const result = await runtime.start(os.tmpdir());
  assert.equal(result.alreadyRunning, undefined, 'an exited child was treated as already running');
  assert.equal(result.ok, false);
  assert.equal(respawned, true, 'a fresh engine spawn was never attempted');
  await runtime.stop();
});

test('a timed-out command reports a timeout no matter which close event wins', async () => {
  const { runtime } = runtimeFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-timeout-race-'));
  const script = path.join(root, 'hang.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await runtime.runNodeScript(script, [], { cwd: root, timeoutMs: 120 });
    assert.equal(result.timedOut, true);
    assert.equal(result.code, -1);
  }
});

test('a superseded engine child cannot clear or mark ready the current one', async () => {
  // runtime.js destructures `spawn` at load, so patch the module and reload it.
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const { EventEmitter } = require('node:events');

  const spawned = [];
  childProcess.spawn = (command, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write(_line, callback) { if (callback) callback(); } };
    proc.exitCode = null;
    proc.pid = 1000 + spawned.length;
    proc.kill = () => {};
    // stop() shells out to taskkill and waits for its close event.
    if (String(command).includes('taskkill')) setImmediate(() => proc.emit('close', 0));
    else spawned.push(proc);
    return proc;
  };

  delete require.cache[require.resolve('../lib/runtime')];
  const { HarnessRuntime: PatchedRuntime } = require('../lib/runtime');

  try {
    const runtime = new PatchedRuntime({ appRoot: path.resolve(__dirname, '..'), logger: () => {} });
    runtime.waitHealthy = async () => true; // isolate the handler race from real health
    runtime.settle = async () => true;      // and from the post-ready settle window

    await runtime.start(os.tmpdir());
    const first = spawned[0];
    assert.equal(runtime.child, first);

    await runtime.stop();
    await runtime.start(os.tmpdir());
    const second = spawned[1];
    assert.equal(runtime.child, second, 'the second start did not take ownership');

    // The first engine's exit finally lands, after the second is already running.
    runtime.ready = true;
    first.emit('exit', 1, null);
    assert.equal(runtime.child, second, 'a dead engine abandoned the running engine');
    assert.equal(runtime.ready, true, 'a dead engine cleared the running engine ready state');

    // A late frame from the dead engine must not mark the new engine ready.
    runtime.ready = false;
    first.stdout.emit('data', Buffer.from('\u001eHARNESS_DESKTOP_IPC {"type":"ready"}\n'));
    assert.equal(runtime.ready, false, 'a superseded engine marked the current engine ready');

    // The live engine still controls its own state.
    second.emit('exit', 0, null);
    assert.equal(runtime.child, null);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[require.resolve('../lib/runtime')];
  }
});

test('a boot that dies just after the ready handshake is not reported as healthy', async () => {
  const { runtime } = runtimeFixture();
  // The engine answered ready, then its own activation assert killed it.
  runtime.child = { exitCode: null, pid: -1, kill() {} };
  runtime.ready = true;
  setTimeout(() => { runtime.child = null; runtime.ready = false; }, 300);
  assert.equal(await runtime.settle(1500), false, 'settle accepted an engine that exited');
});

test('settle confirms health for an engine that stays up', async () => {
  const { runtime } = runtimeFixture();
  runtime.child = { exitCode: null, pid: -1, kill() {} };
  runtime.ready = true;
  runtime.isHealthy = async () => true;
  assert.equal(await runtime.settle(600), true);
});

test('a failed boot explains which plugins never activated and why', () => {
  const { runtime } = runtimeFixture();
  runtime.bootLog = [
    'Error: dsh: plugin tree failed to load: dsh: 3 entries did not activate',
    '  dsh-session-manager: pending (waiting for service: webServer)',
    '  @nonamelego/dsh-catppuccin: pending (waiting for service: webServer)',
    '  dsh-thing: pending (waiting for service: someOther)',
  ].join('\n');

  const reason = runtime.bootFailureReason();
  assert.match(reason, /dsh-session-manager/);
  assert.match(reason, /@nonamelego\/dsh-catppuccin/);
  assert.match(reason, /webServer/);
  assert.match(reason, /no web surface/, 'the webServer case should say why the desktop client cannot run them');
  assert.match(reason, /someOther/, 'other missing services should still be reported');
});

test('a clean boot log produces no failure reason', () => {
  const { runtime } = runtimeFixture();
  runtime.bootLog = 'Knowledge Graph MCP Server running on stdio\n';
  assert.equal(runtime.bootFailureReason(), null);
});
