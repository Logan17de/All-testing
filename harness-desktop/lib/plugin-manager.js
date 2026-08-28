const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { validatePluginDirectory } = require('./plugin-validator');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function copyTree(source, destination, filter = () => true) {
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
    filter,
  });
}

function findPluginRoot(extractDir) {
  if (fs.existsSync(path.join(extractDir, 'package.json'))) return extractDir;
  const candidates = [];
  for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractDir, entry.name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) candidates.push(candidate);
  }
  if (candidates.length === 1) return candidates[0];
  throw new Error(candidates.length === 0
    ? 'No package.json found at the plugin root.'
    : 'Archive contains multiple possible plugin roots.');
}

class PluginManager {
  constructor({ userData, runtime, logger, getWorkspace }) {
    this.userData = userData;
    this.runtime = runtime;
    this.logger = logger;
    this.getWorkspace = getWorkspace;
    this.stateFile = path.join(userData, 'plugin-state.json');
    this.stagingDir = path.join(userData, 'plugin-staging');
    this.versionsDir = path.join(userData, 'plugin-versions');
    this.snapshotsDir = path.join(userData, 'profile-snapshots');
    fs.mkdirSync(this.stagingDir, { recursive: true });
    fs.mkdirSync(this.versionsDir, { recursive: true });
    fs.mkdirSync(this.snapshotsDir, { recursive: true });
    this.state = readJson(this.stateFile, { candidates: {}, installed: {}, history: [] });
  }

  save() {
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  safeName(name) {
    return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
  }

  async receiveZip(zipPath) {
    const candidateId = crypto.randomUUID();
    const extractDir = path.join(this.stagingDir, candidateId);
    fs.mkdirSync(extractDir, { recursive: true });

    const zip = new AdmZip(zipPath);
    for (const entry of zip.getEntries()) {
      const normalized = entry.entryName.replace(/\\/g, '/');
      if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
        throw new Error(`Unsafe archive path: ${entry.entryName}`);
      }
    }
    zip.extractAllTo(extractDir, true);

    const pluginRoot = findPluginRoot(extractDir);
    const validation = validatePluginDirectory(pluginRoot);
    if (!validation.ok) {
      this.state.candidates[candidateId] = {
        id: candidateId,
        source: zipPath,
        path: pluginRoot,
        status: 'invalid',
        validation,
      };
      this.save();
      return this.state.candidates[candidateId];
    }

    const { manifest } = validation;
    const versionPath = path.join(
      this.versionsDir,
      this.safeName(manifest.name),
      `${this.safeName(manifest.version)}-${candidateId.slice(0, 8)}`,
    );
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    copyTree(pluginRoot, versionPath);

    this.logger('plugin', `Installing dependencies for ${manifest.name}@${manifest.version}...`);
    const install = await this.runtime.runPnpm(['install', '--frozen-lockfile=false'], { cwd: versionPath });
    if (install.code !== 0) {
      throw new Error(`Plugin dependency install failed.\n${install.stderr || install.stdout}`);
    }

    if (manifest.scripts?.build) {
      this.logger('plugin', `Building ${manifest.name}@${manifest.version}...`);
      const build = await this.runtime.runPnpm(['run', 'build'], { cwd: versionPath });
      if (build.code !== 0) {
        throw new Error(`Plugin build failed.\n${build.stderr || build.stdout}`);
      }
    }

    const finalValidation = validatePluginDirectory(versionPath);
    if (!finalValidation.ok) {
      throw new Error(`Plugin became invalid after build: ${finalValidation.errors.join('; ')}`);
    }

    const candidate = {
      id: candidateId,
      source: zipPath,
      path: versionPath,
      status: 'ready',
      validation: finalValidation,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description || '',
      permissions: finalValidation.permissions || [],
    };
    this.state.candidates[candidateId] = candidate;
    this.save();
    return candidate;
  }

  snapshotProfile(reason) {
    const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const snapshotPath = path.join(this.snapshotsDir, id);
    const profilePath = path.join(this.runtime.dshHome, 'profiles', 'web');
    fs.mkdirSync(snapshotPath, { recursive: true });

    if (fs.existsSync(profilePath)) {
      copyTree(profilePath, path.join(snapshotPath, 'profile'), (src) => path.basename(src) !== 'node_modules');
    }

    const metadata = { id, reason, createdAt: new Date().toISOString(), snapshotPath };
    fs.writeFileSync(path.join(snapshotPath, 'metadata.json'), JSON.stringify(metadata, null, 2));
    return metadata;
  }

