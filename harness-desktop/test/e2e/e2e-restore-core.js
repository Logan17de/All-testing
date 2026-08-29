// Restore-to-core against the real engine: install a plugin, reset, roll back.
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
const BACKUP = path.join(os.tmpdir(), 'restore-core-backup-' + Date.now());

const steps = [];
function step(name, ok, detail) {
  steps.push({ name, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '\n        ' + detail : ''));
}
const logger = () => {};
const bundles = () => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'));
    return (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  } catch { return []; }
};

async function main() {
  fs.cpSync(PROFILE, BACKUP, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-core-'));
  const userData = path.join(scratch, 'ud');
  fs.mkdirSync(userData, { recursive: true });

  const workspace = path.join(scratch, 'ws');
  const skillDir = path.join(workspace, '.dsh', 'skills');
  fs.mkdirSync(path.join(skillDir, 'demo-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\n---\nBody\n');

  const runtime = new HarnessRuntime({ appRoot: APP, logger });
  const manager = new PluginManager({ userData, runtime, logger, getWorkspace: () => APP });

  try {
    await runtime.start(APP);
    step('1. engine online', await runtime.isHealthy(), '');

    const zip = new AdmZip();
    for (const file of starterFiles()) zip.addFile(file.path, Buffer.from(file.content, 'utf8'));
    const archive = path.join(scratch, 'starter.zip');
    zip.writeZip(archive);
    const candidate = await manager.receiveZip(archive);
    await manager.activate(candidate.id);
    manager.confirmPendingRestart();
    step('2. a third-party plugin is installed and mounted',
      bundles().includes('dsh-starter-plugin'), 'bundles=' + JSON.stringify(bundles()));

    const result = await manager.restoreCore({ skillDirs: [skillDir] });
    step('3. restore removed the third-party plugin',
      result.removed.includes('dsh-starter-plugin'), 'removed=' + JSON.stringify(result.removed));
    step('4. only shipped bundles remain',
      bundles().every((b) => b.startsWith('@deepseek-ai/')), 'bundles=' + JSON.stringify(bundles()));
    step('5. engine still healthy after the restore', await runtime.isHealthy(), '');
    step('6. skills moved aside, not deleted',
      !fs.existsSync(skillDir) && fs.existsSync(path.join(result.movedSkills[0], 'demo-skill', 'SKILL.md')),
      'parked at ' + (result.movedSkills[0] || 'none'));
    step('7. nothing is tracked as installed', Object.keys(manager.state.installed).length === 0, '');

    manager.confirmPendingRestart();
    await manager.rollbackPrevious();
    step('8. rollback puts the plugin back',
      bundles().includes('dsh-starter-plugin'), 'bundles=' + JSON.stringify(bundles()));
    step('9. engine healthy after rollback', await runtime.isHealthy(), '');
  } catch (error) {
    console.log('\nABORTED: ' + error.message);
    steps.push({ name: 'run aborted', ok: false });
  } finally {
    await runtime.stop();
    fs.rmSync(PROFILE, { recursive: true, force: true });
    fs.cpSync(BACKUP, PROFILE, { recursive: true });
    fs.rmSync(BACKUP, { recursive: true, force: true });
    console.log('\nprofile restored.');
    const failed = steps.filter((s) => !s.ok);
    console.log('\n===== RESTORE CORE SUMMARY =====');
    console.log(`${steps.length - failed.length}/${steps.length} passed`);
    process.exit(failed.length ? 1 : 0);
  }
}

main();
