const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { validatePluginDirectory } = require('./plugin-validator');

const MAX_ARCHIVE_ENTRIES = 5000;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function copyTree(source, destination, filter = () => true) {
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
    filter,
  });
}

function removeTree(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

// `--dump-config` emits YAML, so a plugin name is always a whole token. A raw
// substring test lets "dsh-metrics-extra" satisfy a check for "dsh-metrics" --
// passing post-restart verification for a plugin that was never installed, and
// making a successful disable of "dsh-metrics" look like a failure.
function configMentionsPlugin(dump, name) {
  const text = String(dump);
  const needle = String(name);
  if (!needle) return false;
  const isNameChar = (ch) => ch !== undefined && /[A-Za-z0-9._@/-]/.test(ch);
  for (let from = 0; ; ) {
    const at = text.indexOf(needle, from);
    if (at === -1) return false;
    if (!isNameChar(text[at - 1]) && !isNameChar(text[at + needle.length])) return true;
    from = at + 1;
  }
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
    this.profileName = runtime.profileName || 'web';
    this.logger = logger;
    this.getWorkspace = getWorkspace;
    this.stateFile = path.join(userData, 'plugin-state.json');
    this.stagingDir = path.join(userData, 'plugin-staging');
    this.versionsDir = path.join(userData, 'plugin-versions');
    this.snapshotsDir = path.join(userData, 'profile-snapshots');
    fs.mkdirSync(this.stagingDir, { recursive: true });
    fs.mkdirSync(this.versionsDir, { recursive: true });
    fs.mkdirSync(this.snapshotsDir, { recursive: true });
    this.state = readJson(this.stateFile, { candidates: {}, installed: {}, history: [], pendingChange: null });
    this.state.candidates ||= {};
    this.state.installed ||= {};
    this.state.history ||= [];
    this.state.pendingChange ||= null;
    // Staging is deliberately disposable. Clearing it makes a process kill during
    // extraction/install recoverable without ever touching a live profile.
    removeTree(this.stagingDir);
    fs.mkdirSync(this.stagingDir, { recursive: true });
  }

  save() {
    const temporary = `${this.stateFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2));
    fs.renameSync(temporary, this.stateFile);
  }

  safeName(name) {
    return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
  }

  async receiveZip(zipPath) {
    const candidateId = crypto.randomUUID();
    const extractDir = path.join(this.stagingDir, candidateId);
    fs.mkdirSync(extractDir, { recursive: true });

    let versionPath = null;
    try {
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();
      if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('Plugin archive contains too many files.');

      let uncompressedBytes = 0;
      for (const entry of entries) {
        const normalized = entry.entryName.replace(/\\/g, '/');
        if (normalized.includes('\0')
            || normalized.startsWith('/')
            || path.win32.isAbsolute(normalized)
            || normalized.split('/').includes('..')) {
          throw new Error(`Unsafe archive path: ${entry.entryName}`);
        }
        uncompressedBytes += Number(entry.header?.size || 0);
        if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
          throw new Error('Plugin archive expands beyond the 512 MiB safety limit.');
        }
      }
      zip.extractAllTo(extractDir, true);

      const pluginRoot = findPluginRoot(extractDir);
      const validation = validatePluginDirectory(pluginRoot);
      if (!validation.ok) {
        this.state.candidates[candidateId] = {
          id: candidateId,
          source: zipPath,
          path: null,
          status: 'invalid',
          validation,
        };
        this.save();
        return this.state.candidates[candidateId];
      }

      const { manifest } = validation;
      versionPath = path.join(
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
      versionPath = null;
      return candidate;
    } catch (error) {
      if (versionPath) {
        removeTree(versionPath);
        // Drop the package directory too when this was its only version, so a
        // failed receive leaves no empty debris in managed storage.
        const packageDir = path.dirname(versionPath);
        try { if (fs.readdirSync(packageDir).length === 0) fs.rmdirSync(packageDir); } catch {}
      }
      this.logger('plugin', `Plugin receive failed: ${error.message}`);
      throw error;
    } finally {
      removeTree(extractDir);
    }
  }

  snapshotProfile(reason) {
    const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const snapshotPath = path.join(this.snapshotsDir, id);
    const profilePath = path.join(this.runtime.dshHome, 'profiles', this.profileName);
    fs.mkdirSync(snapshotPath, { recursive: true });

    const hadProfile = fs.existsSync(profilePath);
    if (hadProfile) {
      copyTree(profilePath, path.join(snapshotPath, 'profile'), (src) => path.basename(src) !== 'node_modules');
    }

    const metadata = { id, reason, createdAt: new Date().toISOString(), snapshotPath, hasProfile: hadProfile };
    fs.writeFileSync(path.join(snapshotPath, 'metadata.json'), JSON.stringify(metadata, null, 2));
    return metadata;
  }

  async restoreSnapshot(snapshotPath) {
    const profilePath = path.join(this.runtime.dshHome, 'profiles', this.profileName);
    const savedProfile = path.join(snapshotPath, 'profile');
    // A snapshot that lost its captured profile must never replace the live one:
    // renaming the live profile away with no replacement destroys the only working
    // copy silently. hasProfile:false is a legitimate "no profile existed yet"
    // snapshot and is still allowed to restore, which removes the profile.
    const snapshotMeta = readJson(path.join(snapshotPath, 'metadata.json'), null);
    if (!fs.existsSync(savedProfile) && snapshotMeta?.hasProfile !== false) {
      throw new Error(`Profile snapshot ${path.basename(snapshotPath)} is missing its captured profile, so the live profile was left untouched.`);
    }
    const profilesRoot = path.dirname(profilePath);
    const token = crypto.randomUUID().slice(0, 8);
    const replacementPath = path.join(profilesRoot, `.${this.profileName}-restore-${token}`);
    const displacedPath = path.join(profilesRoot, `.${this.profileName}-displaced-${token}`);
    await this.runtime.stop();

    fs.mkdirSync(profilesRoot, { recursive: true });
    if (fs.existsSync(savedProfile)) copyTree(savedProfile, replacementPath);

    let displaced = false;
    try {
      if (fs.existsSync(profilePath)) {
        fs.renameSync(profilePath, displacedPath);
        displaced = true;
      }
      if (fs.existsSync(replacementPath)) fs.renameSync(replacementPath, profilePath);

      if (fs.existsSync(savedProfile)) {
        const install = await this.runtime.runDsh(['plugin', '--profile', this.profileName, 'install'], { cwd: this.getWorkspace() });
        if (install.code !== 0) {
          throw new Error(`Rollback dependency restore failed.\n${install.stderr || install.stdout}`);
        }
      }

      const started = await this.runtime.start(this.getWorkspace());
      if (!started.ok) throw new Error('Harness did not become healthy after rollback.');
      removeTree(displacedPath);
    } catch (error) {
      await this.runtime.stop();
      removeTree(profilePath);
      if (displaced && fs.existsSync(displacedPath)) fs.renameSync(displacedPath, profilePath);
      removeTree(replacementPath);
      const previousStarted = await this.runtime.start(this.getWorkspace());
      const suffix = previousStarted.ok
        ? 'The pre-rollback profile was put back.'
        : 'The pre-rollback profile was put back, but Harness is still unhealthy.';
      throw new Error(`${error.message}\n${suffix}`);
    } finally {
      removeTree(replacementPath);
    }
  }

  async rollbackFailedChange(snapshotPath) {
    await this.restoreSnapshot(snapshotPath);
    this.state.history.pop();
    this.state.pendingChange = null;
    this.save();
    removeTree(snapshotPath);
  }

  beginChange(entry) {
    this.state.history.push(entry);
    this.state.pendingChange = {
      historyCreatedAt: entry.createdAt,
      snapshotPath: entry.snapshotPath,
      installedBefore: clone(entry.installedBefore || {}),
      type: entry.type,
      plugin: entry.plugin,
      candidateId: entry.candidateId || null,
      candidateStatusBefore: entry.candidateStatusBefore || null,
      phase: 'changing',
    };
    this.save();
  }

  markAwaitingRestart() {
    if (this.state.pendingChange) this.state.pendingChange.phase = 'awaiting-restart';
    this.save();
  }

  confirmPendingRestart() {
    if (!this.state.pendingChange) return false;
    this.state.pendingChange = null;
    this.save();
    return true;
  }

  getPendingChange() {
    return this.state.pendingChange ? clone(this.state.pendingChange) : null;
  }

  async recoverPendingChange() {
    const pending = this.state.pendingChange;
    if (!pending) return { ok: true, recovered: false };
    this.logger('plugin', 'Recovering the previous working profile after an interrupted or failed change.');
    await this.restoreSnapshot(pending.snapshotPath);
    this.state.installed = clone(pending.installedBefore || {});
    if (pending.candidateId && this.state.candidates[pending.candidateId]) {
      this.state.candidates[pending.candidateId].status = pending.candidateStatusBefore || 'ready';
    }
    this.state.history = this.state.history.filter((entry) => entry.createdAt !== pending.historyCreatedAt);
    this.state.pendingChange = null;
    this.save();
    removeTree(pending.snapshotPath);
    return { ok: true, recovered: true };
  }

  async verifyPendingChange() {
    const pending = this.state.pendingChange;
    if (!pending || pending.phase !== 'awaiting-restart') return { ok: true };
    const dump = await this.runtime.runDsh(['--profile', this.profileName, '--dump-config'], { cwd: this.getWorkspace() });
    if (dump.code !== 0) return { ok: false, error: dump.stderr || dump.stdout || 'Config dump failed.' };
    const present = configMentionsPlugin(dump.stdout, pending.plugin);
    if (pending.type === 'install' && !present) {
      return { ok: false, error: `${pending.plugin} is missing from the composed config.` };
    }
    if (pending.type === 'disable' && present) {
      return { ok: false, error: `${pending.plugin} is still present after disable.` };
    }
    return { ok: true };
  }

  async activate(candidateId) {
    const candidate = this.state.candidates[candidateId];
    if (!candidate || candidate.status !== 'ready') throw new Error('Plugin candidate is not ready.');

    const candidateRoot = path.resolve(candidate.path);
    const versionsRoot = `${path.resolve(this.versionsDir)}${path.sep}`;
    if (!candidateRoot.startsWith(versionsRoot) || !fs.existsSync(candidateRoot)) {
      throw new Error('Plugin candidate files are missing or outside managed storage.');
    }
    const validation = validatePluginDirectory(candidateRoot);
    if (!validation.ok) throw new Error(`Plugin candidate is no longer valid: ${validation.errors.join('; ')}`);

    const snapshot = this.snapshotProfile(`Before installing ${candidate.name}@${candidate.version}`);
    const entry = {
      type: 'install',
      plugin: candidate.name,
      version: candidate.version,
      snapshotPath: snapshot.snapshotPath,
      createdAt: snapshot.createdAt,
      installedBefore: clone(this.state.installed),
      candidateId,
      candidateStatusBefore: candidate.status,
    };
    this.beginChange(entry);

    await this.runtime.stop();
    const add = await this.runtime.runDsh(
      ['plugin', '--profile', this.profileName, 'add', candidate.path],
      { cwd: this.getWorkspace() },
    );
    if (add.code !== 0) {
      await this.rollbackFailedChange(snapshot.snapshotPath);
      throw new Error(`Plugin activation failed and was rolled back.\n${add.stderr || add.stdout}`);
    }

    const dump = await this.runtime.runDsh(['--profile', this.profileName, '--dump-config'], { cwd: this.getWorkspace() });
    if (dump.code !== 0 || !configMentionsPlugin(dump.stdout, candidate.name)) {
      await this.rollbackFailedChange(snapshot.snapshotPath);
      throw new Error('Plugin did not appear in the composed Harness config. Previous profile was restored.');
    }

    const started = await this.runtime.start(this.getWorkspace());
    if (!started.ok) {
      await this.rollbackFailedChange(snapshot.snapshotPath);
      throw new Error('Harness failed its post-install health check. Previous profile was restored.');
    }

    candidate.status = 'active';
    this.state.installed[candidate.name] = {
      name: candidate.name,
      version: candidate.version,
      path: candidate.path,
      activatedAt: new Date().toISOString(),
    };
    this.markAwaitingRestart();
    return { ok: true, plugin: this.state.installed[candidate.name] };
  }

  async disable(name) {
    if (!this.state.installed[name]) throw new Error('Plugin is not tracked as installed.');
    const snapshot = this.snapshotProfile(`Before disabling ${name}`);
    const entry = {
      type: 'disable',
      plugin: name,
      snapshotPath: snapshot.snapshotPath,
      createdAt: snapshot.createdAt,
      installedBefore: clone(this.state.installed),
    };
    this.beginChange(entry);

    await this.runtime.stop();
    const remove = await this.runtime.runDsh(['plugin', '--profile', this.profileName, 'remove', name], { cwd: this.getWorkspace() });
    if (remove.code !== 0) {
      await this.rollbackFailedChange(snapshot.snapshotPath);
      throw new Error(`Plugin disable failed and was rolled back.\n${remove.stderr || remove.stdout}`);
    }

    const started = await this.runtime.start(this.getWorkspace());
    if (!started.ok) {
      await this.rollbackFailedChange(snapshot.snapshotPath);
      throw new Error('Harness failed after disabling plugin. Previous profile was restored.');
    }
    delete this.state.installed[name];
    this.markAwaitingRestart();
    return { ok: true };
  }

  async rollbackPrevious() {
    const previous = this.state.history[this.state.history.length - 1];
    if (!previous) throw new Error('No rollback point is available yet.');
    await this.restoreSnapshot(previous.snapshotPath);
    this.state.history.pop();
    this.state.installed = clone(previous.installedBefore || {});
    if (previous.candidateId && this.state.candidates[previous.candidateId]) {
      this.state.candidates[previous.candidateId].status = previous.candidateStatusBefore || 'ready';
    }
    this.state.pendingChange = null;
    this.save();
    removeTree(previous.snapshotPath);
    return { ok: true, restored: previous };
  }

  /**
   * Reset the live profile to the bundles DSH itself ships, dropping every
   * third-party plugin. Snapshot-backed and recorded in history, so the normal
   * Rollback control puts everything back. Skill folders are moved aside rather
   * than deleted - this must not destroy work.
   */
  async restoreCore({ skillDirs = [] } = {}) {
    const profilePath = path.join(this.runtime.dshHome, 'profiles', this.profileName);
    const manifest = readJson(path.join(profilePath, 'package.json'), null);
    if (!manifest) throw new Error('The live profile has no readable package.json.');

    const before = manifest.dsh?.profile?.bundles || [];
    const core = before.filter((name) => String(name).startsWith('@deepseek-ai/'));
    const removed = before.filter((name) => !core.includes(name));

    const snapshot = this.snapshotProfile('Before restoring Harness to its core state');
    const entry = {
      type: 'restore-core',
      plugin: 'harness-core',
      snapshotPath: snapshot.snapshotPath,
      createdAt: snapshot.createdAt,
      installedBefore: clone(this.state.installed),
    };
    this.beginChange(entry);

    const movedSkills = [];
    try {
      await this.runtime.stop();

      // `dsh plugin install` reconciles dsh.profile.bundles back from whatever is
      // still a dependency, so editing the manifest alone is undone. Removing each
      // plugin through DSH is the supported path and actually sticks.
      for (const name of removed) {
        const result = await this.runtime.runDsh(['plugin', '--profile', this.profileName, 'remove', name], { cwd: this.getWorkspace() });
        if (result.code !== 0) {
          throw new Error(`Could not remove ${name}.\n${result.stderr || result.stdout}`);
        }
      }

      const started = await this.runtime.start(this.getWorkspace());
      if (!started.ok) throw new Error(started.reason || 'Harness did not become healthy after the restore.');

      // Only once the engine is healthy do we touch skills.
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
      for (const dir of skillDirs) {
        if (!fs.existsSync(dir)) continue;
        const parked = `${dir}.disabled-${stamp}`;
        fs.renameSync(dir, parked);
        movedSkills.push(parked);
      }
    } catch (error) {
      await this.rollbackFailedChange(snapshot.snapshotPath);
      throw new Error(`Restore failed and the previous profile was put back.\n${error.message}`);
    }

    this.state.installed = {};
    this.markAwaitingRestart();
    this.logger(
      'plugin',
      `Harness restored to its core state. Unmounted ${removed.length} plugin(s)`
      + (movedSkills.length ? `, moved ${movedSkills.length} skill folder(s) aside` : '')
      + '. Use Roll back to undo.',
    );
    return { ok: true, removed, kept: core, movedSkills };
  }

  list() {
    return {
      installed: Object.values(this.state.installed),
      history: this.state.history.slice(-20).reverse(),
      candidates: Object.values(this.state.candidates).slice(-20).reverse(),
    };
  }
}

module.exports = { PluginManager, findPluginRoot, configMentionsPlugin };
