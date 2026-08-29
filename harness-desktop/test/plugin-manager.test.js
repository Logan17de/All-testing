const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const { PluginManager } = require('../lib/plugin-manager');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-manager-'));
}

function writeProfile(runtime, marker) {
  const profile = path.join(runtime.dshHome, 'profiles', 'web');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'marker.txt'), marker);
}

function readProfile(runtime) {
  return fs.readFileSync(path.join(runtime.dshHome, 'profiles', 'web', 'marker.txt'), 'utf8');
}

function pluginZip(root, options = {}) {
  const manifest = options.manifest || {
    name: options.name || 'dsh-test',
    version: options.version || '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    ...(options.build ? { scripts: { build: 'node build.js' } } : {}),
  };
  const zip = new AdmZip();
  if (!options.noManifest) zip.addFile('plugin/package.json', Buffer.from(JSON.stringify(manifest)));
  if (!options.noPatch) zip.addFile('plugin/cordis.patch.yml', Buffer.from('- id: test\n'));
  if (options.build) zip.addFile('plugin/build.js', Buffer.from('process.exit(0)\n'));
  const file = path.join(root, `${options.fileName || crypto.randomUUID()}.zip`);
  zip.writeZip(file);
  return file;
}

class MockRuntime {
  constructor(root) {
    this.dshHome = path.join(root, 'dsh-home');
    this.startResults = [];
    this.failAdd = false;
    this.failRemove = false;
    this.failInstall = false;
    this.failBuild = false;
    this.failPnpmInstall = false;
    this.badDump = false;
    this.calls = [];
    this.activeName = null;
  }

  async stop() { this.calls.push(['stop']); }

  async start(workspace) {
    this.calls.push(['start', workspace]);
    return this.startResults.length ? { ok: this.startResults.shift() } : { ok: true };
  }

  async runPnpm(args, options) {
    this.calls.push(['pnpm', ...args, options.cwd]);
    if (args[0] === 'install' && this.failPnpmInstall) {
      return { code: 1, stdout: '', stderr: 'incompatible dependency tree' };
    }
    if (args[0] === 'run' && this.failBuild) return { code: 1, stdout: '', stderr: 'synthetic build failure' };
    return { code: 0, stdout: 'ok', stderr: '' };
  }

