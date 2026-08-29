// Launch the live app and confirm the new pages resolve real data end to end.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP = require('node:path').resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const USERDATA = path.join(APP, '.e2e', 'live-user-data');
const HOME = path.join(APP, '.e2e', 'source-dsh-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The renderer reports what each page resolved, via the existing log channel.
const PROBE = `
(async () => {
  const out = [];
  try {
    const a = await window.desktop.listArtifacts();
    out.push('artifacts=' + (a.items || []).length + ' groups=' + [...new Set((a.items||[]).map(i=>i.group))].join('|'));
  } catch (e) { out.push('artifacts FAILED ' + e.message); }
  try {
    const s = await window.desktop.listSkills();
    out.push('skills=' + (s.items || []).length + ' names=' + (s.items||[]).map(i=>i.name).join(','));
  } catch (e) { out.push('skills FAILED ' + e.message); }
  try {
    const f = await window.desktop.listWorkspaceFiles();
    out.push('workspaceFiles=' + (f.items || []).length);
  } catch (e) { out.push('workspaceFiles FAILED ' + e.message); }
  try {
    const files = await window.desktop.listWorkspaceFiles();
    const target = files.items[0].path;
    const before = await window.desktop.readWorkspaceFile(target);
    await window.desktop.saveWorkspaceFile(target, before.text);
    out.push('readWrite ok bytes=' + before.bytes);
  } catch (e) { out.push('readWrite FAILED ' + e.message); }
  try {
    const w = await window.desktop.listWorkspaces();
    out.push('workspaces=' + (w.items || []).length);
  } catch (e) { out.push('workspaces FAILED ' + e.message); }
  try {
    const skills = await window.desktop.listSkills();
    const f = await window.desktop.readFile(skills.items[0].manifest);
    out.push('readFile ok bytes=' + f.bytes);
  } catch (e) { out.push('readFile FAILED ' + e.message); }
  window.desktop.reportLog('probe', out.join(' ;; '));
})();
`;

function readLog() {
  try {
    return fs.readFileSync(path.join(USERDATA, 'harness-desktop.log'), 'utf8').trim().split(/\r?\n/)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

(async () => {
  // Inject the probe by appending it to a temp copy of the renderer entry.
  const rendererPath = path.join(APP, 'src', 'renderer.js');
  const original = fs.readFileSync(rendererPath, 'utf8');
  fs.writeFileSync(rendererPath, original + '\n/* live-probe */\nsetTimeout(() => {' + PROBE + '}, 14000);\n');

  const before = readLog().length;
  const child = spawn(ELECTRON, ['.'], {
    cwd: APP,
    env: { ...process.env, DSH_HOME: HOME, HARNESS_DESKTOP_USER_DATA: USERDATA },
    windowsHide: true, stdio: 'ignore',
  });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const deadline = Date.now() + 90000;
  let probe = null;
  while (Date.now() < deadline && !exited) {
    await sleep(1000);
    probe = readLog().slice(before).find((l) => l.source === 'probe');
    if (probe) break;
  }
  await sleep(500);

  const log = readLog().slice(before);
  const faults = log.filter((l) => l.source === 'renderer');

  console.log('--- app log ---');
  for (const l of log) console.log(`  [${l.source}] ${String(l.message).slice(0, 200)}`);
  console.log('\nrenderer faults:', faults.length);

  if (!exited) {
    await new Promise((resolve) => {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      k.on('close', resolve); k.on('error', resolve);
    });
  }
  fs.writeFileSync(rendererPath, original);
  console.log('renderer restored.');

  const ok = Boolean(probe) && faults.length === 0 && !/FAILED/.test(probe?.message || '');
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  live pages resolved real data`);
  process.exit(ok ? 0 : 1);
})();
