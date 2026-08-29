// Real end-to-end run of the primary Harness Desktop workflow against the ACTUAL
// DSH engine: receive -> validate -> build -> activate -> restart -> verify -> rollback.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');


const APP = require('node:path').resolve(__dirname, '..', '..');
const { HarnessRuntime } = require(path.join(APP, 'lib', 'runtime'));
const { PluginManager } = require(path.join(APP, 'lib', 'plugin-manager'));
const AdmZip = require('adm-zip');

const DSH_HOME = process.env.DSH_HOME;
const PROFILE = path.join(DSH_HOME, 'profiles', 'web');
const BACKUP = path.join(os.tmpdir(), 'web-profile-backup-' + Date.now());

const steps = [];
function step(name, ok, detail) {
  steps.push({ name: name, ok: ok, detail: detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '\n        ' + detail : ''));
}

const logLines = [];
let PHASE = 'init';
function phase(p){ PHASE = p; logLines.push('===== PHASE ' + p + ' ====='); console.log('  ~~ phase: ' + p); }
function logger(source, message) {
  logLines.push('(' + PHASE + ') [' + source + '] ' + message);
  if (/error|failed|not ready|stopped/i.test(String(message))) {
    console.log('    . [' + source + '] ' + String(message).slice(0, 170));
  }
}

function bundlesOf(profileDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    return (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  } catch (e) { return []; }
}

function makeZip(root, opts) {
  const name = opts.name;
  const version = opts.version;
  const zip = new AdmZip();
  let manifest;
  if (opts.badManifest) {
    manifest = '{ this is not json';
  } else {
    const obj = {
      name: name, version: version, private: true, type: 'module', main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      harnessDesktop: { permissions: ['workspace'] },
    };
    if (opts.build !== false) obj.scripts = { build: 'node build.js' };
    manifest = JSON.stringify(obj);
  }
  zip.addFile('plugin/package.json', Buffer.from(manifest));
  if (!opts.noPatch) {
    zip.addFile('plugin/cordis.patch.yml', Buffer.from('- insert:\n    - id: ' + name + '\n      name: ' + name + '\n'));
  }
  zip.addFile('plugin/index.js', Buffer.from('export const name = "x";\nexport function apply() {}\n'));
  if (opts.build !== false) {
    zip.addFile('plugin/build.js', Buffer.from(opts.breakBuild ? 'process.exit(3)\n' : 'process.exit(0)\n'));
  }
  const file = path.join(root, name + '-' + version + '-' + crypto.randomUUID().slice(0, 6) + '.zip');
  zip.writeZip(file);
  return file;
}