  async runDsh(args, options) {
    this.calls.push(['dsh', ...args, options.cwd]);
    if (args[0] === 'plugin' && args[3] === 'add') {
      if (this.failAdd) return { code: 1, stdout: '', stderr: 'synthetic add failure' };
      const manifest = JSON.parse(fs.readFileSync(path.join(args[4], 'package.json'), 'utf8'));
      this.activeName = manifest.name;
      writeProfile(this, `active:${manifest.name}@${manifest.version}`);
      return { code: 0, stdout: 'added', stderr: '' };
    }
    if (args[0] === 'plugin' && args[3] === 'remove') {
      if (this.failRemove) return { code: 1, stdout: '', stderr: 'synthetic remove failure' };
      this.activeName = null;
      writeProfile(this, 'disabled');
      // DSH drops the bundle entry along with the dependency.
      const manifestFile = path.join(this.dshHome, 'profiles', 'web', 'package.json');
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((b) => b !== args[4]);
        delete manifest.dependencies[args[4]];
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
      } catch {}
      return { code: 0, stdout: 'removed', stderr: '' };
    }
    if (args[0] === 'plugin' && args[3] === 'install') {
      return this.failInstall
        ? { code: 1, stdout: '', stderr: 'synthetic restore failure' }
        : { code: 0, stdout: 'installed', stderr: '' };
    }
    if (args.includes('--dump-config')) {
      return { code: 0, stdout: this.badDump ? 'different-plugin' : this.activeName || '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }
}

function managerFixture() {
  const root = makeRoot();
  const runtime = new MockRuntime(root);
  const logs = [];
  const manager = new PluginManager({
    userData: path.join(root, 'user-data'),
    runtime,
    logger: (source, message) => logs.push({ source, message }),
    getWorkspace: () => root,
  });
  return { root, runtime, manager, logs };
}

test('corrupt archives fail safely and disposable staging is cleaned', async () => {
  const fixture = managerFixture();
  const corrupt = path.join(fixture.root, 'corrupt.zip');
  fs.writeFileSync(corrupt, 'not a zip');
  await assert.rejects(fixture.manager.receiveZip(corrupt));
  assert.deepEqual(fs.readdirSync(fixture.manager.stagingDir), []);
  assert.match(fixture.logs.at(-1).message, /Plugin receive failed/);
});

test('missing manifests and patches are rejected with understandable errors', async () => {
  const fixture = managerFixture();
  await assert.rejects(
    fixture.manager.receiveZip(pluginZip(fixture.root, { noManifest: true })),
    /No package\.json found/,
  );

  const missingPatch = await fixture.manager.receiveZip(pluginZip(fixture.root, { noPatch: true }));
  assert.equal(missingPatch.status, 'invalid');
  assert.match(missingPatch.validation.errors.join(' '), /does not exist/);
  assert.deepEqual(fs.readdirSync(fixture.manager.stagingDir), []);
});

test('build failure never calls DSH and removes the failed version', async () => {
  const fixture = managerFixture();
  fixture.runtime.failBuild = true;
  await assert.rejects(
    fixture.manager.receiveZip(pluginZip(fixture.root, { build: true })),
    /Plugin build failed.*synthetic build failure/s,
  );
  assert.equal(fixture.runtime.calls.some((call) => call[0] === 'dsh'), false);
  const packageFiles = [];
  if (fs.existsSync(fixture.manager.versionsDir)) {
    for (const entry of fs.readdirSync(fixture.manager.versionsDir, { recursive: true })) {
      if (String(entry).endsWith('package.json')) packageFiles.push(entry);
    }
  }
  assert.deepEqual(packageFiles, []);
});

test('incompatible dependency failures are rejected before activation', async () => {
  const fixture = managerFixture();
  fixture.runtime.failPnpmInstall = true;
  await assert.rejects(
    fixture.manager.receiveZip(pluginZip(fixture.root)),
    /dependency install failed.*incompatible dependency tree/s,
  );
  assert.equal(fixture.runtime.calls.some((call) => call[0] === 'dsh'), false);
  assert.deepEqual(fs.readdirSync(fixture.manager.stagingDir), []);
});

test('duplicate semantic versions are isolated in separate immutable candidates', async () => {
  const fixture = managerFixture();
  const first = await fixture.manager.receiveZip(pluginZip(fixture.root, { fileName: 'one' }));
  const second = await fixture.manager.receiveZip(pluginZip(fixture.root, { fileName: 'two' }));
  assert.equal(first.status, 'ready');
  assert.equal(second.status, 'ready');
  assert.notEqual(first.path, second.path);
  assert.equal(fs.existsSync(path.join(first.path, 'package.json')), true);
  assert.equal(fs.existsSync(path.join(second.path, 'package.json')), true);
});

test('tampered candidates are rejected before the live profile is touched', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'known-good');
  const candidate = await fixture.manager.receiveZip(pluginZip(fixture.root));
  fs.rmSync(path.join(candidate.path, 'cordis.patch.yml'));
  await assert.rejects(fixture.manager.activate(candidate.id), /no longer valid/);
  assert.equal(readProfile(fixture.runtime), 'known-good');
  assert.equal(fixture.runtime.calls.some((call) => call[0] === 'dsh'), false);
});

test('activation failures automatically restore the exact previous profile', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'known-good');
  const candidate = await fixture.manager.receiveZip(pluginZip(fixture.root));
  fixture.runtime.failAdd = true;
  await assert.rejects(fixture.manager.activate(candidate.id), /rolled back/);
  assert.equal(readProfile(fixture.runtime), 'known-good');
  assert.equal(fixture.manager.state.history.length, 0);
  assert.equal(fixture.manager.getPendingChange(), null);
});

