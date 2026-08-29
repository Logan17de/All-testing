// Real-engine failure and recovery scenarios: a plugin that boots-breaks the
// engine, disable, interrupted-change recovery, and repeated cycles.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP = require('node:path').resolve(__dirname, '..', '..');
const { HarnessRuntime } = require(path.join(APP, 'lib', 'runtime'));
const { PluginManager } = require(path.join(APP, 'lib', 'plugin-manager'));
const { testApiConnection } = require(path.join(APP, 'lib', 'api-check'));
const AdmZip = require('adm-zip');

const DSH_HOME = process.env.DSH_HOME;
const PROFILE = path.join(DSH_HOME, 'profiles', 'web');
const BACKUP = path.join(os.tmpdir(), 'recovery-backup-' + Date.now());

const steps = [];
function step(name, ok, detail) {
  steps.push({ name: name, ok: ok, detail: detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '\n        ' + detail : ''));
}
const logLines = [];
function logger(source, message) { logLines.push('[' + source + '] ' + message); }

function bundlesOf() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'));
    return (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  } catch (e) { return []; }
}

function makeZip(root, opts) {
  const zip = new AdmZip();
  zip.addFile('plugin/package.json', Buffer.from(JSON.stringify({
    name: opts.name, version: opts.version, private: true, type: 'module', main: 'index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })));
  zip.addFile('plugin/cordis.patch.yml',
    Buffer.from('- insert:\n    - id: ' + opts.name + '\n      name: ' + opts.name + '\n'));
  // A "broken" plugin passes every static check but explodes when the engine imports it.
  zip.addFile('plugin/index.js', Buffer.from(opts.broken
    ? 'throw new Error("this plugin explodes on import");\n'
    : 'export function apply() {}\n'));
  const file = path.join(root, opts.name + '-' + opts.version + '-' + crypto.randomUUID().slice(0, 6) + '.zip');
  zip.writeZip(file);
  return file;
}

async function main() {
  fs.cpSync(PROFILE, BACKUP, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-rec-'));
  const userData = path.join(scratch, 'user-data');
  fs.mkdirSync(userData, { recursive: true });

  const runtime = new HarnessRuntime({ appRoot: APP, logger: logger });
  let manager = new PluginManager({ userData: userData, runtime: runtime, logger: logger, getWorkspace: () => APP });

  try {
    // ---- A. provider connection checks ----
    const bad = await testApiConnection({ baseUrl: 'not-a-url', apiKey: 'x' });
    step('A1. invalid provider URL rejected before any network call', bad.ok === false, bad.error);
    const creds = await testApiConnection({ baseUrl: 'https://user:pw@api.deepseek.com/v1', apiKey: 'x' });
    step('A2. embedded credentials in the base URL rejected', creds.ok === false, creds.error);
    const dead = await testApiConnection({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x' }, { timeoutMs: 3000 });
    step('A3. unreachable provider reported as a failure, not a hang', dead.ok === false, String(dead.error).slice(0, 90));
    const real = await testApiConnection({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-invalid-key' }, { timeoutMs: 8000 });
    step('A4. real endpoint with an invalid key reports a clear failure',
      real.ok === false, 'status=' + real.status + ' error=' + String(real.error).slice(0, 70));

    await runtime.start(APP);
    step('A5. engine healthy at baseline', await runtime.isHealthy(), '');

    // ---- B. a plugin that breaks the engine at boot ----
    const brokenZip = makeZip(scratch, { name: 'dsh-rec-broken', version: '1.0.0', broken: true });
    const brokenCandidate = await manager.receiveZip(brokenZip);
    step('B1. broken plugin still passes static validation and stages',
      brokenCandidate.status === 'ready', 'status=' + brokenCandidate.status);

    let activateError = null;
    try { await manager.activate(brokenCandidate.id); } catch (e) { activateError = e.message; }
    step('B2. activating an engine-breaking plugin fails instead of succeeding',
      activateError !== null, String(activateError).split('\n')[0]);
    step('B3. the previous working profile was restored automatically',
      bundlesOf().indexOf('dsh-rec-broken') === -1, 'bundles=' + JSON.stringify(bundlesOf()));
    step('B4. engine is healthy again after the automatic rollback', await runtime.isHealthy(), '');
    step('B5. no pending change left behind after the failed activation',
      manager.getPendingChange() === null, JSON.stringify(manager.getPendingChange()));

    // ---- C. good plugin, then disable ----
    const goodZip = makeZip(scratch, { name: 'dsh-rec-good', version: '1.0.0' });
    const good = await manager.receiveZip(goodZip);
    const act = await manager.activate(good.id);
    step('C1. a good plugin activates after the broken one was rejected', act.ok === true, '');
    manager.confirmPendingRestart();

    const disabled = await manager.disable('dsh-rec-good');
    step('C2. plugin disable succeeds', disabled.ok === true, '');
    step('C3. disabled plugin removed from the live profile',
      bundlesOf().indexOf('dsh-rec-good') === -1, 'bundles=' + JSON.stringify(bundlesOf()));
    step('C4. engine healthy after disable', await runtime.isHealthy(), '');
    manager.confirmPendingRestart();

    // ---- D. interrupted change is recovered by a fresh manager ----
    const interruptZip = makeZip(scratch, { name: 'dsh-rec-interrupt', version: '1.0.0' });
    const interrupt = await manager.receiveZip(interruptZip);
    await manager.activate(interrupt.id);
    // Simulate a process kill mid-change: the state file still says 'changing'.
    const raw = JSON.parse(fs.readFileSync(path.join(userData, 'plugin-state.json'), 'utf8'));
    raw.pendingChange.phase = 'changing';
    fs.writeFileSync(path.join(userData, 'plugin-state.json'), JSON.stringify(raw, null, 2));

    const recovered = new PluginManager({ userData: userData, runtime: runtime, logger: logger, getWorkspace: () => APP });
    step('D1. an interrupted change is detected on the next launch',
      recovered.getPendingChange() !== null && recovered.getPendingChange().phase === 'changing', '');
    await recovered.recoverPendingChange();
    step('D2. interrupted change rolled back to the previous working profile',
      bundlesOf().indexOf('dsh-rec-interrupt') === -1, 'bundles=' + JSON.stringify(bundlesOf()));
    step('D3. engine healthy after interrupted-change recovery', await runtime.isHealthy(), '');
    manager = recovered;

    // ---- E. repeated cycles must not corrupt state ----
    let cycleOk = true;
    let cycleDetail = '';
    for (let i = 1; i <= 3; i += 1) {
      const zip = makeZip(scratch, { name: 'dsh-rec-cycle', version: '1.0.' + i });
      const cand = await manager.receiveZip(zip);
      const activated = await manager.activate(cand.id);
      if (!activated.ok || bundlesOf().indexOf('dsh-rec-cycle') === -1) {
        cycleOk = false; cycleDetail = 'cycle ' + i + ' activation failed'; break;
      }
      manager.confirmPendingRestart();
      await manager.rollbackPrevious();
      if (bundlesOf().indexOf('dsh-rec-cycle') !== -1) {
        cycleOk = false; cycleDetail = 'cycle ' + i + ' rollback left the plugin installed'; break;
      }
      if (!await runtime.isHealthy()) { cycleOk = false; cycleDetail = 'cycle ' + i + ' left the engine unhealthy'; break; }
    }
    step('E1. three activate/rollback cycles leave no corruption', cycleOk, cycleDetail);
    step('E2. final profile matches the original baseline',
      JSON.stringify(bundlesOf()) === JSON.stringify(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']),
      'bundles=' + JSON.stringify(bundlesOf()));
    step('E3. engine healthy at the end of all cycles', await runtime.isHealthy(), '');
    step('E4. no plugins tracked as installed at the end',
      Object.keys(manager.state.installed).length === 0, JSON.stringify(Object.keys(manager.state.installed)));
  } catch (error) {
    console.log('\nABORTED: ' + error.message);
    console.log(String(error.stack || '').split('\n').slice(0, 5).join('\n'));
    steps.push({ name: 'run aborted', ok: false, detail: error.message });
  } finally {
    await runtime.stop();
    fs.rmSync(PROFILE, { recursive: true, force: true });
    fs.cpSync(BACKUP, PROFILE, { recursive: true });
    fs.rmSync(BACKUP, { recursive: true, force: true });
    const logPath = path.join(scratch, 'engine.log');
    fs.writeFileSync(logPath, logLines.join('\n'));
    console.log('\nprofile restored. log: ' + logPath);
    const failed = steps.filter((s) => !s.ok);
    console.log('\n===== RECOVERY SUMMARY =====');
    console.log((steps.length - failed.length) + '/' + steps.length + ' passed');
    for (const f of failed) console.log('  FAILED: ' + f.name + ' :: ' + f.detail);
    process.exit(failed.length ? 1 : 0);
  }
}

main();
