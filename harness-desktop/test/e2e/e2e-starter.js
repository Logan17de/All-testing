// Does the starter plugin the app hands out actually install through the real
// DSH engine? If not, the format guide is worthless.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP = require('node:path').resolve(__dirname, '..', '..');
const { HarnessRuntime } = require(path.join(APP, 'lib', 'runtime'));
const { PluginManager } = require(path.join(APP, 'lib', 'plugin-manager'));
const { starterFiles } = require(path.join(APP, 'lib', 'plugin-template'));
const AdmZip = require('adm-zip');

const DSH_HOME = process.env.DSH_HOME;
const PROFILE = path.join(DSH_HOME, 'profiles', 'web');
const BACKUP = path.join(os.tmpdir(), 'starter-backup-' + Date.now());

const steps = [];
function step(name, ok, detail) {
  steps.push({ name, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '\n        ' + detail : ''));
}
const logLines = [];
const logger = (s, m) => logLines.push(`[${s}] ${m}`);

function bundles() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'));
    return (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  } catch { return []; }
}

async function main() {
  fs.cpSync(PROFILE, BACKUP, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-starter-e2e-'));
  const userData = path.join(scratch, 'ud');
  fs.mkdirSync(userData, { recursive: true });

  const runtime = new HarnessRuntime({ appRoot: APP, logger });
  const manager = new PluginManager({ userData, runtime, logger, getWorkspace: () => APP });

  try {
    // Build exactly what the app's "Save a starter plugin" button writes.
    const zip = new AdmZip();
    for (const file of starterFiles()) zip.addFile(file.path, Buffer.from(file.content, 'utf8'));
    const archive = path.join(scratch, 'dsh-starter-plugin.zip');
    zip.writeZip(archive);
    step('1. starter archive written by the same code the app ships', fs.existsSync(archive),
      `${(fs.statSync(archive).size / 1024).toFixed(1)} KB`);

    const boot = await runtime.start(APP);
    step('2. engine online', boot.ok, '');

    const candidate = await manager.receiveZip(archive);
    step('3. receiver accepts it: validated, deps installed, built, staged',
      candidate.status === 'ready',
      `status=${candidate.status} ${candidate.name}@${candidate.version} permissions=${JSON.stringify(candidate.permissions)}`);

    step('4. live profile untouched before activation',
      bundles().indexOf('dsh-starter-plugin') === -1, `bundles=${JSON.stringify(bundles())}`);

    const activated = await manager.activate(candidate.id);
    step('5. activation succeeds against the real engine', activated.ok === true, '');
    step('6. it appears in the composed profile', bundles().indexOf('dsh-starter-plugin') !== -1,
      `bundles=${JSON.stringify(bundles())}`);
    step('7. engine healthy with the starter installed', await runtime.isHealthy(), '');

    // Restart boundary, exactly as the app does after activation.
    await runtime.stop();
    const after = new PluginManager({ userData, runtime, logger, getWorkspace: () => APP });
    const restarted = await runtime.start(APP);
    step('8. engine restarts cleanly with it installed', restarted.ok, '');
    const verification = await after.verifyPendingChange();
    step('9. post-restart verification passes', verification.ok, JSON.stringify(verification));
    after.confirmPendingRestart();

    const rolled = await after.rollbackPrevious();
    step('10. rollback removes it again', rolled.ok === true && bundles().indexOf('dsh-starter-plugin') === -1,
      `bundles=${JSON.stringify(bundles())}`);
    step('11. engine healthy after rollback', await runtime.isHealthy(), '');
  } catch (error) {
    console.log('\nABORTED: ' + error.message);
    console.log(String(error.stack || '').split('\n').slice(0, 4).join('\n'));
    steps.push({ name: 'run aborted', ok: false });
  } finally {
    await runtime.stop();
    fs.rmSync(PROFILE, { recursive: true, force: true });
    fs.cpSync(BACKUP, PROFILE, { recursive: true });
    fs.rmSync(BACKUP, { recursive: true, force: true });
    const logPath = path.join(scratch, 'engine.log');
    fs.writeFileSync(logPath, logLines.join('\n'));
    console.log('\nprofile restored. log: ' + logPath);
    const failed = steps.filter((s) => !s.ok);
    console.log('\n===== STARTER PLUGIN SUMMARY =====');
    console.log(`${steps.length - failed.length}/${steps.length} passed`);
    process.exit(failed.length ? 1 : 0);
  }
}

main();