test('a failed activation health check rolls back and restarts the old profile', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'known-good');
  const candidate = await fixture.manager.receiveZip(pluginZip(fixture.root));
  fixture.runtime.startResults.push(false, true);
  await assert.rejects(fixture.manager.activate(candidate.id), /post-install health check/);
  assert.equal(readProfile(fixture.runtime), 'known-good');
  assert.equal(fixture.manager.state.installed['dsh-test'], undefined);
});

test('a composed-config verification failure rolls back the live profile', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'known-good');
  const candidate = await fixture.manager.receiveZip(pluginZip(fixture.root));
  fixture.runtime.badDump = true;
  await assert.rejects(fixture.manager.activate(candidate.id), /composed Harness config/);
  assert.equal(readProfile(fixture.runtime), 'known-good');
  assert.equal(fixture.manager.getPendingChange(), null);
});

test('disable failure restores the plugin and successful disable remains rollbackable', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'known-good');
  const candidate = await fixture.manager.receiveZip(pluginZip(fixture.root));
  await fixture.manager.activate(candidate.id);
  fixture.manager.confirmPendingRestart();

  fixture.runtime.failRemove = true;
  await assert.rejects(fixture.manager.disable(candidate.name), /disable failed and was rolled back/);
  assert.equal(readProfile(fixture.runtime), 'active:dsh-test@1.0.0');
  assert.ok(fixture.manager.state.installed[candidate.name]);

  fixture.runtime.failRemove = false;
  await fixture.manager.disable(candidate.name);
  assert.equal(readProfile(fixture.runtime), 'disabled');
  assert.equal(fixture.manager.state.installed[candidate.name], undefined);
  fixture.manager.confirmPendingRestart();
  await fixture.manager.rollbackPrevious();
  assert.equal(readProfile(fixture.runtime), 'active:dsh-test@1.0.0');
  assert.ok(fixture.manager.state.installed[candidate.name]);
});

test('successful activate, restart confirmation, and manual rollback preserve exact state', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'known-good');
  const candidate = await fixture.manager.receiveZip(pluginZip(fixture.root));
  await fixture.manager.activate(candidate.id);
  assert.equal(readProfile(fixture.runtime), 'active:dsh-test@1.0.0');
  assert.equal(fixture.manager.getPendingChange().phase, 'awaiting-restart');
  assert.equal(fixture.manager.confirmPendingRestart(), true);
  assert.equal(fixture.manager.getPendingChange(), null);
  await fixture.manager.rollbackPrevious();
  assert.equal(readProfile(fixture.runtime), 'known-good');
  assert.deepEqual(fixture.manager.state.installed, {});
  assert.equal(fixture.manager.state.history.length, 0);
  assert.equal(fixture.manager.state.candidates[candidate.id].status, 'ready');
});

test('an interrupted successful change is recovered by a new manager instance', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'known-good');
  const candidate = await fixture.manager.receiveZip(pluginZip(fixture.root));
  await fixture.manager.activate(candidate.id);
  assert.equal(readProfile(fixture.runtime), 'active:dsh-test@1.0.0');

  const restartedRuntime = new MockRuntime(fixture.root);
  const restarted = new PluginManager({
    userData: fixture.manager.userData,
    runtime: restartedRuntime,
    logger: () => {},
    getWorkspace: () => fixture.root,
  });
  await restarted.recoverPendingChange();
  assert.equal(readProfile(restartedRuntime), 'known-good');
  assert.deepEqual(restarted.state.installed, {});
  assert.equal(restarted.getPendingChange(), null);
  assert.equal(restarted.state.candidates[candidate.id].status, 'ready');
});