async function main() {
  fs.cpSync(PROFILE, BACKUP, { recursive: true });
  console.log('backed up live profile -> ' + BACKUP + '\n');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-e2e-'));
  const userData = path.join(scratch, 'user-data');
  fs.mkdirSync(userData, { recursive: true });

  const runtime = new HarnessRuntime({ appRoot: APP, logger: logger });
  let manager = new PluginManager({ userData: userData, runtime: runtime, logger: logger, getWorkspace: () => APP });

  try {
    // ---- 1. baseline engine boot ----
    phase('1-baseline-boot');
    const boot = await runtime.start(APP);
    step('1. engine boots and reaches ready handshake', boot.ok, 'start -> ' + JSON.stringify(boot));
    const host = await runtime.request('host.describe', {});
    step('1b. host.describe answers over process IPC', Boolean(host.version), JSON.stringify(host).slice(0, 120));

    // ---- 2. invalid inputs rejected safely ----
    const corrupt = path.join(scratch, 'corrupt.zip');
    fs.writeFileSync(corrupt, 'this is definitely not a zip archive');
    let rejected = false, msg = '';
    try { await manager.receiveZip(corrupt); } catch (e) { rejected = true; msg = e.message; }
    step('2a. corrupt ZIP rejected with an understandable error', rejected, msg.slice(0, 140));

    const badManifestZip = makeZip(scratch, { name: 'dsh-e2e-bad', version: '1.0.0', badManifest: true });
    let r2 = null, threw2 = null;
    try { r2 = await manager.receiveZip(badManifestZip); } catch (e) { threw2 = e.message; }
    step('2b. malformed package.json rejected as an invalid candidate',
      threw2 !== null || (r2 && r2.status === 'invalid'),
      threw2 ? threw2.slice(0, 140) : 'status=' + r2.status + ' errors=' + JSON.stringify(r2.validation.errors));

    const noPatchZip = makeZip(scratch, { name: 'dsh-e2e-nopatch', version: '1.0.0', noPatch: true });
    const r3 = await manager.receiveZip(noPatchZip);
    step('2c. missing declared bundle patch rejected', r3.status === 'invalid', JSON.stringify(r3.validation.errors));

    const liveAfterBad = bundlesOf(PROFILE);
    step('2d. live profile untouched by every rejected archive',
      !liveAfterBad.some((b) => String(b).indexOf('dsh-e2e') !== -1), 'bundles=' + JSON.stringify(liveAfterBad));

    // ---- 3. build failure must never reach the live profile ----
    const buildFailZip = makeZip(scratch, { name: 'dsh-e2e-buildfail', version: '1.0.0', breakBuild: true });
    let buildThrew = null;
    try { await manager.receiveZip(buildFailZip); } catch (e) { buildThrew = e.message; }
    step('3. failing build reported and never reaches the live profile',
      buildThrew !== null && !bundlesOf(PROFILE).some((b) => String(b).indexOf('buildfail') !== -1),
      String(buildThrew || '').split('\n')[0].slice(0, 140));
    step('3b. failed version directory removed from managed storage',
      !fs.existsSync(path.join(manager.versionsDir, 'dsh-e2e-buildfail')),
      'versions=' + (fs.readdirSync(manager.versionsDir).join(',') || '(none)'));

    // ---- 4. valid plugin: receive -> deps -> build -> stage ----
    const NAME = 'dsh-e2e-plugin';
    const goodZip = makeZip(scratch, { name: NAME, version: '1.0.0' });
    phase('4-receive-good');
    const candidate = await manager.receiveZip(goodZip);
    step('4. valid plugin staged, dependencies installed, build run',
      candidate.status === 'ready', 'id=' + candidate.id + ' ' + candidate.name + '@' + candidate.version);

    const bundlesBefore = bundlesOf(PROFILE);
    step('4b. live profile still untouched before activation',
      bundlesBefore.indexOf(NAME) === -1, 'bundles=' + JSON.stringify(bundlesBefore));

    // ---- 5. activate against the real engine ----
    phase('5-activate');
    const activated = await manager.activate(candidate.id);
    step('5. activation succeeded (dsh add + dump-config + health check)',
      activated.ok === true, JSON.stringify(activated.plugin));
    const bundlesAfter = bundlesOf(PROFILE);
    step('5b. plugin present in the real composed profile bundles',
      bundlesAfter.indexOf(NAME) !== -1, 'bundles=' + JSON.stringify(bundlesAfter));
    step('5c. engine healthy after activation', await runtime.isHealthy(), '');

    // ---- 6. simulate the app restart the UI performs ----
    phase('6-restart');
    await runtime.stop();
    const managerAfterRestart = new PluginManager({ userData: userData, runtime: runtime, logger: logger, getWorkspace: () => APP });
    const pending = managerAfterRestart.getPendingChange();
    step('6. pending change survives the restart boundary',
      Boolean(pending) && pending.phase === 'awaiting-restart' && pending.plugin === NAME,
      JSON.stringify(pending && pending.phase));
    const linkPath = path.join(PROFILE, 'node_modules', 'dsh-e2e-plugin');
    let linkState = 'MISSING';
    try { const st = fs.lstatSync(linkPath); linkState = st.isSymbolicLink() ? ('symlink -> ' + fs.readlinkSync(linkPath) + ' (target exists: ' + fs.existsSync(fs.readlinkSync(linkPath)) + ')') : 'dir'; } catch (e) {}
    step('6a2. plugin still linked in the profile before restart', linkState !== 'MISSING', linkState);
    const restarted = await runtime.start(APP);
    step('6b. engine restarts healthy with the plugin installed', restarted.ok, '');
    const verification = await managerAfterRestart.verifyPendingChange();
    step('6c. post-restart config verification passes for a good plugin', verification.ok, JSON.stringify(verification));
    managerAfterRestart.confirmPendingRestart();
    step('6d. change committed, no pending change left', managerAfterRestart.getPendingChange() === null, '');
    manager = managerAfterRestart;

    // ---- 7. manual rollback restores the exact previous version ----
    phase('7-rollback');
    const rolled = await manager.rollbackPrevious();
    step('7. manual rollback reported success', rolled.ok === true, 'restored=' + (rolled.restored && rolled.restored.plugin));
    const bundlesRolled = bundlesOf(PROFILE);
    step('7b. plugin removed from the live profile by rollback',
      bundlesRolled.indexOf(NAME) === -1, 'bundles=' + JSON.stringify(bundlesRolled));
    step('7c. engine healthy after rollback', await runtime.isHealthy(), '');
    step('7d. tracked install state cleared after rollback',
      Object.keys(manager.state.installed).length === 0, JSON.stringify(Object.keys(manager.state.installed)));
  } catch (error) {
    console.log('\nE2E ABORTED: ' + error.message);
    console.log(String(error.stack || '').split('\n').slice(0, 6).join('\n'));
    steps.push({ name: 'E2E aborted', ok: false, detail: error.message });
  } finally {
    await runtime.stop();
    fs.rmSync(PROFILE, { recursive: true, force: true });
    fs.cpSync(BACKUP, PROFILE, { recursive: true });
    fs.rmSync(BACKUP, { recursive: true, force: true });
    console.log('\nlive profile restored from backup.');
    const logPath = path.join(scratch, 'engine.log');
    fs.writeFileSync(logPath, logLines.join('\n'));
    console.log('engine log: ' + logPath);
    const failed = steps.filter((s) => !s.ok);
    console.log('\n===== E2E SUMMARY =====');
    console.log((steps.length - failed.length) + '/' + steps.length + ' passed');
    for (const f of failed) console.log('  FAILED: ' + f.name + ' :: ' + f.detail);
    process.exit(failed.length ? 1 : 0);
  }
}

main();
