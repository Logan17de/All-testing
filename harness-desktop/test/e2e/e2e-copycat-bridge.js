// Installs the Copycat bridge through the real plugin pipeline, lets it mount
// against a real Harness apiProxy, and proves its authenticated loopback API can
// create an ordinary Harness Session. No model call/API key is required.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const APP = path.resolve(__dirname, '..', '..');
const { HarnessRuntime } = require(path.join(APP, 'lib', 'runtime'));
const { PluginManager } = require(path.join(APP, 'lib', 'plugin-manager'));

const DSH_HOME = process.env.DSH_HOME;
const PROFILE = path.join(DSH_HOME, 'profiles', 'web');
const PLUGIN_NAME = 'dsh-copycat-chatgpt-bridge';
const PLUGIN_DIR = path.join(APP, 'plugins', PLUGIN_NAME);
const BRIDGE_DIR = path.join(DSH_HOME, 'copycat-bridge');
const DISCOVERY = path.join(BRIDGE_DIR, 'bridge.json');
const BACKUP = path.join(os.tmpdir(), 'copycat-bridge-profile-backup-' + Date.now());

const steps = [];
function step(name, ok, detail = '') {
  steps.push({ name, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? `\n        ${detail}` : ''));
}

const logLines = [];
const logger = (source, message) => logLines.push(`[${source}] ${message}`);

function filesUnder(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, base));
    else if (entry.isFile()) out.push({ full, relative: path.relative(base, full) });
  }
  return out;
}

function archivePlugin(target) {
  const zip = new AdmZip();
  for (const file of filesUnder(PLUGIN_DIR)) {
    zip.addFile(`${PLUGIN_NAME}/${file.relative.replaceAll('\\', '/')}`, fs.readFileSync(file.full));
  }
  zip.writeZip(target);
}

async function waitForFile(target, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(target)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function waitUntilGone(target, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(target)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !fs.existsSync(target);
}

async function main() {
  fs.cpSync(PROFILE, BACKUP, { recursive: true });
  fs.rmSync(BRIDGE_DIR, { recursive: true, force: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-copycat-e2e-'));
  const userData = path.join(scratch, 'ud');
  fs.mkdirSync(userData, { recursive: true });
  const archive = path.join(scratch, `${PLUGIN_NAME}.zip`);
  archivePlugin(archive);

  const runtime = new HarnessRuntime({ appRoot: APP, logger });
  const manager = new PluginManager({ userData, runtime, logger, getWorkspace: () => APP });

  try {
    const boot = await runtime.start(APP);
    step('1. engine online before bridge install', boot.ok);

    const candidate = await manager.receiveZip(archive);
    step('2. bridge archive passes receive/validate/build/stage', candidate.status === 'ready',
      `status=${candidate.status} ${candidate.name}@${candidate.version}`);

    const activated = await manager.activate(candidate.id);
    step('3. bridge activates through the real profile transaction', activated.ok === true);
    step('4. engine remains healthy with bridge mounted', await runtime.isHealthy());

    const discovered = await waitForFile(DISCOVERY);
    step('5. plugin publishes local discovery/pairing state', discovered, DISCOVERY);
    if (!discovered) throw new Error('Copycat bridge discovery file did not appear.');

    const discovery = JSON.parse(fs.readFileSync(DISCOVERY, 'utf8'));
    step('6. bridge binds to loopback with a pairing token',
      discovery.host === '127.0.0.1' && Number.isInteger(discovery.port) && discovery.port > 0 && Boolean(discovery.token),
      `${discovery.baseUrl}`);

    const auth = { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json' };
    const unauth = await fetch(`${discovery.baseUrl}/status`);
    step('7. unauthenticated callers are rejected', unauth.status === 401, `HTTP ${unauth.status}`);

    const statusResponse = await fetch(`${discovery.baseUrl}/status`, { headers: auth });
    const status = await statusResponse.json();
    step('8. authenticated status endpoint is live', statusResponse.ok && status.ok === true,
      `HTTP ${statusResponse.status}`);

    const sessionResponse = await fetch(`${discovery.baseUrl}/session`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ cwd: APP }),
    });
    const session = await sessionResponse.json();
    step('9. bridge creates a normal Harness Session through apiProxy',
      sessionResponse.status === 201 && session.ok === true && typeof session.session_id === 'string',
      `HTTP ${sessionResponse.status} session=${session.session_id || 'none'}`);

    const listResponse = await fetch(`${discovery.baseUrl}/sessions`, { headers: auth });
    const list = await listResponse.json();
    const items = list?.value?.items || list?.value?.sessions || [];
    step('10. created Session is visible through Harness Session list',
      listResponse.ok && Array.isArray(items) && items.some(item => item.sessionId === session.session_id),
      `items=${items.length}`);

    const rolled = await manager.rollbackPrevious();
    step('11. rollback cleanly removes the bridge plugin', rolled.ok === true);
    step('12. engine remains healthy after bridge rollback', await runtime.isHealthy());
    const discoveryGone = await waitUntilGone(DISCOVERY);
    step('13. plugin teardown withdraws the live discovery file', discoveryGone);
  } catch (error) {
    console.log(`\nABORTED: ${error.message}`);
    console.log(String(error.stack || '').split('\n').slice(0, 5).join('\n'));
    steps.push({ name: 'run aborted', ok: false });
  } finally {
    await runtime.stop();
    fs.rmSync(PROFILE, { recursive: true, force: true });
    fs.cpSync(BACKUP, PROFILE, { recursive: true });
    fs.rmSync(BACKUP, { recursive: true, force: true });
    fs.rmSync(BRIDGE_DIR, { recursive: true, force: true });
    const logPath = path.join(scratch, 'engine.log');
    fs.writeFileSync(logPath, logLines.join('\n'));
    console.log(`\nprofile restored. log: ${logPath}`);
    const failed = steps.filter(item => !item.ok);
    console.log('\n===== COPYCAT BRIDGE SUMMARY =====');
    console.log(`${steps.length - failed.length}/${steps.length} passed`);
    process.exit(failed.length ? 1 : 0);
  }
}

main();