test('post-restart config verification detects a broken installed plugin and recovers it', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'known-good');
  const candidate = await fixture.manager.receiveZip(pluginZip(fixture.root));
  await fixture.manager.activate(candidate.id);
  fixture.runtime.badDump = true;
  const verification = await fixture.manager.verifyPendingChange();
  assert.equal(verification.ok, false);
  assert.match(verification.error, /missing from the composed config/);
  await fixture.manager.recoverPendingChange();
  assert.equal(readProfile(fixture.runtime), 'known-good');
  assert.equal(fixture.manager.state.candidates[candidate.id].status, 'ready');
});

test('a failed rollback restore puts the pre-rollback live profile back', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'snapshot-version');
  const snapshot = fixture.manager.snapshotProfile('test rollback transaction');
  writeProfile(fixture.runtime, 'current-version');
  fixture.runtime.failInstall = true;
  await assert.rejects(fixture.manager.restoreSnapshot(snapshot.snapshotPath), /pre-rollback profile was put back/);
  assert.equal(readProfile(fixture.runtime), 'current-version');
});

test('startup removes staging debris left by an interrupted receive', () => {
  const root = makeRoot();
  const userData = path.join(root, 'user-data');
  const orphan = path.join(userData, 'plugin-staging', 'orphan');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'partial.txt'), 'partial');
  const runtime = new MockRuntime(root);
  const manager = new PluginManager({ userData, runtime, logger: () => {}, getWorkspace: () => root });
  assert.deepEqual(fs.readdirSync(manager.stagingDir), []);
});

test('three receive-activate-confirm-rollback cycles do not corrupt state', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'baseline');
  for (let index = 1; index <= 3; index += 1) {
    const candidate = await fixture.manager.receiveZip(pluginZip(fixture.root, {
      version: `1.0.${index}`,
      fileName: `cycle-${index}`,
    }));
    await fixture.manager.activate(candidate.id);
    fixture.manager.confirmPendingRestart();
    assert.equal(readProfile(fixture.runtime), `active:dsh-test@1.0.${index}`);
    await fixture.manager.rollbackPrevious();
    assert.equal(readProfile(fixture.runtime), 'baseline');
    assert.deepEqual(fixture.manager.state.installed, {});
    assert.equal(fixture.manager.state.history.length, 0);
    assert.equal(fixture.manager.getPendingChange(), null);
  }
});

test('a snapshot missing its captured profile never replaces the live profile', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'live-working-profile');
  const snapshot = fixture.manager.snapshotProfile('before a change');
  assert.equal(snapshot.hasProfile, true);

  // Interrupted copy / partial cleanup leaves the snapshot without its profile.
  fs.rmSync(path.join(snapshot.snapshotPath, 'profile'), { recursive: true, force: true });

  await assert.rejects(
    fixture.manager.restoreSnapshot(snapshot.snapshotPath),
    /missing its captured profile/,
  );
  assert.equal(readProfile(fixture.runtime), 'live-working-profile');
});

test('a snapshot taken before any profile existed restores by removing the profile', async () => {
  const fixture = managerFixture();
  const snapshot = fixture.manager.snapshotProfile('first ever install');
  assert.equal(snapshot.hasProfile, false);

  writeProfile(fixture.runtime, 'created-by-plugin-install');
  await fixture.manager.restoreSnapshot(snapshot.snapshotPath);
  assert.equal(fs.existsSync(path.join(fixture.runtime.dshHome, 'profiles', 'web')), false);
});

test('post-restart verification matches whole plugin names, not substrings', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'live');
  const snapshot = fixture.manager.snapshotProfile('verification');

  // The composed config contains a DIFFERENT plugin whose name merely starts
  // with the one being verified.
  fixture.runtime.activeName = 'dsh-metrics-extra';

  fixture.manager.state.pendingChange = {
    phase: 'awaiting-restart', type: 'install', plugin: 'dsh-metrics', snapshotPath: snapshot.snapshotPath,
  };
  const installed = await fixture.manager.verifyPendingChange();
  assert.equal(installed.ok, false, 'a plugin that was never installed passed verification');

  fixture.manager.state.pendingChange = {
    phase: 'awaiting-restart', type: 'disable', plugin: 'dsh-metrics', snapshotPath: snapshot.snapshotPath,
  };
  const disabled = await fixture.manager.verifyPendingChange();
  assert.equal(disabled.ok, true, 'a genuinely removed plugin was reported as still present');
});

