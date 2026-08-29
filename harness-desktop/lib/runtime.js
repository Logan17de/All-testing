const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const IPC_PREFIX = '\u001eHARNESS_DESKTOP_IPC ';

// The first launch after installation pays for Windows scanning several hundred
// megabytes of freshly written, unsigned files: the engine has been measured at
// ~48s cold versus ~4s warm. waitHealthy still gives up the moment the engine
// process dies, so a generous ceiling only extends the alive-but-slow case and
// keeps a genuinely broken engine failing fast.
const ENGINE_HEALTH_TIMEOUT_MS = 180_000;

// A profile can mount our bridge - firing the ready handshake - and only then
// fail its own activation assert, which kills the engine a few seconds later.
// Hold briefly after ready so a doomed boot is never reported as healthy.
const ENGINE_SETTLE_MS = 6000;

// Enough stderr to explain a boot failure, not enough to grow unbounded.
const BOOT_LOG_LIMIT = 64 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HarnessRuntime extends EventEmitter {
  constructor({ appRoot, logger, dshHome, profileName }) {
    super();
    this.appRoot = appRoot;
    this.logger = logger;
    this.child = null;
    this.ready = false;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.bootLog = '';
    this.lastStartError = '';
    this.workspace = os.homedir();
    this.dshHome = dshHome || process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
    this.profileName = profileName || process.env.HARNESS_DESKTOP_PROFILE?.trim() || 'web';

    this.dshPackageRoot = path.dirname(require.resolve('@deepseek-ai/dsh/package.json'));
    this.dshCli = path.join(this.dshPackageRoot, 'lib', 'bin.js');
    this.enginePatchTemplate = path.join(this.appRoot, 'lib', 'native-engine.patch.yml');
    this.enginePlugin = path.join(this.appRoot, 'lib', 'engine-bridge.mjs');

    // pnpm does not export ./package.json, so require.resolve('pnpm/package.json')
    // throws ERR_PACKAGE_PATH_NOT_EXPORTED on current pnpm releases. Resolve the
    // bundled dependency directly from the app root instead; this works both in
    // development and in the unpacked Electron application produced by builder.
    this.pnpmPackageRoot = path.join(this.appRoot, 'node_modules', 'pnpm');
    const pnpmManifestPath = path.join(this.pnpmPackageRoot, 'package.json');
    if (!fs.existsSync(pnpmManifestPath)) {
      throw new Error(`Bundled pnpm package was not found at ${pnpmManifestPath}`);
    }
    const pnpmManifest = JSON.parse(fs.readFileSync(pnpmManifestPath, 'utf8'));
    const pnpmBin = typeof pnpmManifest.bin === 'string' ? pnpmManifest.bin : pnpmManifest.bin?.pnpm;
    if (!pnpmBin) throw new Error('Bundled pnpm package does not define a pnpm binary.');
    this.pnpmCli = path.join(this.pnpmPackageRoot, pnpmBin);

    const appKey = createHash('sha256').update(this.appRoot).digest('hex').slice(0, 12);
    this.shimDir = path.join(os.tmpdir(), `harness-desktop-runtime-bin-${appKey}`);
    this.ensureRuntimeShims();
    this.ensureDesktopProfile();
    this.enginePatch = this.writeEnginePatch();
  }

  ensureDesktopProfile() {
    if (this.profileName !== 'desktop') return;
    const profile = path.join(this.dshHome, 'profiles', this.profileName);
    fs.mkdirSync(profile, { recursive: true });
    const writeIfMissing = (name, contents) => {
      const target = path.join(profile, name);
      if (!fs.existsSync(target)) fs.writeFileSync(target, contents, 'utf8');
    };
    writeIfMissing('package.json', `${JSON.stringify({
      name: 'dsh-profile-harness-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2)}\n`);
    writeIfMissing('cordis.yml', '[]\n');
    writeIfMissing('cordis.patch.yml', '[]\n');
    writeIfMissing('pnpm-workspace.yaml', 'packages: []\n');
  }

  ensureRuntimeShims() {
    fs.mkdirSync(this.shimDir, { recursive: true });
    if (process.platform === 'win32') {
      fs.writeFileSync(
        path.join(this.shimDir, 'pnpm.cmd'),
        '@echo off\r\n"%HARNESS_DESKTOP_NODE%" "%HARNESS_DESKTOP_PNPM%" %*\r\n',
      );
    } else {
      const shim = path.join(this.shimDir, 'pnpm');
      fs.writeFileSync(shim, '#!/bin/sh\nexec "$HARNESS_DESKTOP_NODE" "$HARNESS_DESKTOP_PNPM" "$@"\n');
      fs.chmodSync(shim, 0o755);
    }
  }

  writeEnginePatch() {
    const destination = path.join(this.shimDir, 'native-engine.generated.patch.yml');
    const template = fs.readFileSync(this.enginePatchTemplate, 'utf8');
    const pluginUrl = pathToFileURL(this.enginePlugin).href;
    fs.writeFileSync(destination, template.replace('__HARNESS_DESKTOP_ENGINE_PLUGIN__', JSON.stringify(pluginUrl)));
    return destination;
  }

  nodeEnv() {
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HARNESS_DESKTOP_NODE: process.execPath,
      HARNESS_DESKTOP_PNPM: this.pnpmCli,
      DSH_HOME: this.dshHome,
      PATH: `${this.shimDir}${path.delimiter}${process.env.PATH || ''}`,
    };
  }

  runNodeScript(script, args, options = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [...(options.nodeArgs || []), script, ...args], {
        cwd: options.cwd || this.workspace,
        env: this.nodeEnv(),
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      // Once the timeout fires, the child's own 'close' (carrying the kill's exit
      // code) races taskkill's 'close'. Whichever wins, the result must still read
      // as a timeout, so normalise it here rather than at each call site.
      let timedOut = false;
      const timeoutMs = options.timeoutMs || 10 * 60_000;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(timedOut ? { ...result, code: -1, timedOut: true } : result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        const message = `Command timed out after ${Math.round(timeoutMs / 1000)} seconds.`;
        stderr = `${stderr}\n${message}`.trim();
        this.logger('runtime', message);
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
          killer.on('close', () => {
            if (child.exitCode === null) child.kill('SIGKILL');
            finish({ code: -1, stdout, stderr, timedOut: true });
          });
          killer.on('error', () => {
            if (child.exitCode === null) child.kill('SIGKILL');
            finish({ code: -1, stdout, stderr, timedOut: true });
          });
        } else {
          child.kill('SIGKILL');
          finish({ code: -1, stdout, stderr, timedOut: true });
        }
      }, timeoutMs);
      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        this.logger('runtime', text.trimEnd());
      });
      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        this.logger('runtime', text.trimEnd());
      });
      child.on('error', (error) => finish({ code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim() }));
      child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
    });
  }

  runDsh(args, options = {}) {
    return this.runNodeScript(this.dshCli, args, {
      ...options,
      nodeArgs: ['--expose-internals', ...(options.nodeArgs || [])],
    });
  }

  runPnpm(args, options = {}) {
    return this.runNodeScript(this.pnpmCli, args, options);
  }

  async start(workspace = this.workspace) {
    if (this.child && this.child.exitCode === null) {
      // Never report success for a child that has not completed the ready
      // handshake. main.js turns ok:true into a persisted "healthy" boot state,
      // so a premature success here suppresses Safe Mode after a crashed start.
      if (this.ready) return { ok: true, alreadyRunning: true };
      const inFlight = await this.waitHealthy(ENGINE_HEALTH_TIMEOUT_MS);
      if (!inFlight) await this.stop();
      return { ok: inFlight, alreadyRunning: true };
    }
    // An exited child must be cleared before a fresh spawn.
    if (this.child) await this.stop();
    this.stopping = false;
    this.workspace = workspace || os.homedir();
    this.ready = false;
    this.stdoutBuffer = '';
    this.bootLog = '';
    this.lastStartError = '';
    this.logger('runtime', 'Starting the Harness engine over desktop IPC.');

    // Bind every handler to THIS child. A stopped engine's exit/stdout events
    // arrive asynchronously, often after the next engine has already been
    // spawned; without an identity check the dead child's handler nulls
    // `this.child` and abandons a healthy new engine - a restart that fails in
    // ~500ms with no output, leaving an orphaned engine process running.
    const child = spawn(process.execPath, [
      '--expose-internals',
      this.dshCli,
      '--profile',
      this.profileName,
      '--patch',
      this.enginePatch,
    ], {
      cwd: this.workspace,
      env: this.nodeEnv(),
      windowsHide: true,
    });
    this.child = child;

    // Strict: a superseded engine must never mark the current one ready.
    child.stdout?.on('data', (chunk) => {
      if (this.child !== child) return;
      this.consumeStdout(chunk.toString());
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      if (this.child === child && this.bootLog.length < BOOT_LOG_LIMIT) this.bootLog += text;
      this.logger('harness', text.trimEnd());
    });
    child.on('error', (error) => {
      this.logger('harness', `Harness process failed: ${error.message}`);
      this.lastStartError = error.message;
      if (this.child && this.child !== child) return;
      this.rejectPending(error);
      this.ready = false;
      this.child = null;
    });
    child.on('exit', (code, signal) => {
      this.logger('harness', `Harness stopped (code=${code}, signal=${signal || 'none'}).`);
      if (this.child && this.child !== child) return;
      this.rejectPending(new Error(`Harness engine stopped (code ${code ?? 'unknown'}).`));
      this.ready = false;
      this.emit('status', { running: false, ready: false, code, signal, expected: this.stopping, reason: this.bootFailureReason() });
      this.child = null;
    });

    const healthy = await this.waitHealthy(ENGINE_HEALTH_TIMEOUT_MS);
    if (!healthy) {
      await this.stop();
      return { ok: false, reason: this.bootFailureReason() };
    }
    // Ready is not the same as staying up: hold, then confirm the engine survived.
    const settled = await this.settle(ENGINE_SETTLE_MS);
    if (!settled) {
      const reason = this.bootFailureReason();
      if (reason) this.logger('harness', reason);
      await this.stop();
      return { ok: false, reason };
    }
    return { ok: true };
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.child = null;
    this.ready = false;
    this.rejectPending(new Error('Harness engine stopped.'));

    if (process.platform === 'win32' && child.pid) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        killer.on('close', () => {
          if (child.exitCode === null) child.kill('SIGKILL');
          resolve();
        });
        killer.on('error', () => {
          if (child.exitCode === null) child.kill('SIGKILL');
          resolve();
        });
      });
    } else {
      child.kill('SIGTERM');
      await sleep(400);
      if (!child.killed) child.kill('SIGKILL');
    }
  }

  async restart(workspace = this.workspace) {
    await this.stop();
    return this.start(workspace);
  }

  /** Stay alive for `ms` after the ready handshake, then confirm health. */
  async settle(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!this.child || this.child.exitCode !== null) return false;
      await sleep(250);
    }
    return this.isHealthy();
  }

  /**
   * DSH reports a failed boot as a wall of stack trace. Pull out the entries that
   * never activated and the service they were waiting for, so the log says what
   * is actually wrong and which plugin to look at.
   */
  bootFailureReason() {
    const text = this.bootLog || '';
    if (!/entries did not activate/.test(text)) {
      if (this.lastStartError) return `Connection process failed: ${this.lastStartError}`;
      const explicit = [...text.matchAll(/^Error:\s+(.+)$/gm)].map((match) => match[1].trim()).filter(Boolean);
      if (explicit.length) return `Connection failed: ${explicit[0]}`;
      return null;
    }
    const pending = [...text.matchAll(/^\s*([@\w./-]+):\s*pending \(waiting for service: ([\w-]+)\)/gm)];
    if (!pending.length) return null;
    const byService = new Map();
    for (const [, plugin, service] of pending) {
      if (!byService.has(service)) byService.set(service, new Set());
      byService.get(service).add(plugin);
    }
    return [...byService.entries()].map(([service, plugins]) => {
      const names = [...plugins].join(', ');
      const note = service === 'webServer'
        ? 'Harness Desktop runs no web surface, so browser-UI plugins cannot activate here.'
        : `No mounted plugin provides "${service}".`;
      return `Engine boot failed: ${plugins.size} plugin(s) are waiting for "${service}" - ${names}. ${note}`;
    }).join(' ');
  }

  async isHealthy() {
    if (!this.child || this.child.exitCode !== null || !this.ready) return false;
    try { await this.request('host.describe', {}, 1500); return true; } catch { return false; }
  }

  async waitHealthy(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) {
        await sleep(300);
        if (this.child && this.child.exitCode === null && this.ready) return true;
      }
      if (!this.child) return false;
      await sleep(500);
    }
    return false;
  }

  consumeStdout(text) {
    this.stdoutBuffer += text;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith(IPC_PREFIX)) {
        this.logger('harness', line);
        continue;
      }
      try { this.handleIpcMessage(JSON.parse(line.slice(IPC_PREFIX.length))); }
      catch (error) { this.logger('runtime', `Rejected malformed engine IPC output: ${error.message}`); }
    }
  }

  handleIpcMessage(message) {
    if (message.type === 'ready') {
      this.ready = true;
      this.emit('status', { running: true, ready: true });
      return;
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.result?.ok) pending.resolve(message.result.value);
      else {
        const error = new Error(message.result?.error?.message || 'Harness request failed.');
        error.code = message.result?.error?.code || 'internal';
        error.details = message.result?.error?.details || {};
        pending.reject(error);
      }
      return;
    }
    if (message.type === 'event') {
      this.emit('event', { stream: message.stream, rpcId: message.rpcId, payload: message.payload });
      return;
    }
    this.logger('runtime', message.error?.message || `Engine IPC ${message.type || 'message'} received.`);
  }

  request(method, payload = {}, timeoutMs = 15_000) {
    if (!this.child || this.child.exitCode !== null || !this.ready) {
      return Promise.reject(new Error('Harness engine is not ready.'));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Harness request ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, payload })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  rejectPending(error) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }

  status() {
    let dshVersion = 'unknown';
    let pnpmVersion = 'unknown';
    try {
      dshVersion = JSON.parse(fs.readFileSync(path.join(this.dshPackageRoot, 'package.json'), 'utf8')).version;
      pnpmVersion = JSON.parse(fs.readFileSync(path.join(this.pnpmPackageRoot, 'package.json'), 'utf8')).version;
    } catch {}

    return {
      running: Boolean(this.child),
      ready: this.ready,
      transport: 'process-ipc',
      workspace: this.workspace,
      dshHome: this.dshHome,
      profileName: this.profileName,
      dshVersion,
      pnpmVersion,
      platform: `${process.platform}-${process.arch}`,
      bundledRuntime: true,
    };
  }
}

module.exports = { HarnessRuntime };
