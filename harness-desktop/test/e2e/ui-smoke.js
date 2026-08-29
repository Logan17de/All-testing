// Launch the real app and confirm the rebuilt renderer runs without faults.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP = require('node:path').resolve(__dirname, '..', '..');
const PACKAGED = process.env.HARNESS_DESKTOP_EXE;
const ELECTRON = PACKAGED || path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readLog(ud) {
  try {
    return fs.readFileSync(path.join(ud, 'harness-desktop.log'), 'utf8').trim().split(/\r?\n/)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-ui-'));
  const ud = path.join(scratch, 'ud');
  fs.mkdirSync(ud, { recursive: true });

  const child = spawn(ELECTRON, PACKAGED ? ['--no-sandbox'] : ['--no-sandbox', '.'], {
    cwd: PACKAGED ? path.dirname(PACKAGED) : APP,
    env: Object.assign({}, process.env, { HARNESS_DESKTOP_USER_DATA: ud, DSH_HOME: process.env.DSH_HOME }),
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let processOutput = '';
  child.stdout.on('data', (chunk) => { processOutput += chunk; });
  child.stderr.on('data', (chunk) => { processOutput += chunk; });
  let exited = false;
  child.on('exit', () => { exited = true; });

  // The app is intentionally idle until the first chat input. Wait for the
  // desktop shell, not the removed engine auto-start lifecycle.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (readLog(ud).some((l) => /Harness Desktop started/.test(l.message))) break;
    if (exited) break;
  }
  await sleep(3000);

  const log = readLog(ud);
  const rendererLines = log.filter((l) => l.source === 'renderer');
  const fatalLines = log.filter((l) => /Fatal startup error/.test(l.message));
  const sources = [...new Set(log.map((l) => l.source))];

  console.log('app still running :', !exited);
  console.log('log sources       :', sources.join(', '));
  console.log('renderer faults   :', rendererLines.length);
  for (const l of rendererLines) console.log('   ! ' + l.message);
  if (processOutput.trim()) console.log('process output     :', processOutput.trim().slice(-2000));
  console.log('\n--- log ---');
  for (const l of log) console.log(`  [${l.source}] ${String(l.message).slice(0, 150)}`);

  if (!exited) {
    await new Promise((resolve) => {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      k.on('close', resolve); k.on('error', resolve);
    });
  }
  const ok = !exited && rendererLines.length === 0 && fatalLines.length === 0;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  renderer ran clean in Electron`);
  process.exit(ok ? 0 : 1);
})();