test('plugin name matching respects token boundaries and regex metacharacters', () => {
  const { configMentionsPlugin } = require('../lib/plugin-manager');
  assert.equal(configMentionsPlugin("  name: 'dsh-metrics'", 'dsh-metrics'), true);
  assert.equal(configMentionsPlugin('  name: dsh-metrics-extra', 'dsh-metrics'), false);
  assert.equal(configMentionsPlugin("  name: '@scope/pkg'", '@scope/pkg'), true);
  assert.equal(configMentionsPlugin("  name: '@scope/pkg-2'", '@scope/pkg'), false);
  // '.' and '+' are regex metacharacters but legal in package names.
  assert.equal(configMentionsPlugin('  name: dsh-a.b', 'dsh-a.b'), true);
  assert.equal(configMentionsPlugin('  name: dsh-aXb', 'dsh-a.b'), false);
  assert.equal(configMentionsPlugin('', 'dsh-core'), false);
});

// adm-zip rewrites entry names on both write and read, so a traversal archive has
// to be assembled byte by byte to reach the extractor at all.
function rawZip(entries) {
  const { crc32 } = require('node:zlib');
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, contents] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.from(contents, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + data.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

test('a hostile archive never writes outside managed storage', async () => {
  const fixture = managerFixture();
  const targets = [
    path.join(fixture.root, 'ESCAPED.txt'),
    path.join(fixture.root, '..', 'ESCAPED.txt'),
    path.join(fixture.manager.userData, 'ESCAPED.txt'),
  ];

  const hostileNames = [
    '../ESCAPED.txt',
    'plugin/../../ESCAPED.txt',
    'plugin/nested/../../../ESCAPED.txt',
    '..\ESCAPED.txt',
    'plugin\..\..\ESCAPED.txt',
    '/ESCAPED.txt',
    'C:\ESCAPED.txt',
    '\\server\share\ESCAPED.txt',
  ];

  for (const entryName of hostileNames) {
    const file = path.join(fixture.root, `hostile-${crypto.randomUUID()}.zip`);
    fs.writeFileSync(file, rawZip([[entryName, 'escaped']]));

    // Rejecting the archive and neutralising the entry are both acceptable; what
    // must never happen is a write outside the disposable staging directory.
    await assert.rejects(fixture.manager.receiveZip(file), `${entryName} was accepted as a plugin`);

    for (const target of targets) {
      assert.equal(fs.existsSync(target), false, `${entryName} escaped to ${target}`);
    }
  }

  // Staging is left clean after every rejected archive.
  assert.deepEqual(fs.readdirSync(fixture.manager.stagingDir), []);
});

test('an archive with no single plugin root is rejected with a clear reason', async () => {
  const fixture = managerFixture();

  // Two candidate roots: the manager must refuse rather than guess.
  const two = new AdmZip();
  for (const dir of ['first', 'second']) {
    two.addFile(`${dir}/package.json`, Buffer.from(JSON.stringify({
      name: `dsh-${dir}`, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    })));
    two.addFile(`${dir}/cordis.patch.yml`, Buffer.from('- id: x\n'));
  }
  const twoFile = path.join(fixture.root, 'two-roots.zip');
  two.writeZip(twoFile);
  await assert.rejects(fixture.manager.receiveZip(twoFile), /multiple possible plugin roots/);

  // No manifest anywhere.
  const none = new AdmZip();
  none.addFile('docs/readme.txt', Buffer.from('nothing installable here'));
  const noneFile = path.join(fixture.root, 'no-root.zip');
  none.writeZip(noneFile);
  await assert.rejects(fixture.manager.receiveZip(noneFile), /No package.json found at the plugin root/);

  assert.deepEqual(fs.readdirSync(fixture.manager.stagingDir), []);
  assert.deepEqual(fs.readdirSync(fixture.manager.versionsDir), []);
});

function writeProfileManifest(runtime, bundles) {
  const profile = path.join(runtime.dshHome, 'profiles', 'web');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: { 'dsh-extra': '1.0.0' },
    dsh: { profile: { bundles } },
  }, null, 2));
  return path.join(profile, 'package.json');
}
function readBundles(runtime) {
  const file = path.join(runtime.dshHome, 'profiles', 'web', 'package.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).dsh.profile.bundles;
}

test('restoring the core state keeps shipped bundles and drops the rest', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'live');
  writeProfileManifest(fixture.runtime, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-extra', '@someone/dsh-theme',
  ]);
  fixture.manager.state.installed = { 'dsh-extra': { name: 'dsh-extra', version: '1.0.0' } };

  const result = await fixture.manager.restoreCore();

  assert.deepEqual(readBundles(fixture.runtime), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  assert.deepEqual(result.removed.sort(), ['@someone/dsh-theme', 'dsh-extra']);
  assert.deepEqual(fixture.manager.state.installed, {}, 'tracked plugins should be cleared');
  // Removal goes through DSH, so the dependency goes with the bundle; the
  // snapshot taken first is what makes it reversible.
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.runtime.dshHome, 'profiles', 'web', 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['dsh-extra'], undefined);
});

