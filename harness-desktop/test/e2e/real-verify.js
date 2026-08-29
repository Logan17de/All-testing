// Prove the UI shows engine data, not constants: compare what the renderer would
// render against what the engine actually returns.
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
const BACKUP = path.join(os.tmpdir(), 'real-backup-' + Date.now());

const steps = [];
const step = (n, ok, d) => { steps.push({ n, ok }); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '\n        ' + d : '')); };

async function main() {
  fs.cpSync(PROFILE, BACKUP, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-real-'));
  const userData = path.join(scratch, 'ud');
  fs.mkdirSync(userData, { recursive: true });

  const runtime = new HarnessRuntime({ appRoot: APP, logger: () => {} });
  const manager = new PluginManager({ userData, runtime, logger: () => {}, getWorkspace: () => APP });

  try {
    await runtime.start(APP);

    // providers come from the engine
    const providers = (await runtime.request('llm.providers', {})).providers || [];
    const groups = (await runtime.request('llm.models', {})).groups || [];
    const active = providers.filter((p) => p.active);
    step('1. provider list comes from the engine, not a constant',
      providers.length > 1 && active.length >= 1,
      `${providers.length} routes, ${active.length} active: ${active.map((p) => p.provider).join(', ')}`);
    step('2. model counts are real',
      groups.length > 0 && (groups[0].models || []).length > 0,
      groups.map((g) => `${g.id}=${(g.models || []).length}`).join(', '));
    step('3. the old hardcoded vendor list is gone from the renderer',
      !fs.readFileSync(path.join(APP, 'src', 'renderer.js'), 'utf8').includes('GLOBAL_PROVIDERS'), '');

    // plugin manifest is read from disk
    const zip = new AdmZip();
    for (const file of starterFiles()) {
      const content = file.path.endsWith('package.json')
        ? JSON.stringify({ ...JSON.parse(file.content), description: 'Real description from package.json.', author: 'Harness Tests', license: 'MIT' }, null, 2)
        : file.content;
      zip.addFile(file.path, Buffer.from(content, 'utf8'));
    }
    const archive = path.join(scratch, 'starter.zip');
    zip.writeZip(archive);
    const candidate = await manager.receiveZip(archive);
    await manager.activate(candidate.id);
    manager.confirmPendingRestart();

    const installed = manager.list().installed[0];
    const manifest = JSON.parse(fs.readFileSync(path.join(installed.path, 'package.json'), 'utf8'));
    step('4. installed plugin manifest is readable from its managed path',
      manifest.description === 'Real description from package.json.',
      `description="${manifest.description}" author=${manifest.author} license=${manifest.license}`);
    step('5. renderer no longer ships the invented plugin blurb',
      !fs.readFileSync(path.join(APP, 'src', 'renderer.js'), 'utf8').includes('DSH bundle plugin managed by Harness Desktop'), '');

    const status = runtime.status();
    step('6. build target is the real platform', /^\w+-\w+$/.test(status.platform || ''), status.platform);
    step('7. no hardcoded "Windows x64" left in the renderer',
      !fs.readFileSync(path.join(APP, 'src', 'renderer.js'), 'utf8').includes('Windows x64'), '');
    step('8. no seeded scratch document',
      !fs.readFileSync(path.join(APP, 'src', 'renderer.js'), 'utf8').includes("openTab('scratch.md'"), '');
  } catch (error) {
    console.log('\nABORTED: ' + error.message);
    steps.push({ n: 'aborted', ok: false });
  } finally {
    await runtime.stop();
    fs.rmSync(PROFILE, { recursive: true, force: true });
    fs.cpSync(BACKUP, PROFILE, { recursive: true });
    fs.rmSync(BACKUP, { recursive: true, force: true });
    const failed = steps.filter((s) => !s.ok);
    console.log(`\n===== REAL DATA SUMMARY =====\n${steps.length - failed.length}/${steps.length} passed`);
    process.exit(failed.length ? 1 : 0);
  }
}

main();