  async restoreSnapshot(snapshotPath) {
    const profilePath = path.join(this.runtime.dshHome, 'profiles', 'web');
    const savedProfile = path.join(snapshotPath, 'profile');
    await this.runtime.stop();

    fs.rmSync(profilePath, { recursive: true, force: true });
    if (fs.existsSync(savedProfile)) {
      copyTree(savedProfile, profilePath);
      const install = await this.runtime.runDsh(['plugin', '--profile', 'web', 'install'], { cwd: this.getWorkspace() });
      if (install.code !== 0) {
        throw new Error(`Rollback dependency restore failed.\n${install.stderr || install.stdout}`);
      }
    }

    const started = await this.runtime.start(this.getWorkspace());
    if (!started.ok) throw new Error('Harness did not become healthy after rollback.');
  }

  async activate(candidateId) {
    const candidate = this.state.candidates[candidateId];
    if (!candidate || candidate.status !== 'ready') throw new Error('Plugin candidate is not ready.');

    const snapshot = this.snapshotProfile(`Before installing ${candidate.name}@${candidate.version}`);
    this.state.history.push({
      type: 'install',
      plugin: candidate.name,
      version: candidate.version,
      snapshotPath: snapshot.snapshotPath,
      createdAt: snapshot.createdAt,
    });
    this.save();

    await this.runtime.stop();
    const add = await this.runtime.runDsh(
      ['plugin', '--profile', 'web', 'add', candidate.path],
      { cwd: this.getWorkspace() },
    );
    if (add.code !== 0) {
      await this.restoreSnapshot(snapshot.snapshotPath);
      throw new Error(`Plugin activation failed and was rolled back.\n${add.stderr || add.stdout}`);
    }

    const dump = await this.runtime.runDsh(['--profile', 'web', '--dump-config'], { cwd: this.getWorkspace() });
    if (dump.code !== 0 || !dump.stdout.includes(candidate.name)) {
      await this.restoreSnapshot(snapshot.snapshotPath);
      throw new Error('Plugin did not appear in the composed Harness config. Previous profile was restored.');
    }

    const started = await this.runtime.start(this.getWorkspace());
    if (!started.ok) {
      await this.restoreSnapshot(snapshot.snapshotPath);
      throw new Error('Harness failed its post-install health check. Previous profile was restored.');
    }

    candidate.status = 'active';
    this.state.installed[candidate.name] = {
      name: candidate.name,
      version: candidate.version,
      path: candidate.path,
      activatedAt: new Date().toISOString(),
    };
    this.save();
    return { ok: true, plugin: this.state.installed[candidate.name] };
  }

  async disable(name) {
    if (!this.state.installed[name]) throw new Error('Plugin is not tracked as installed.');
    const snapshot = this.snapshotProfile(`Before disabling ${name}`);
    this.state.history.push({ type: 'disable', plugin: name, snapshotPath: snapshot.snapshotPath, createdAt: snapshot.createdAt });
    this.save();

    await this.runtime.stop();
    const remove = await this.runtime.runDsh(['plugin', '--profile', 'web', 'remove', name], { cwd: this.getWorkspace() });
    if (remove.code !== 0) {
      await this.restoreSnapshot(snapshot.snapshotPath);
      throw new Error(`Plugin disable failed and was rolled back.\n${remove.stderr || remove.stdout}`);
    }

    const started = await this.runtime.start(this.getWorkspace());
    if (!started.ok) {
      await this.restoreSnapshot(snapshot.snapshotPath);
      throw new Error('Harness failed after disabling plugin. Previous profile was restored.');
    }
    delete this.state.installed[name];
    this.save();
    return { ok: true };
  }

  async rollbackPrevious() {
    const previous = this.state.history[this.state.history.length - 1];
    if (!previous) throw new Error('No rollback point is available yet.');
    await this.restoreSnapshot(previous.snapshotPath);
    this.state.history.pop();
    this.state.installed = {};
    this.save();
    return { ok: true, restored: previous };
  }

  list() {
    return {
      installed: Object.values(this.state.installed),
      history: this.state.history.slice(-20).reverse(),
      candidates: Object.values(this.state.candidates).slice(-20).reverse(),
    };
  }
}

module.exports = { PluginManager, findPluginRoot };