test('restoring the core state leaves a rollback point', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'before-restore');
  writeProfileManifest(fixture.runtime, ['@deepseek-ai/dsh-base', 'dsh-extra']);

  await fixture.manager.restoreCore();
  assert.equal(fixture.manager.state.history.at(-1).type, 'restore-core');
  fixture.manager.confirmPendingRestart();

  await fixture.manager.rollbackPrevious();
  assert.deepEqual(readBundles(fixture.runtime), ['@deepseek-ai/dsh-base', 'dsh-extra'],
    'rollback should put the removed plugins back');
  assert.equal(readProfile(fixture.runtime), 'before-restore');
});

test('restoring moves skill folders aside instead of deleting them', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'live');
  writeProfileManifest(fixture.runtime, ['@deepseek-ai/dsh-base']);

  const skills = path.join(fixture.root, 'ws', '.dsh', 'skills');
  fs.mkdirSync(path.join(skills, 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\n');

  const result = await fixture.manager.restoreCore({ skillDirs: [skills] });

  assert.equal(fs.existsSync(skills), false, 'the live skills directory should be gone');
  assert.equal(result.movedSkills.length, 1);
  assert.equal(fs.existsSync(path.join(result.movedSkills[0], 'my-skill', 'SKILL.md')), true,
    'the skill content must survive the move');
});

test('a restore that leaves the engine unhealthy puts the old profile back', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'known-good');
  writeProfileManifest(fixture.runtime, ['@deepseek-ai/dsh-base', 'dsh-extra']);
  fixture.runtime.startResults = [false, true]; // restore start fails, recovery start works

  await assert.rejects(fixture.manager.restoreCore(), /previous profile was put back/);
  assert.equal(readProfile(fixture.runtime), 'known-good');
  assert.deepEqual(readBundles(fixture.runtime), ['@deepseek-ai/dsh-base', 'dsh-extra']);
  assert.equal(fixture.manager.getPendingChange(), null);
});

test('a restore with nothing to remove is still safe', async () => {
  const fixture = managerFixture();
  writeProfile(fixture.runtime, 'live');
  writeProfileManifest(fixture.runtime, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  const result = await fixture.manager.restoreCore();
  assert.deepEqual(result.removed, []);
  assert.deepEqual(readBundles(fixture.runtime), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
});
