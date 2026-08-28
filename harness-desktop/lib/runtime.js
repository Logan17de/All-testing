const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HarnessRuntime {
  constructor({ appRoot, logger, port = 3080 }) {
    this.appRoot = appRoot;
    this.logger = logger;
    this.port = port;
    this.child = null;
    this.workspace = os.homedir();
    this.dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');

    this.dshPackageRoot = path.dirname(require.resolve('@deepseek-ai/dsh/package.json'));
    this.dshCli = path.join(this.dshPackageRoot, 'lib', 'bin.js');
    this.pnpmPackageRoot = path.dirname(require.resolve('pnpm/package.json'));
    const pnpmManifest = JSON.parse(fs.readFileSync(path.join(this.pnpmPackageRoot, 'package.json'), 'utf8'));
    const pnpmBin = typeof pnpmManifest.bin === 'string' ? pnpmManifest.bin : pnpmManifest.bin?.pnpm;
    this.pnpmCli = path.join(this.pnpmPackageRoot, pnpmBin);
    this.shimDir = path.join(os.tmpdir(), 'harness-desktop-runtime-bin');
    this.ensureRuntimeShims();
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

  nodeEnv() {
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HARNESS_DESKTOP_NODE: process.execPath,
      HARNESS_DESKTOP_PNPM: this.pnpmCli,
      PATH: `${this.shimDir}${path.delimiter}${process.env.PATH || ''}`,
    };
  }

  runNodeScript(script, args, options = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: options.cwd || this.workspace,
        env: this.nodeEnv(),
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
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
      child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim() }));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  runDsh(args, options = {}) {
    return this.runNodeScript(this.dshCli, args, options);
  }

  runPnpm(args, options = {}) {
    return this.runNodeScript(this.pnpmCli, args, options);
  }

  async start(workspace = this.workspace) {
    if (this.child) return { ok: true, alreadyRunning: true };
    this.workspace = workspace || os.homedir();
    this.logger('runtime', `Starting Harness on http://127.0.0.1:${this.port}`);

    this.child = spawn(process.execPath, [this.dshCli, 'web', '--no-open', '--port', String(this.port)], {
      cwd: this.workspace,
      env: this.nodeEnv(),
      windowsHide: true,
    });

    this.child.stdout?.on('data', (chunk) => this.logger('harness', chunk.toString().trimEnd()));
    this.child.stderr?.on('data', (chunk) => this.logger('harness', chunk.toString().trimEnd()));
    this.child.on('exit', (code, signal) => {
      this.logger('harness', `Harness stopped (code=${code}, signal=${signal || 'none'}).`);
      this.child = null;
    });

    const healthy = await this.waitHealthy(45_000);
    return { ok: healthy };
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;

    if (process.platform === 'win32' && child.pid) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        killer.on('close', resolve);
        killer.on('error', resolve);
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

  async isHealthy() {
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}`, { signal: AbortSignal.timeout(1500) });
      return response.ok || response.status < 500;
    } catch {
      return false;
    }
  }

  async waitHealthy(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return true;
      if (!this.child) return false;
      await sleep(500);
    }
    return false;
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
      url: `http://127.0.0.1:${this.port}`,
      workspace: this.workspace,
      dshHome: this.dshHome,
      dshVersion,
      pnpmVersion,
      bundledRuntime: true,
    };
  }
}

module.exports = { HarnessRuntime };
